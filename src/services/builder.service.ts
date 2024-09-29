import { Context, Service, ServiceBroker } from "moleculer";
import { RedisConnectionManager } from "../redis-connection-manager";
import { Mutex, tryAcquire } from "async-mutex";
import { BuildsRedisLogger, SshLogger } from "../logging";
import { currentTime } from "../utils";
import fs from "fs";
import path from "path";
import {
    Builder_Action_BuildPackage_Params,
    BuildStatus,
    BuildStatusReturn,
    Database_Action_AddToDb_Params,
    Database_Action_GenerateDestFillerFiles_Params,
    SOURCECACHE_MAX_LIFETIME,
} from "../types";
import { ContainerManager, DockerManager, PodmanManager } from "../container-manager";
import { to } from "await-to-js";
import Client, { ScpClient } from "node-scp";
import { Dirent } from "node:fs";

/**
 * The BuilderService class is a moleculer service that provides the buildPackage and cancelBuild actions.
 */
export class BuilderService extends Service {
    mutex: Mutex = new Mutex();
    redis_connection_manager: RedisConnectionManager;

    builder = {
        ci_code_skip: Number(process.env.CI_CODE_SKIP) || 123,
        name: process.env.BUILDER_HOSTNAME || "chaotic-builder",
        timeout: Number(process.env.BUILDER_TIMEOUT) || 3600,
        container_engine: process.env.BUILDER_PODMAN ? "podman" : "docker",
    };

    shared_srcdest_cache: string = path.join(process.env.SHARED_PATH || "", "srcdest_cache");
    shared_pkgout: string = path.join(process.env.SHARED_PATH || "", "pkgout");
    shared_sources: string = path.join(process.env.SHARED_PATH || "", "sources");
    mountPkgout = "/shared/pkgout";
    mountSrcdest = "/shared/srcdest_cache";

    containerManager: ContainerManager;

    constructor(broker: ServiceBroker, redis_connection_manager: RedisConnectionManager) {
        super(broker);
        this.redis_connection_manager = redis_connection_manager;

        this.parseServiceSchema({
            name: "builder",
            version: 1,

            settings: {
                $noVersionPrefix: true,
            },
            actions: {
                buildPackage: this.buildPackage,
                cancelBuild: this.cancelBuild,
            },
        });

        if (this.builder.container_engine === "podman") {
            this.containerManager = new PodmanManager(this.logger);
        } else {
            this.containerManager = new DockerManager(this.logger);
        }
    }

    /**
     * Builds a package using the given parameters. After having finished the build, this method calls the database action
     * to add the package to the database. The exit code if this action will be returned to the coordinator service.
     * @param ctx The Moleculer context object
     * @returns The exit code of the build action as a BuildStatusReturn object
     */
    async buildPackage(ctx: Context): Promise<BuildStatusReturn> {
        let data = ctx.params as Builder_Action_BuildPackage_Params;

        // If this fails, something has gone terribly wrong.
        // The coordinator should never send two jobs to the same builder
        return tryAcquire(this.mutex).runExclusive(async (): Promise<BuildStatusReturn> => {
            const logger = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.logger);
            void logger.from(data.pkgbase, data.timestamp);
            void logger.setDefault();

            logger.log(`Processing build job ${ctx.id} at ${currentTime()}`);

            // Make sure the pkgout directory is clean for the current build
            this.ensurePathClean(this.mountPkgout);

            // Generate filler files in the pkgout directory.
            // Goal: Avoid building packages that are already in the target repo
            await this.generateDestFillerFiles(ctx, data.target_repo, data.arch, this.mountPkgout);

            // Clean the source cache of any old source files
            this.clearSourceCache(this.mountSrcdest, data.target_repo);

            // Generate the folder path for the specific package source cache
            const srcdest_package_path = path.join(this.shared_srcdest_cache, data.target_repo, data.pkgbase);

            // Append the container object to the job context
            data.container = await this.containerManager.create(
                data.builder_image,
                ["build", data.pkgbase],
                [
                    srcdest_package_path + ":/home/builder/srcdest_cached",
                    this.shared_pkgout + ":/home/builder/pkgout",
                    this.shared_sources + ":/pkgbuilds",
                ],
                [
                    "BUILDER_HOSTNAME=" + this.builder.name,
                    "BUILDER_TIMEOUT=" + this.builder.timeout,
                    "CI_CODE_SKIP=" + this.builder.ci_code_skip,
                    "EXTRA_PACMAN_REPOS=" + data.extra_repos,
                    "EXTRA_PACMAN_KEYRINGS=" + data.extra_keyrings,
                    "PACKAGE_REPO_ID=" + data.source_repo,
                    "PACKAGE_REPO_URL=" + data.source_repo_url,
                ],
            );

            const [err, out] = await to(this.containerManager.start(data.container, logger.raw_log.bind(logger)));

            // Remove any filler files from the equation
            const file_list = fs.readdirSync(this.mountPkgout).filter((file): boolean => {
                const stats = fs.statSync(path.join(this.mountPkgout, file));
                return stats.isFile() && stats.size > 0;
            });

            if (err || out.StatusCode !== 0 || file_list.length === 0) {
                if (!err && out.StatusCode === 13) {
                    return { success: BuildStatus.ALREADY_BUILT };
                } else if (out.StatusCode === this.builder.ci_code_skip) {
                    return { success: BuildStatus.SKIPPED };
                } else if (out.StatusCode === 124) {
                    return { success: BuildStatus.TIMED_OUT };
                } else {
                    return { success: BuildStatus.FAILED };
                }
            } else logger.log(`Finished build ${ctx.id}. Uploading...`);

            const sshlogger = new SshLogger();
            try {
                const client: ScpClient = await Client({
                    host: String(data.upload_info.database.ssh.host),
                    port: Number(data.upload_info.database.ssh.port),
                    username: String(data.upload_info.database.ssh.user),
                    privateKey: fs.readFileSync("sshkey"),
                    debug: sshlogger.log.bind(sshlogger),
                });
                await client.uploadDir(this.mountPkgout, data.upload_info.database.landing_zone);
                client.close();
            } catch (e) {
                logger.error(`Failed to upload ${ctx.id}: ${e}`);

                // This does not get logged to redis
                this.logger.error(sshlogger.dump());
                this.logger.info("End of SSH log.");

                return { success: BuildStatus.FAILED };
            }

            this.ensurePathClean(this.mountPkgout, false);
            logger.log(`Finished upload ${ctx.id}.`);

            let addToDbParams: Database_Action_AddToDb_Params = {
                source_repo: data.source_repo,
                target_repo: data.target_repo,
                arch: data.arch,
                pkgbase: data.pkgbase,
                pkgfiles: file_list,
                builder_image: data.builder_image,
                timestamp: data.timestamp,
            };
            let addToDbReturn: { success: boolean } = await ctx.call("database.addToDb", addToDbParams);

            if (!addToDbReturn.success) {
                return { success: BuildStatus.FAILED };
            } else {
                return {
                    success: BuildStatus.SUCCESS,
                    packages: file_list,
                };
            }
        });
    }

    /**
     * Cancels a build by killing the container associated with the build job. The idea is that created container
     * object is appended to the job context by the buildPackage method, so this method can kill it.
     * @param ctx The moleculer context, containing the Container object to kill
     */
    async cancelBuild(ctx: Context): Promise<void> {
        let data = ctx.params as Builder_Action_BuildPackage_Params;

        if (!data.container) {
            return;
        }

        await this.containerManager.kill(data.container!).catch((e) => {
            this.logger.error(e);
        });
        throw new Error("Job cancelled.");
    }

    /**
     * Ensures no files are left behind in the given directory
     * @param dir The directory to clean
     * @param create Whether to re-create the directory after cleaning
     * @private
     */
    private ensurePathClean(dir: string, create = true): void {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
        if (create) fs.mkdirSync(dir, { recursive: true });
    }

    /**
     * Request a list of files from the database server and fill the destination directory with empty files
     * Goal: stopping Pacman from building packages it has already built
     * @param ctx The moleculer context
     * @param target_repo The target repository
     * @param arch The package target architecture
     * @param destdir The destination directory to write the files to
     * @private
     */
    private async generateDestFillerFiles(
        ctx: Context,
        target_repo: string,
        arch: string,
        destdir: string,
    ): Promise<void> {
        let generateDestFillerFilesParams: Database_Action_GenerateDestFillerFiles_Params = {
            target_repo: target_repo,
            arch: arch,
        };
        let repo_files: string[] = await ctx.call("database.generateDestFillerFiles", generateDestFillerFilesParams);
        for (const line of repo_files) {
            const filepath = path.join(destdir, line);
            fs.writeFileSync(filepath, "");
        }
    }

    /**
     * Ensure that the source cache is cleared after one month, also for no longer existing packages
     * @param mountSrcdest The path of the shared sources directory inside the container
     * @param target_repo The target repository, which is the name of the directory in the shared sources directory
     * @private
     */
    private clearSourceCache(mountSrcdest: string, target_repo: string): void {
        const now = new Date().getTime();
        const sourceCacheDir = path.join(mountSrcdest, target_repo);

        if (!fs.existsSync(sourceCacheDir)) return;

        const directory: Dirent[] = fs.readdirSync(sourceCacheDir, { withFileTypes: true });

        directory.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
        for (const dir of directory) {
            const filePath = path.join(sourceCacheDir, `${dir.name}`);
            if (fs.existsSync(`${filePath}/.timestamp`)) {
                const timestamp = fs.statSync(`${filePath}/.timestamp`);
                const mtime = new Date(timestamp.mtime).getTime();
                if (now - mtime <= SOURCECACHE_MAX_LIFETIME) continue;
            }
            fs.rmSync(filePath, { recursive: true, force: true });
        }
    }
}

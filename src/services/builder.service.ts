import { Context, Service, ServiceBroker } from "moleculer";
import { RedisConnectionManager } from "../redis-connection-manager";
import { Mutex, tryAcquire } from "async-mutex";
import { BuildsRedisLogger, SshLogger } from "../logging";
import { currentTime } from "../utils";
import type Docker from "dockerode";
import fs from "fs";
import path from "path";
import { Builder_Action_BuildPackage_Params, BuildStatusReturn, BuildStatus, Database_Action_GenerateDestFillerFiles_Params, SOURCECACHE_MAX_LIFETIME, Database_Action_AddToDb_Params } from "../types";
import { ContainerManager, DockerManager } from "../container-manager";
import { to } from "await-to-js";
import Client from "node-scp";

// TODO: FETCH builder_image from the coordinator?

function ensurePathClean(dir: string, create = true): void {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    if (create) fs.mkdirSync(dir, { recursive: true });
}

// Request a list of files from the database server and fill the destination directory with empty files
// Goal: stop pacman from building packages it has already built
async function generateDestFillerFiles(ctx: Context, target_repo: string, arch: string, destdir: string): Promise<void> {
    let generateDestFillerFilesParams: Database_Action_GenerateDestFillerFiles_Params = { target_repo: target_repo, arch: arch };
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
 */
function clearSourceCache(mountSrcdest: string, target_repo: string): void {
    const now = new Date().getTime();
    const sourceCacheDir = path.join(mountSrcdest, target_repo);

    if (!fs.existsSync(sourceCacheDir)) return;

    const directory = fs.readdirSync(sourceCacheDir, { withFileTypes: true });

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

export class BuilderService extends Service {
    mutex: Mutex = new Mutex();
    redis_connection_manager: RedisConnectionManager;

    builder = {
        ci_code_skip: Number(process.env.CI_CODE_SKIP) || 123,
        name: "chaotic-builder",
        timeout: Number(process.env.BUILDER_TIMEOUT) || 3600
    }

    shared_srcdest_cache: string = path.join(process.env.SHARED_PATH || "", "srcdest_cache");
    shared_pkgout: string = path.join(process.env.SHARED_PATH || "", "pkgout");
    shared_sources: string = path.join(process.env.SHARED_PATH || "", "sources");
    mountPkgout = "/shared/pkgout";
    mountSrcdest = "/shared/srcdest_cache";

    containerManager: ContainerManager = new DockerManager();

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
    }

    async buildPackage(ctx: Context): Promise<BuildStatusReturn> {
        let data = ctx.params as Builder_Action_BuildPackage_Params
        // If this fails something has gone terribly wrong
        // The coordinator should never send two jobs to the same builder
        return tryAcquire(this.mutex).runExclusive(async () => {
            const logger = new BuildsRedisLogger(this.redis_connection_manager.getClient());
            logger.from(data.pkgbase, data.timestamp);
            logger.setDefault();

            logger.log(`Processing build job ${ctx.id} at ${currentTime()}`);

            // Make sure the pkgout directory is clean for the current build

            ensurePathClean(this.mountPkgout);
            // Generate filler files in the pkgout directory.
            // Goal: Avoid building packages that are already in the target repo
            await generateDestFillerFiles(ctx, data.target_repo, data.arch, this.mountPkgout);

            // Clean the source cache of any old source files
            clearSourceCache(this.mountSrcdest, data.target_repo);

            // Generate the folder path for the specific package source cache
            const srcdest_package_path = path.join(this.shared_srcdest_cache, data.target_repo, data.pkgbase);

            const container: Docker.Container = await this.containerManager.create(
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

            // if (cancelled) {
            //     await this.containerManager.kill(container).catch((e) => {
            //         console.error(e);
            //     });
            //     throw new Error("Job cancelled.");
            // }

            const [err, out] = await to(this.containerManager.start(container, logger.raw_log.bind(logger)));

            // Remove any filler files from the equation
            const file_list = fs.readdirSync(this.mountPkgout).filter((file) => {
                const stats = fs.statSync(path.join(this.mountPkgout, file));
                return stats.isFile() && stats.size > 0;
            });

            if (err || out.StatusCode !== 0 || file_list.length === 0) {
                if (!err && out.StatusCode === 13) {
                    logger.log(`Job ${ctx.id} skipped because all packages were already built.`);
                    return {
                        success: BuildStatus.ALREADY_BUILT,
                    };
                } else if (out.StatusCode === this.builder.ci_code_skip) {
                    logger.log(`Job ${ctx.id} skipped intentionally via build tools.`);
                    return {
                        success: BuildStatus.SKIPPED,
                    };
                } else if (out.StatusCode === 124) {
                    logger.log(`Job ${ctx.id} reached a timeout during the build phase.`);
                    return {
                        success: BuildStatus.TIMED_OUT,
                    };
                } else {
                    logger.log(`Job ${ctx.id} failed`);
                    return {
                        success: BuildStatus.FAILED,
                    }
                }
            } else logger.log(`Finished build ${ctx.id}. Uploading...`);

            const sshlogger = new SshLogger();
            try {
                const client = await Client({
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
                console.error(sshlogger.dump());
                console.log("End of SSH log.");
                return {
                    success: BuildStatus.FAILED,
                }
            }
            ensurePathClean(this.mountPkgout, false);
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
                return {
                    success: BuildStatus.FAILED,
                }
            };

            logger.log(`Build job ${ctx.id} finished at ${currentTime()}...`);

            return {
                success: BuildStatus.SUCCESS,
                packages: file_list
            }
        });
    }

    async cancelBuild(ctx: Context) {
        // TODO
    }
};
import fs from "fs";
import type { Dirent } from "node:fs";
import path from "path";
import { E_ALREADY_LOCKED, Mutex, tryAcquire } from "async-mutex";
import { to } from "await-to-js";
import type { Container } from "dockerode";
import { type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import Client, { type ScpClient } from "node-scp";
import { type ContainerManager, DockerManager, PodmanManager } from "../container-manager";
import { BuildsRedisLogger, SshLogger } from "../logging";
import type { RedisConnectionManager } from "../redis-connection-manager";
import {
    type Builder_Action_BuildPackage_Params,
    BuildStatus,
    type BuildStatusReturn,
    type Database_Action_AddToDb_Params,
    type Database_Action_GenerateDestFillerFiles_Params,
    type MetricsHistogramContext,
    SOURCECACHE_MAX_LIFETIME,
} from "../types";
import { currentTime, getDurationInMilliseconds, isNumeric } from "../utils";
import { MoleculerConfigCommonService } from "./moleculer.config";

/**
 * The BuilderService class is a moleculer service that provides the buildPackage and cancelBuild actions.
 */
export class BuilderService extends Service {
    private mutex: Mutex = new Mutex();

    private builder = {
        ci_code_skip: Number(process.env.CI_CODE_SKIP) || 123,
        name: process.env.BUILDER_HOSTNAME || "chaotic-builder",
        timeout: Number(process.env.BUILDER_TIMEOUT) || 3600,
        container_engine: process.env.CONTAINER_ENGINE ? "podman" : "docker",
        cpu_limit:
            process.env.BUILDER_LIMITS_CPUS && isNumeric(process.env.BUILDER_LIMITS_CPUS)
                ? Number(process.env.BUILDER_LIMITS_CPUS)
                : null,
    };

    private shared_srcdest_cache: string;
    private shared_pkgout: string;
    private shared_sources: string;
    private mountPkgout = "/shared/pkgout";
    private mountSrcdest = "/shared/srcdest_cache";

    private containerManager: ContainerManager;
    private container: Container | null = null;
    private cancelled = false;
    private chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");

    private scpClient: ScpClient | null = null;

    private cancelledCode: BuildStatus.CANCELED | BuildStatus.CANCELED_REQUEUE = BuildStatus.CANCELED;
    private active = true;

    constructor(
        broker: ServiceBroker,
        private redis_connection_manager: RedisConnectionManager,
        SHARED_PATH: string,
    ) {
        super(broker);
        this.shared_srcdest_cache =
            process.env.BUILDER_SRCDEST_CACHE_OVERRIDE || path.join(SHARED_PATH, "srcdest_cache");
        this.shared_pkgout = path.join(SHARED_PATH, "pkgout");
        this.shared_sources = path.join(SHARED_PATH, "sources");

        this.parseServiceSchema({
            name: "builder",
            actions: {
                buildPackage: this.buildPackage,
                cancelBuild: this.cancelBuild,
            },
            ...MoleculerConfigCommonService,
        });

        if (this.builder.container_engine === "podman") {
            this.containerManager = new PodmanManager(this.chaoticLogger);
        } else {
            this.containerManager = new DockerManager(this.chaoticLogger);
        }
    }

    /**
     * Builds a package using the given parameters. After having finished the build, this method calls the database action
     * to add the package to the database. The exit code if this action will be returned to the coordinator service.
     * @param ctx The Moleculer context object
     * @returns The exit code of the build action as a BuildStatusReturn object
     */
    async buildPackage(ctx: Context): Promise<BuildStatusReturn> {
        const data = ctx.params as Builder_Action_BuildPackage_Params;
        this.cancelled = false;

        // If this fails, something has gone terribly wrong.
        // The coordinator should never send two jobs to the same builder
        return await tryAcquire(this.mutex)
            .runExclusive(async (): Promise<BuildStatusReturn> => {
                if (!this.active) {
                    return {
                        success: BuildStatus.CANCELED_REQUEUE,
                    };
                }

                const timeStart: [number, number] = process.hrtime();
                const logger = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.broker, "BUILD");
                logger.from(data.pkgbase, data.timestamp);

                logger.log(`Processing build job at ${currentTime()}`);
                this.chaoticLogger.info(`Processing build job for ${data.pkgbase}`);

                // Make sure the pkgout directory is clean for the current build
                this.ensurePathClean(this.mountPkgout);

                // Generate filler files in the pkgout directory.
                // Goal: Avoid building packages that are already in the target repo
                await this.generateDestFillerFiles(ctx, data.target_repo, data.arch, this.mountPkgout);

                // Clean the source cache of any old source files
                this.clearSourceCache(this.mountSrcdest, data.target_repo);

                // Generate the folder path for the specific package source cache
                const srcdest_package_path = path.join(this.shared_srcdest_cache, data.target_repo, data.pkgbase);

                // Make sure the builder image is always up to date
                await this.containerManager.scheduledPull(data.builder_image);

                // Append the container object to the job context
                this.container = await this.containerManager.create(
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
                        ...(this.builder.cpu_limit ? [`MAKEFLAGS=-j${this.builder.cpu_limit}`] : []),
                    ],
                    {
                        CpuPeriod: this.builder.cpu_limit ? 100000 : undefined,
                        CpuQuota: this.builder.cpu_limit ? 100000 * this.builder.cpu_limit : undefined,
                        Memory:
                            process.env.BUILDER_LIMITS_RAM && isNumeric(process.env.BUILDER_LIMITS_RAM)
                                ? Number(process.env.BUILDER_LIMITS_RAM) * 1024 * 1024
                                : undefined,
                    },
                );

                if (this.cancelled) {
                    await this.containerManager.kill(this.container).catch((e) => {
                        this.chaoticLogger.error(e);
                    });
                    return {
                        success: this.cancelledCode,
                    };
                }

                const [err, out] = await to(this.containerManager.start(this.container, logger.raw_log.bind(logger)));

                if (this.cancelled) {
                    // At this point, the container has already stopped; there is no need to kill it
                    return {
                        success: this.cancelledCode,
                    };
                }

                if (err || !out || out.StatusCode !== 0) {
                    if (err) {
                        logger.log("Unknown container failure during build.");
                        this.chaoticLogger.error("Unknown container failure during build:", err);
                    } else if (!out) {
                        logger.log("Unknown container failure during build.");
                        this.chaoticLogger.error("Unknown container failure during build. No output.");
                    } else if (out.StatusCode === 13) {
                        return { success: BuildStatus.ALREADY_BUILT };
                    } else if (out.StatusCode === this.builder.ci_code_skip) {
                        return { success: BuildStatus.SKIPPED };
                    } else if (out.StatusCode === 124) {
                        return { success: BuildStatus.TIMED_OUT };
                    } else {
                        return { success: BuildStatus.FAILED };
                    }
                } else {
                    logger.log(`Finished build. Uploading...`);
                    this.chaoticLogger.info(`Finished build for ${data.pkgbase}`);
                }

                // Remove any filler files from the equation
                const file_list = fs.readdirSync(this.mountPkgout).filter((file): boolean => {
                    const stats = fs.statSync(path.join(this.mountPkgout, file));
                    return stats.isFile() && stats.size > 0;
                });

                if (file_list.length === 0) {
                    logger.log(`No files were found in the build output directory.`);
                    return { success: BuildStatus.FAILED };
                }

                const sshlogger = new SshLogger();
                try {
                    // Prefer override values from the environment
                    this.scpClient = await Client({
                        host: String(process.env.DATABASE_HOST || data.upload_info.database.ssh.host),
                        port: Number(process.env.DATABASE_PORT || data.upload_info.database.ssh.port),
                        username: String(process.env.DATABASE_USER || data.upload_info.database.ssh.user),
                        privateKey: fs.readFileSync("sshkey"),
                        debug: sshlogger.log.bind(sshlogger),
                    });
                    if (this.cancelled) {
                        return {
                            success: this.cancelledCode,
                        };
                    }
                    await this.scpClient.uploadDir(this.mountPkgout, data.upload_info.database.landing_zone);
                    this.scpClient.close();
                } catch (e) {
                    if (this.cancelled) {
                        return {
                            success: this.cancelledCode,
                        };
                    }

                    logger.error(`Failed to upload: ${e}`);

                    // This does not get logged to redis
                    this.chaoticLogger.error(sshlogger.dump());
                    this.chaoticLogger.info("End of SSH log.");

                    return { success: BuildStatus.FAILED };
                } finally {
                    if (this.scpClient) this.scpClient = null;
                }

                logger.log(`Finished upload.`);
                this.chaoticLogger.info(`Finished upload of ${data.pkgbase}`);

                if (this.cancelled) {
                    return {
                        success: this.cancelledCode,
                    };
                }

                const addToDbParams: Database_Action_AddToDb_Params = {
                    source_repo: data.source_repo,
                    target_repo: data.target_repo,
                    arch: data.arch,
                    pkgbase: data.pkgbase,
                    pkgfiles: file_list,
                    builder_image: data.builder_image,
                    timestamp: data.timestamp,
                };
                const addToDbReturn: { success: boolean } = await ctx.call("database.addToDb", addToDbParams);

                if (!addToDbReturn.success) {
                    return { success: BuildStatus.FAILED };
                } else {
                    ctx.call<void, MetricsHistogramContext>("chaoticMetrics.addToBuildTimerHistogram", {
                        labels: {
                            arch: data.arch,
                            pkgbase: data.pkgbase,
                            target_repo: data.target_repo,
                        },
                        duration: this.stopTimer(timeStart),
                    }).catch((e) => {
                        this.chaoticLogger.error("Error while adding to histogram: ", e);
                    });
                    return {
                        success: BuildStatus.SUCCESS,
                        packages: file_list,
                    };
                }
            })
            .catch(async (e) => {
                if (e === E_ALREADY_LOCKED) {
                    // Something has gone wrong on the coordinator side. Cancel the currently running build and requeue the new job the coordinator gave us.
                    // Delay the requeue by as long as it takes us to cancel the current build to guarantee the next job is processed without trouble.
                    await this.cancelBuild();
                    return { success: BuildStatus.CANCELED_REQUEUE };
                }
                this.chaoticLogger.error("Error in buildPackage: ", e);
                throw e;
            })
            .finally(() => {
                this.container = null;
            });
    }

    /**
     * Cancels a build by killing the container associated with the current builder.
     */
    async cancelBuild(): Promise<void> {
        if (!this.cancelled) {
            this.cancelled = true;
            if (!this.mutex.isLocked()) return;
            if (this.container) {
                this.containerManager.kill(this.container).catch((e) => {
                    this.chaoticLogger.error(e);
                });
            } else if (this.scpClient) {
                try {
                    this.scpClient.close();
                } catch (error) {
                    this.chaoticLogger.error(error);
                }
            }
        }
        await this.mutex.waitForUnlock();
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
        const generateDestFillerFilesParams: Database_Action_GenerateDestFillerFiles_Params = {
            target_repo: target_repo,
            arch: arch,
        };
        await this.broker.waitForServices(["database"], 1000);
        const repo_files: string[] = await ctx.call("database.generateDestFillerFiles", generateDestFillerFilesParams);
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

    async stop(): Promise<void> {
        this.active = false;
        if (!this.cancelled) this.cancelledCode = BuildStatus.CANCELED_REQUEUE;
        await this.cancelBuild();
        this.containerManager.destroy();
    }

    async stopped(): Promise<void> {
        await this.schema.stop.bind(this.schema)();
    }

    /**
     * Returns the duration it took to build a package in minutes.
     * @param startTimer The timer object created by process.hrtime when starting the timer
     * @returns The build duration in minutes
     */
    private stopTimer(startTimer: [number, number]): number {
        return getDurationInMilliseconds(startTimer) / 1000 / 60;
    }
}

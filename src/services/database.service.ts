import fs from "fs";
import { Mutex } from "async-mutex";
import { type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import { type ContainerManager, DockerManager, PodmanManager } from "../container-manager";
import { BuildsRedisLogger } from "../logging";
import type { RedisConnectionManager } from "../redis-connection-manager";
import type {
    Database_Action_AddToDb_Params,
    Database_Action_AutoRepoRemove_Params,
    Database_Action_fetchUploadInfo_Response,
    Database_Action_GenerateDestFillerFiles_Params,
    DatabaseRemoveStatusReturn,
    MetricsDatabaseLabels,
} from "../types";
import { currentTime } from "../utils";
import { MoleculerConfigCommonService } from "./moleculer.config";

export class DatabaseService extends Service {
    private landing_zone: string = process.env.LANDING_ZONE_PATH || "";
    private repo_root: string = process.env.REPO_PATH || "";
    private repo_root_mount = "/repo_root";
    private mutex: Mutex = new Mutex();
    private redis_connection_manager: RedisConnectionManager;
    private gpg: string = process.env.GPG_PATH || "";
    private container_manager: ContainerManager;
    private chaoticLogger: LoggerInstance = this.broker.getLogger("DATABASE");
    private active = true;

    constructor(broker: ServiceBroker, redis_connection_manager: RedisConnectionManager) {
        super(broker);
        this.redis_connection_manager = redis_connection_manager;

        this.parseServiceSchema({
            name: "database",
            actions: {
                fetchUploadInfo: {
                    cache: true,
                    handler: this.fetchUploadInfo,
                },
                addToDb: this.addToDb,
                autoRepoRemove: this.autoRepoRemove,
                generateDestFillerFiles: this.generateDestFillerFiles,
            },
            ...MoleculerConfigCommonService,
        });

        if (process.env.CONTAINER_ENGINE === "podman") {
            this.container_manager = new PodmanManager(this.chaoticLogger);
        } else {
            this.container_manager = new DockerManager(this.chaoticLogger);
        }
    }

    fetchUploadInfo(): Database_Action_fetchUploadInfo_Response {
        const database_host = process.env.DATABASE_HOST || "localhost";
        const database_port = Number(process.env.DATABASE_PORT || 22);
        const database_user = process.env.DATABASE_USER || "root";
        const landing_zone_adv = process.env.LANDING_ZONE_ADVERTISED_PATH || null;

        return {
            database: {
                ssh: {
                    host: database_host,
                    port: database_port,
                    user: database_user,
                },
                landing_zone: landing_zone_adv || this.landing_zone,
            },
        };
    }

    // Add multiple package files that belong to a pkgbase to the database
    async addToDb(ctx: Context): Promise<{ success: boolean }> {
        const data = ctx.params as Database_Action_AddToDb_Params;
        const metrics_promises: Promise<void>[] = [];

        return await this.mutex
            .runExclusive(async () => {
                if (!this.active) {
                    return {
                        success: false,
                    };
                }
                const logger = new BuildsRedisLogger(
                    this.redis_connection_manager.getClient(),
                    this.broker,
                    "DATABASE",
                );
                void logger.from(data.pkgbase, data.timestamp);

                logger.log(`Processing add to database job ${ctx.id} at ${currentTime()}`);
                this.chaoticLogger.info(`Processing add to db job for ${data.pkgbase}`);

                if (data.pkgfiles.length < 1) {
                    return {
                        success: false,
                    };
                }

                // Make sure the builder image is always up to date
                await this.container_manager.scheduledPull(data.builder_image);

                const [err, out] = await this.container_manager.run(
                    data.builder_image,
                    ["repo-add", data.arch, "/landing_zone", "/repo_root", data.target_repo].concat(data.pkgfiles),
                    [`${this.landing_zone}:/landing_zone`, `${this.repo_root}:/repo_root`, `${this.gpg}:/root/.gnupg`],
                    [],
                    logger.raw_log.bind(logger),
                );

                if (err) {
                    this.chaoticLogger.warn(err);
                    metrics_promises.push(
                        this.broker.call<void, MetricsDatabaseLabels>("chaoticMetrics.incCounterDatabaseFailure", {
                            arch: data.arch,
                            target_repo: data.target_repo,
                            pkgname: data.pkgbase,
                        }),
                    );
                    return {
                        success: false,
                    };
                }

                logger.log(`Successfully added packages to the database.`);
                this.chaoticLogger.info(`Successfully added new packages to the database.`);

                metrics_promises.push(
                    this.broker.call<void, MetricsDatabaseLabels>("chaoticMetrics.incCounterDatabaseSuccess", {
                        arch: data.arch,
                        target_repo: data.target_repo,
                        pkgname: data.pkgbase,
                    }),
                );

                return {
                    success: true,
                };
            })
            .catch((err) => {
                this.chaoticLogger.error("Error in addToDb:", err);
                return {
                    success: false,
                };
            })
            .finally(async () => {
                for (const promise of await Promise.allSettled(metrics_promises)) {
                    if (promise.status === "rejected") {
                        this.chaoticLogger.error("Failure during metrics: ", promise.reason);
                    }
                }
            });
    }

    // Remove all packages from the database that do not belong to the list of pkgbases
    async autoRepoRemove(ctx: Context): Promise<DatabaseRemoveStatusReturn> {
        const data = ctx.params as Database_Action_AutoRepoRemove_Params;

        return await this.mutex.runExclusive(async () => {
            if (!this.active) {
                return {
                    success: false,
                };
            }

            this.chaoticLogger.info(`Processing automatic package removal job for ${data.repo}`);

            if (data.pkgbases.length === 0) {
                this.chaoticLogger.error("Intended package list is empty. Assuming this is in error.");
                throw new Error("Intended package list is empty. Assuming this is in error.");
            }

            const [err, out] = await this.container_manager.run(
                data.builder_image,
                ["auto-repo-remove", data.arch, "/repo_root", data.repo].concat(data.pkgbases),
                [`${this.repo_root}:/repo_root`],
                [],
                process.stdout.write.bind(process.stdout),
            );

            if (err) {
                this.chaoticLogger.error(err);
                this.chaoticLogger.info("Failed to remove packages from the database.");
                return {
                    success: false,
                };
            }
            return {
                success: true,
            };
        });
    }

    async generateDestFillerFiles(ctx: Context): Promise<string[]> {
        const data = ctx.params as Database_Action_GenerateDestFillerFiles_Params;
        const directory = `${this.repo_root_mount}/${data.target_repo}/${data.arch}`;
        if (fs.existsSync(directory)) {
            return fs.readdirSync(directory);
        }
        return [];
    }

    async stop(): Promise<void> {
        this.active = false;
        await this.mutex.waitForUnlock();
        this.container_manager.destroy();
    }

    async stopped(): Promise<void> {
        await this.schema.stop.bind(this.schema)();
    }
}

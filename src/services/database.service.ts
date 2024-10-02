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
} from "../types";
import { currentTime } from "../utils";
import { MoleculerConfigCommonService } from "./moleculer.config";

export class DatabaseService extends Service {
    landing_zone: string = process.env.LANDING_ZONE_PATH || "";
    repo_root: string = process.env.REPO_PATH || "";
    repo_root_mount = "/repo_root";
    mutex: Mutex = new Mutex();
    redis_connection_manager: RedisConnectionManager;
    gpg: string = process.env.GPG_PATH || "";
    container_manager: ContainerManager;
    chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");

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
        return await this.mutex.runExclusive(async () => {
            // const repo = this.repo_manager.getRepo(data.repo);

            const logger = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.chaoticLogger);
            void logger.from(data.pkgbase, data.timestamp);

            logger.log(`Processing add to db job ${ctx.id} at ${currentTime()}`);
            this.chaoticLogger.info(`Processing add to db job for ${data.pkgbase}`);

            if (data.pkgfiles.length < 1) {
                return {
                    success: false,
                };
            }

            const [err, out] = await this.container_manager.run(
                data.builder_image,
                ["repo-add", data.arch, "/landing_zone", "/repo_root", data.target_repo].concat(data.pkgfiles),
                [`${this.landing_zone}:/landing_zone`, `${this.repo_root}:/repo_root`, `${this.gpg}:/root/.gnupg`],
                [],
                logger.raw_log.bind(logger),
            );

            if (err) {
                this.chaoticLogger.warn(err);
                return {
                    success: false,
                };
            }

            logger.log(`Successfully added packages to the database.`);
            this.chaoticLogger.info(`Successfully added packages to the database.`);

            return {
                success: true,
            };
        });
    }

    // Remove all packages from the database that do not belong to the list of pkgbases
    async autoRepoRemove(ctx: Context): Promise<DatabaseRemoveStatusReturn> {
        const data = ctx.params as Database_Action_AutoRepoRemove_Params;
        const ret: DatabaseRemoveStatusReturn = { success: false };

        await this.mutex.runExclusive(async () => {
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
                this.chaoticLogger.error("Failed to remove packages from the database.");
                ret.success = false;
            }
        });

        return ret;
    }

    async generateDestFillerFiles(ctx: Context): Promise<string[]> {
        const data = ctx.params as Database_Action_GenerateDestFillerFiles_Params;
        const directory = `${this.repo_root_mount}/${data.target_repo}/${data.arch}`;
        if (fs.existsSync(directory)) {
            return fs.readdirSync(directory);
        }
        return [];
    }
}

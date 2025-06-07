import fs from "fs";
import commandLineArgs, { CommandLineOptions } from "command-line-args";
import IORedis from "ioredis";
import { ServiceBroker } from "moleculer";
import { RedisConnectionManager } from "./redis-connection-manager";
import { scheduleAutoRepoRemove, schedulePackages } from "./scheduler";
import { BuilderService } from "./services/builder.service";
import CoordinatorService from "./services/coordinator.service";
import { DatabaseService } from "./services/database.service";
import { MetricsService } from "./services/metrics.service";
import { enableMetrics, MoleculerConfigCommon, MoleculerConfigLog } from "./services/moleculer.config";
import { NotifierService } from "./services/notifier.service";
import { WebService } from "./services/web.service";
import { generateNodeId, isNumeric } from "./utils";
import { current_version } from "./types";

if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

const mainDefinitions = [
    { name: "command", defaultOption: true },
    { name: "arch", type: String },
    { name: "target-repo", type: String },
    { name: "source-repo", type: String },
    { name: "web-port", type: Number },
    { name: "commit", type: String },
    { name: "deptree", type: String },
    { name: "arch-mirror", type: String },
];
const mainOptions: CommandLineOptions = commandLineArgs(mainDefinitions, {
    stopAtFirstUnknown: true,
});

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const redisPassword = process.env.REDIS_PASSWORD || "";

async function main(): Promise<void> {
    const connection = new IORedis(redisPort, redisHost, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        password: redisPassword,
    });
    const redis_connection_manager = new RedisConnectionManager(connection);

    // Assign random nodeIDs to prevent a nodeID conflict, which is a fatal error for Moleculer
    const nodeID = generateNodeId(mainOptions.command);

    const broker = new ServiceBroker({
        logger: MoleculerConfigLog(process.env.NODE_ENV!),
        metadata: {
            // Nodes can ONLY have number build_class values. The string version is exclusively for packages.
            build_class: process.env.BUILDER_CLASS
                ? isNumeric(process.env.BUILDER_CLASS)
                    ? Number(process.env.BUILDER_CLASS)
                    : null
                : 2,
            // This value is used to isolate builder nodes that are on a different version of the internal API than the coordinator.
            version: current_version,
        },
        metrics: enableMetrics(mainOptions.command === "database"),
        nodeID: nodeID,
        transporter: {
            type: "Redis",
            options: {
                host: connection.options.host,
                port: connection.options.port,
                password: connection.options.password,
            },
        },
        ...MoleculerConfigCommon,
    });

    const chaoticLogger = broker.getLogger("CHAOTIC");
    chaoticLogger.info(`Starting node ${nodeID}...`);
    chaoticLogger.info(broker.metadata);

    if (broker.metadata.build_class === null)
        chaoticLogger.warn(
            "BUILDER_CLASS is set to a non-numeric value. This builder will only build packages specificially assigned to it.",
        );

    switch (mainOptions.command) {
        case "schedule": {
            if (typeof mainOptions._unknown === "undefined" || mainOptions._unknown.length < 1) {
                broker.logger.fatal("No package names specified.");
                process.exit(1);
            }

            // This is a workaround for too many arguments causing the command line argument not to be executed in the
            // CI pipeline (mainly important for bigger repos).
            let deptree: string | undefined;
            const buildsDir: string | undefined = process.env.CI_BUILDS_DIR || process.env.GITHUB_WORKSPACE;
            if (buildsDir !== undefined && fs.existsSync(buildsDir + "/.ci/deptree.txt")) {
                deptree = fs.readFileSync(buildsDir + "/.ci/deptree.txt", {
                    encoding: "utf8",
                    flag: "r",
                });
            } else {
                deptree = undefined;
            }

            await broker.start();
            await schedulePackages(
                broker,
                mainOptions.arch || "x86_64",
                mainOptions["target-repo"] || "chaotic-aur",
                mainOptions["source-repo"] || "chaotic-aur",
                mainOptions._unknown,
                mainOptions.commit,
                deptree ? deptree : mainOptions.deptree,
                mainOptions["arch-mirror"] || undefined,
            );
            await broker.stop();
            redis_connection_manager.shutdown();
            return;
        }
        case "auto-repo-remove": {
            if (typeof mainOptions._unknown === "undefined" || mainOptions._unknown.length < 1) {
                broker.logger.fatal("No pkgbases specified.");
                process.exit(1);
            }
            await broker.start();
            await scheduleAutoRepoRemove(
                broker,
                mainOptions.arch || "x86_64",
                mainOptions["target-repo"] || "chaotic-aur",
                mainOptions._unknown,
            );
            await broker.stop();
            connection.quit();
            break;
        }
        case "builder": {
            if (!process.env.SHARED_PATH || !process.env.BUILDER_HOSTNAME) {
                broker.logger.fatal("Config variables incomplete.");
                return process.exit(1);
            }

            chaoticLogger.info("Starting builder instance...");

            broker.createService(new BuilderService(broker, redis_connection_manager, process.env.SHARED_PATH));
            await broker.start();
            break;
        }
        case "database": {
            if (
                !process.env.LANDING_ZONE_PATH ||
                !process.env.REPO_PATH ||
                !process.env.GPG_PATH ||
                !process.env.DATABASE_HOST ||
                !process.env.DATABASE_PORT ||
                !process.env.DATABASE_USER
            ) {
                broker.logger.fatal("Config variables incomplete.");
                return process.exit(1);
            }
            chaoticLogger.info("Starting database instance...");

            broker.options.nodeID = "database";

            broker.createService(new DatabaseService(broker, redis_connection_manager));
            broker.createService(new CoordinatorService(broker, redis_connection_manager));
            broker.createService(new NotifierService(broker));
            broker.createService(new WebService(broker, Number(mainOptions["web-port"]), redis_connection_manager));
            broker.createService(new MetricsService(broker));

            await broker.start();
            break;
        }
        case "web": {
            broker.createService(new WebService(broker, Number(mainOptions["web-port"]), redis_connection_manager));

            await broker.start();
            break;
        }
        default:
            broker.logger.fatal("Invalid command!");
            return process.exit(1);
    }
    process.on("SIGTERM", async () => {
        await broker.stop();
        redis_connection_manager.shutdown();
    });
}

void main();

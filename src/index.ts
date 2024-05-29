if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

import commandLineArgs from "command-line-args";
import IORedis from "ioredis";
import createBuilder from "./builder";
import createDatabaseWorker from "./database";
import { RedisConnectionManager } from "./redis-connection-manager";
import { Worker } from "bullmq";
import { scheduleAutoRepoRemove, schedulePackages } from "./scheduler";
import { startWebServer } from "./web";

const mainDefinitions = [
    { name: "command", defaultOption: true },
    { name: "arch", type: String },
    { name: "target-repo", type: String },
    { name: "source-repo", type: String },
    { name: "web-port", type: Number },
    { name: "commit", type: String },
    { name: "deptree", type: String },
];
const mainOptions = commandLineArgs(mainDefinitions, {
    stopAtFirstUnknown: true,
});

const redisHost = process.env.REDIS_HOST || "localhost";
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const redisPassword = process.env.REDIS_PASSWORD || "";

const workers: Worker[] = [];

async function main(): Promise<void> {
    const connection = new IORedis(redisPort, redisHost, {
        password: redisPassword,
        maxRetriesPerRequest: null,
        lazyConnect: true,
    });

    switch (mainOptions.command) {
        case "schedule":
            if (typeof mainOptions._unknown === "undefined" || mainOptions._unknown.length < 1) {
                console.error("No package names specified");
                process.exit(1);
            }
            await connection.connect();
            await schedulePackages(
                connection,
                mainOptions.arch || "x86_64",
                mainOptions["target-repo"] || "chaotic-aur",
                mainOptions["source-repo"] || "chaotic-aur",
                mainOptions._unknown,
                mainOptions.commit,
                mainOptions.deptree,
            );
            connection.quit();
            return;
        case "auto-repo-remove":
            if (typeof mainOptions._unknown === "undefined" || mainOptions._unknown.length < 1) {
                console.error("No pkgbases specified");
                process.exit(1);
            }
            await connection.connect();
            await scheduleAutoRepoRemove(
                connection,
                mainOptions.arch || "x86_64",
                mainOptions["target-repo"] || "chaotic-aur",
                mainOptions._unknown,
            );
            connection.quit();
            return;
        case "builder": {
            if (!process.env.SHARED_PATH) {
                console.error("Config variables incomplete");
                return process.exit(1);
            }
            await connection.connect();
            const redis_connection_manager = new RedisConnectionManager(connection);
            workers.push(createBuilder(redis_connection_manager));
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
                console.error("Config variables incomplete");
                return process.exit(1);
            }
            await connection.connect();
            const redis_connection_manager = new RedisConnectionManager(connection);
            if (typeof mainOptions["web-port"] !== "undefined") {
                void startWebServer(Number(mainOptions["web-port"]), redis_connection_manager);
            }
            createDatabaseWorker(redis_connection_manager);
            break;
        }
        case "web": {
            await connection.connect();
            const redis_connection_manager = new RedisConnectionManager(connection);
            void startWebServer(Number(mainOptions["web-port"]) || 8080, redis_connection_manager);
            break;
        }
        default:
            console.error("Invalid command");
            return process.exit(1);
    }
}

void main();

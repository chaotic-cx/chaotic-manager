import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import createBuilder from './builder';
import createDatabaseWorker from './database';
import schedulePackage from './scheduler';
import config from 'config';
import * as commandLineArgs from 'command-line-args';

const mainDefinitions = [
    { name: 'command', defaultOption: true },
    { name: 'arch', type: String },
    { name: 'repo', type: String }
];
const mainOptions = commandLineArgs.default(mainDefinitions, { stopAtFirstUnknown: true });

const redisHost = String(config.get("redis.host"));
const redisPort = Number(config.get("redis.port"));
const redisPassword = String(config.get("redis.password"));

var workers: Worker[] = [];

async function main(): Promise<void> {
    const connection = new IORedis(redisPort, redisHost, { password: redisPassword, maxRetriesPerRequest: null });

    switch (mainOptions.command) {
        case 'schedule':
            if (typeof mainOptions._unknown === 'undefined' || mainOptions._unknown.length !== 1) {
                console.error('No package name specified');
                process.exit(1);
            }
            await schedulePackage(connection, mainOptions.arch || 'x86_64', mainOptions.repo || 'chaotic-aur', mainOptions._unknown[0]);
            connection.quit();
            return;
        case 'builder':
            if (!config.has("paths.shared") || !config.has("database.host") || !config.has("database.port") || !config.has("database.username")) {
                console.error('Config variables incomplete');
                return process.exit(1);
            }
            workers.push(createBuilder(connection));
            break;
        case 'database':
            if (!config.has("paths.landing_zone") || !config.has("paths.repo") || !config.has("paths.gpg")) {
                console.error('Config variables incomplete');
                return process.exit(1);
            }
            createDatabaseWorker(connection);
            break;
        default:
            console.error('Invalid command');
            return process.exit(1);
    }
}

main();
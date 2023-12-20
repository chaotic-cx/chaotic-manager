import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import createBuilder from './builder';
import createDatabaseWorker from './database';
import { schedulePackages } from './scheduler';
import * as commandLineArgs from 'command-line-args';
import { startWebServer } from './web';

const mainDefinitions = [
    { name: 'command', defaultOption: true },
    { name: 'arch', type: String },
    { name: 'repo', type: String },
    { name: 'web-port', type: Number },
];
const mainOptions = commandLineArgs.default(mainDefinitions, { stopAtFirstUnknown: true });

const redisHost = process.env.REDIS_HOST || "localhost"
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const redisPassword = process.env.REDIS_PASSWORD || "";

var workers: Worker[] = [];

async function main(): Promise<void> {
    const connection = new IORedis(redisPort, redisHost, { password: redisPassword, maxRetriesPerRequest: null, lazyConnect: true });

    switch (mainOptions.command) {
        case 'schedule':
            if (typeof mainOptions._unknown === 'undefined' || mainOptions._unknown.length < 1) {
                console.error('No package names specified');
                process.exit(1);
            }
            await connection.connect();
            await schedulePackages(connection, mainOptions.arch || 'x86_64', mainOptions.repo || 'chaotic-aur', mainOptions._unknown);
            connection.quit();
            return;
        case 'builder':
            if (!process.env.SHARED_PATH) {
                console.error('Config variables incomplete');
                return process.exit(1);
            }
            await connection.connect();
            workers.push(createBuilder(connection));
            break;
        case 'database':
            if (!process.env.LANDING_ZONE_PATH || !process.env.REPO_PATH || !process.env.GPG_PATH || !process.env.DATABASE_HOST || !process.env.DATABASE_PORT || !process.env.DATABASE_USER) {
                console.error('Config variables incomplete');
                return process.exit(1);
            }
            await connection.connect();
            if (typeof mainOptions['web-port'] !== 'undefined') {
                startWebServer(Number(mainOptions['web-port']), connection);
            }
            createDatabaseWorker(connection);
            break;
        case 'web':
            await connection.connect();
            startWebServer(Number(mainOptions['web-port']) || 8080, connection);
            break;
        default:
            console.error('Invalid command');
            return process.exit(1);
    }
}

main();
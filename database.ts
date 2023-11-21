
import { Worker, Job, UnrecoverableError } from 'bullmq';
import RedisConnection from 'ioredis';
import Docker from 'dockerode';
import to from 'await-to-js';
import { RemoteSettings, current_version } from './types';

async function publishSettingsObject(connection: RedisConnection, settings: RemoteSettings): Promise<void> {
    const subscriber = connection.duplicate();
    subscriber.on("message", async (channel: string, message: string) => {
        if (channel === "config-request") {
            connection.publish("config-response", JSON.stringify(settings));
        }
    });
    await subscriber.subscribe("config-request");
    connection.publish("config-response", JSON.stringify(settings));
}

export default function createDatabaseWorker(connection: RedisConnection): Worker {
    const landing_zone = process.env.LANDING_ZONE_PATH || '';
    const repo_root = process.env.REPO_PATH || '';
    const gpg = process.env.GPG_PATH || '';

    const database_host = process.env.DATABASE_HOST || '';
    const database_port = Number(process.env.DATABASE_PORT) || 0;
    const database_user = process.env.DATABASE_USER || '';

    const settings: RemoteSettings = {
        database: {
            ssh: {
                host: database_host,
                port: database_port,
                user: database_user
            },
            landing_zone
        },
        version: current_version
    };

    const docker = new Docker();
    const worker = new Worker("database", async (job: Job) => {
        console.log(`Processing job ${job.id}`);
        const arch = job.data.arch;
        const repo = job.data.repo;
        const packages: string[] = job.data.packages;

        if (packages.length === 0) {
            console.log(`Job ${job.id} had no packages to add.`);
            throw new UnrecoverableError('No packages to add.');
        }

        const [err, out] = await to(docker.run('registry.gitlab.com/garuda-linux/pkgsbuilds-aur', ["repo-add", arch, "/landing_zone", "/repo_root", repo].concat(packages), process.stdout, {
            HostConfig: {
                AutoRemove: true,
                Binds: [
                    `${landing_zone}:/landing_zone`,
                    `${repo_root}:/repo_root`,
                    `${gpg}:/root/.gnupg`
                ],
                Ulimits: [
                    {
                        Name: "nofile",
                        Soft: 1024,
                        Hard: 1048576
                    }
                ]
            }
        }));

        if (err)
            console.error(err);

        if (err || out.StatusCode !== undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('repo-add failed.');
        } else {
            console.log(`Finished job ${job.id}.`);
        }
    }, { connection });

    publishSettingsObject(connection, settings);

    return worker;
}

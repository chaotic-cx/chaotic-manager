
import { Worker, Queue, Job } from 'bullmq';
import RedisConnection from 'ioredis';
import Docker from 'dockerode';
import to from 'await-to-js';
import fs from 'fs';
import path from 'path';
import { Client } from 'node-scp';
import { RemoteSettings, current_version } from './types';

function ensurePathClean(dir: string): void {
    if (fs.existsSync(dir))
        fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
}

async function requestRemoteConfig(connection: RedisConnection, worker: Worker, config: any): Promise<void> {
    const database_host = process.env.DATABASE_HOST || 'localhost';
    const database_port = Number(process.env.DATABASE_PORT || 22);
    const database_user = process.env.DATABASE_USER || 'root';

    const subscriber = connection.duplicate();
    subscriber.on("message", async (channel: string, message: string) => {
        if (channel === "config-response") {
            const remote_config : RemoteSettings = JSON.parse(message);
            if (remote_config.version !== current_version) {
                if (!worker.isPaused())
                {
                    worker.pause();
                    console.log("Worker received incompatible config from master. Worker paused.");
                }
                return;
            }
            else
            {
                remote_config.database.ssh.host = database_host;
                remote_config.database.ssh.port = database_port;
                remote_config.database.ssh.user = database_user;
                config.settings = remote_config;
                if (worker.isPaused())
                {
                    worker.resume();
                    console.log("Worker received valid config from master. Worker resumed.");
                }
            }
        }
    });
    await subscriber.subscribe("config-response");
    connection.publish("config-request", "request");
}

export default function createBuilder(connection: RedisConnection): Worker {
    const remotemount: string = path.join(process.env.SHARED_PATH || '', 'pkgout');
    const mount = "/shared/pkgout"

    const docker = new Docker();
    const database_queue = new Queue("database", { connection });

    const runtime_settings : { settings: any } = { settings: null };

    const worker = new Worker("builds", async (job: Job) => {
        console.log(`Processing job ${job.id}`);
        // Copy settings
        const remote_settings : RemoteSettings = structuredClone(runtime_settings.settings);

        ensurePathClean(mount);
        const [err, out] = await to(docker.run('registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder', ["build", String(job.id)], process.stdout, {
            HostConfig: {
                AutoRemove: true,
                Binds: [
                    remotemount + ':/home/builder/pkgout'
                ],
                Ulimits: [
                    {
                        Name: "nofile",
                        Soft: 1024,
                        Hard: 1048576
                    }
                ]
            }
        }
        ));
        if (err)
            console.error(err);

        if (err || out.StatusCode !== undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('Building failed.');
        }
        else
            console.log(`Finished build ${job.id}. Uploading...`);

        try {
            const client = await Client({
                host: String(remote_settings.database.ssh.host),
                port: Number(remote_settings.database.ssh.port),
                username: String(remote_settings.database.ssh.user),
                privateKey: fs.readFileSync('sshkey'),
            })
            await client.uploadDir(
                mount,
                remote_settings.database.landing_zone,
            )
            client.close()
        } catch (e) {
            console.error(`Failed to upload ${job.id}: ${e}`)
            throw new Error('Upload failed.');
        }
        console.log(`Finished upload ${job.id}. Scheduling database job...`);
        await database_queue.add("database", {
            arch: job.data.arch,
            repo: job.data.repo,
            packages: fs.readdirSync(mount)
        }, {
            jobId: job.id,
            removeOnComplete: true,
            removeOnFail: true
        });
        console.log(`Job ${job.id} finished.`);
    }, { connection });
    worker.pause();

    requestRemoteConfig(connection, worker, runtime_settings);

    return worker;
}

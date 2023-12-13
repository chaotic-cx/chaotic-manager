
import { Worker, Queue, Job } from 'bullmq';
import RedisConnection from 'ioredis';
import fs from 'fs';
import path from 'path';
import { Client } from 'node-scp';
import { RemoteSettings, current_version } from './types';
import { DockerManager } from './docker-manager';

// Console.log immitation that saves to a variable instead of stdout
class SshLogger {
    logs: string[] = [];

    log(arg: any): void {
        this.logs.push(arg);
    }
    dump(): string {
        return this.logs.join('\n');
    }
}

function ensurePathClean(dir: string): void {
    if (fs.existsSync(dir))
        fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
}

function requestRemoteConfig(connection: RedisConnection, worker: Worker, docker: DockerManager, config: any): Promise<void> {
    return new Promise<void>(async (resolve, reject) => { 
        const database_host = process.env.DATABASE_HOST || null;
        const database_port = Number(process.env.DATABASE_PORT || 22);
        const database_user = process.env.DATABASE_USER || null;
        var init: boolean = true;

        const subscriber = connection.duplicate();
        subscriber.on("message", async (channel: string, message: string) => {
            if (channel === "config-response") {
                if (!worker.isPaused()) {
                    console.log("Pausing worker for incoming config...");
                    worker.pause();
                }
                const remote_config : RemoteSettings = JSON.parse(message);
                if (remote_config.version !== current_version) {
                    console.log("Worker received incompatible config from master. Worker paused.");
                    return;
                }
                else
                {
                    if (database_host !== null) {
                        remote_config.database.ssh.host = database_host;
                        remote_config.database.ssh.port = database_port;
                    }
                    if (database_user !== null)
                        remote_config.database.ssh.user = database_user;
                    config.settings = remote_config;
                    await docker.scheduledPull(remote_config.builder.image);
                    if (init) {
                        init = false;
                        resolve();
                    }
                    else
                    {
                        worker.resume();
                        console.log("Worker received valid config from master. Worker resumed.");
                    }
                }
            }
        });
        await subscriber.subscribe("config-response");
        connection.publish("config-request", "request");
    });
}

export default function createBuilder(connection: RedisConnection): Worker {
    const shared_pkgout: string = path.join(process.env.SHARED_PATH || '', 'pkgout');
    const shared_sources: string = path.join(process.env.SHARED_PATH || '', 'sources');
    const mount = "/shared/pkgout"

    const docker_manager = new DockerManager();
    const database_queue = new Queue("database", { connection });

    const runtime_settings : { settings: RemoteSettings | null } = { settings: null };

    const worker = new Worker("builds", async (job: Job) => {
        console.log(`Processing job ${job.id}`);
        // Copy settings
        const remote_settings: RemoteSettings = structuredClone(runtime_settings.settings) as RemoteSettings;

        ensurePathClean(mount);
        const [err, out] = await docker_manager.run(remote_settings.builder.image, ["build", String(job.id)], [shared_pkgout + ':/home/builder/pkgout', shared_sources + ':/pkgbuilds'], [
            "PACKAGE_REPO=" + remote_settings.builder.package_repo,
        ]);

        if (err || out.StatusCode !== undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('Building failed.');
        }
        else
            console.log(`Finished build ${job.id}. Uploading...`);

        const logger = new SshLogger();
        try {
            const client = await Client({
                host: String(remote_settings.database.ssh.host),
                port: Number(remote_settings.database.ssh.port),
                username: String(remote_settings.database.ssh.user),
                privateKey: fs.readFileSync('sshkey'),
                debug: logger.log.bind(logger)
            })
            await client.uploadDir(
                mount,
                remote_settings.database.landing_zone,
            )
            client.close()
        } catch (e) {
            console.error(`Failed to upload ${job.id}: ${e}`);
            console.error(logger.dump());
            console.log("End of ssh log.");
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

    requestRemoteConfig(connection, worker, docker_manager, runtime_settings).then(async () => {
        worker.resume();
        console.log("Worker ready to process jobs.");
        // In general, avoid putting logic here that can't be changed via remote config update dynamically
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });;

    return worker;
}

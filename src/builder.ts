
import { Worker, Queue, Job } from 'bullmq';
import RedisConnection from 'ioredis';
import fs from 'fs';
import path from 'path';
import { Client } from 'node-scp';
import { RemoteSettings, current_version, JobData } from './types';
import { DockerManager } from './docker-manager';
import { BuildsRedisLogger, SshLogger } from './logging';
import { RepoManager } from './repo-manager';
import { splitJobId } from './utils';
import { RedisConnectionManager } from './redis-connection-manager';

function ensurePathClean(dir: string): void {
    if (fs.existsSync(dir))
        fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
}

function requestRemoteConfig(manager: RedisConnectionManager, worker: Worker, docker: DockerManager, config: any): Promise<void> {
    return new Promise<void>(async (resolve, reject) => { 
        const database_host = process.env.DATABASE_HOST || null;
        const database_port = Number(process.env.DATABASE_PORT || 22);
        const database_user = process.env.DATABASE_USER || null;
        var init: boolean = true;

        const subscriber = manager.getSubscriber();
        const connection = manager.getClient();
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

export default function createBuilder(redis_connection_manager: RedisConnectionManager): Worker {
    const shared_pkgout: string = path.join(process.env.SHARED_PATH || '', 'pkgout');
    const shared_sources: string = path.join(process.env.SHARED_PATH || '', 'sources');
    const mount = "/shared/pkgout"

    const connection = redis_connection_manager.getClient();

    const docker_manager = new DockerManager();
    const database_queue = new Queue("database", { connection });

    const runtime_settings : { settings: RemoteSettings | null } = { settings: null };

    const worker = new Worker("builds", async (job: Job) => {
        if (job.id === undefined)
            throw new Error('Job ID is undefined');
        
        const { target_repo, pkgbase } = splitJobId(job.id);
        const logger = new BuildsRedisLogger(connection);
        logger.fromJob(job);

        logger.log(`Processing build job ${job.id} at ${new Date().toISOString()}`);
        // Copy settings
        const remote_settings: RemoteSettings = structuredClone(runtime_settings.settings) as RemoteSettings;

        const jobdata: JobData = job.data;
        const repo_manager: RepoManager = new RepoManager(undefined);
        repo_manager.repoFromObject(remote_settings.repos);
        repo_manager.targetRepoFromObject(remote_settings.target_repos);
        const src_repo = repo_manager.getRepo(jobdata.srcrepo);

        ensurePathClean(mount);
        const [err, out] = await docker_manager.run(remote_settings.builder.image, ["build", pkgbase], [shared_pkgout + ':/home/builder/pkgout', shared_sources + ':/pkgbuilds'], [
            "PACKAGE_REPO_ID=" + src_repo.id,
            "PACKAGE_REPO_URL=" + src_repo.getUrl(),
            "EXTRA_PACMAN_REPOS=" + repo_manager.getTargetRepo(target_repo).repoToString(),
            "EXTRA_PACMAN_KEYRINGS=" + repo_manager.getTargetRepo(target_repo).keyringsToBashArray(),
        ], logger.raw_log.bind(logger));

        const file_list = fs.readdirSync(mount);
        if (err || out.StatusCode !== undefined || file_list.length === 0) {
            logger.log(`Job ${job.id} failed`);
            throw new Error('Building failed.');
        }
        else
            logger.log(`Finished build ${job.id}. Uploading...`);

        const sshlogger = new SshLogger();
        try {
            const client = await Client({
                host: String(remote_settings.database.ssh.host),
                port: Number(remote_settings.database.ssh.port),
                username: String(remote_settings.database.ssh.user),
                privateKey: fs.readFileSync('sshkey'),
                debug: sshlogger.log.bind(sshlogger)
            })
            await client.uploadDir(
                mount,
                remote_settings.database.landing_zone,
            )
            client.close()
        } catch (e) {
            logger.error(`Failed to upload ${job.id}: ${e}`);
            // This does not get logged to redis
            console.error(sshlogger.dump());
            console.log("End of ssh log.");
            throw new Error('Upload failed.');
        }
        logger.log(`Finished upload ${job.id}.`);
        await database_queue.add("database", {
            arch: jobdata.arch,
            repo: target_repo,
            packages: file_list,
            timestamp: jobdata.timestamp,
            pkgbase: pkgbase,
            commit: jobdata.commit,
        }, {
            jobId: job.id,
            removeOnComplete: true,
            removeOnFail: true,
        });
        logger.log(`Build job ${job.id} finished. Scheduled database job at ${new Date().toISOString()}...`);
    }, { connection });
    worker.pause();

    requestRemoteConfig(redis_connection_manager, worker, docker_manager, runtime_settings).then(async () => {
        worker.resume();
        console.log("Worker ready to process jobs.");
        // In general, avoid putting logic here that can't be changed via remote config update dynamically
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });;

    return worker;
}

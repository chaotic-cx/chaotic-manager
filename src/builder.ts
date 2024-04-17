
import { Worker, Queue, Job } from 'bullmq';
import fs from 'fs';
import path from 'path';
import { Client } from 'node-scp';
import { RemoteSettings, current_version, BuildJobData, DatabaseJobData, BuildStatus } from './types';
import { DockerManager } from './docker-manager';
import { BuildsRedisLogger, SshLogger } from './logging';
import { RepoManager } from './repo-manager';
import { splitJobId } from './utils';
import { RedisConnectionManager } from './redis-connection-manager';
import { promotePendingDependents, handleJobOrder } from './buildorder';
import Docker from 'dockerode';
import to from 'await-to-js';

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
                const remote_config: RemoteSettings = JSON.parse(message);
                if (remote_config.version !== current_version) {
                    console.log("Worker received incompatible config from master. Worker paused.");
                    return;
                }
                else {
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
                    else {
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

// Request a list of files from the database server and fill the destination directory with empty files
// Goal: stop pacman from building packages it has already built
async function generateDestFillerFiles(repo_files: string[], destdir: string): Promise<void> {
    for (const line of repo_files) {
        const filepath = path.join(destdir, line);
        fs.writeFileSync(filepath, "");
    }
}

export default function createBuilder(redis_connection_manager: RedisConnectionManager): Worker {
    const shared_pkgout: string = path.join(process.env.SHARED_PATH || '', 'pkgout');
    const shared_sources: string = path.join(process.env.SHARED_PATH || '', 'sources');
    const mount = "/shared/pkgout"

    const connection = redis_connection_manager.getClient();
    const subscriber = redis_connection_manager.getSubscriber();
    subscriber.subscribe("cancel-job");

    const docker_manager = new DockerManager();
    const database_queue = new Queue("database", { connection });
    const builds_queue = new Queue("builds", { connection });

    const runtime_settings: { settings: RemoteSettings | null } = { settings: null };

    const worker = new Worker("builds", async (job: Job): Promise<BuildStatus> => {
        if (job.id === undefined)
            throw new Error('Job ID is undefined');

        const { target_repo, pkgbase } = splitJobId(job.id);
        const logger = new BuildsRedisLogger(connection);
        logger.fromJob(job);

        logger.log(`Processing build job ${job.id} at ${new Date().toISOString()}`);
        // Copy settings
        const remote_settings: RemoteSettings = structuredClone(runtime_settings.settings) as RemoteSettings;
        const jobdata: BuildJobData = job.data;

        var cancelled = false;
        var listener = null;
        var docker: Docker.Container | null = null;
        async function on_cancel(channel: string, message: string) {
            if (channel === "cancel-job" && message === job.id) {
                logger.log(`Job ${job.id} cancelled.`);
                cancelled = true;
                subscriber.off("message", on_cancel);
                if (docker !== null)
                    await docker_manager.kill(docker).catch((e) => { console.error(e) });
            }
        }
        try {
            listener = subscriber.on("message", on_cancel);

            await handleJobOrder(job, builds_queue, database_queue, logger);

            const repo_manager: RepoManager = new RepoManager(undefined);
            repo_manager.repoFromObject(remote_settings.repos);
            repo_manager.targetRepoFromObject(remote_settings.target_repos);
            const src_repo = repo_manager.getRepo(jobdata.srcrepo);

            ensurePathClean(mount);
            generateDestFillerFiles(jobdata.repo_files, mount);

            if (cancelled) {
                throw new Error('Job cancelled.');
            }
            const container = await docker_manager.create(remote_settings.builder.image, ["build", pkgbase], [shared_pkgout + ':/home/builder/pkgout', shared_sources + ':/pkgbuilds'], [
                "PACKAGE_REPO_ID=" + src_repo.id,
                "PACKAGE_REPO_URL=" + src_repo.getUrl(),
                "EXTRA_PACMAN_REPOS=" + repo_manager.getTargetRepo(target_repo).repoToString(),
                "EXTRA_PACMAN_KEYRINGS=" + repo_manager.getTargetRepo(target_repo).keyringsToBashArray(),
            ]);
            if (cancelled) {
                await docker_manager.kill(container).catch((e) => { console.error(e) });
                throw new Error('Job cancelled.');
            }
            docker = container;
            const [err, out] = await to(docker_manager.start(docker, logger.raw_log.bind(logger)));
            docker = null;

            // Remove any filler files from the equation
            const file_list = fs.readdirSync(mount).filter((file) => { const stats = fs.statSync(path.join(mount, file)); return stats.isFile() && stats.size > 0; });
            if (err || out.StatusCode !== 0 || file_list.length === 0) {
                if (!err && out.StatusCode === 13) {
                    logger.log(`Job ${job.id} skipped because all packages were already built.`);
                    setTimeout(promotePendingDependents.bind(null, jobdata, builds_queue, logger), 1000);
                    return BuildStatus.ALREADY_BUILT;
                }
                else {
                    logger.log(`Job ${job.id} failed`);
                    throw new Error('Building failed.');
                }
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
            const db_job_data: DatabaseJobData = {
                arch: jobdata.arch,
                packages: file_list,
                timestamp: jobdata.timestamp,
                commit: jobdata.commit,
                srcrepo: jobdata.srcrepo,
            };
            await database_queue.add("database", db_job_data, {
                jobId: job.id,
                removeOnComplete: true,
                removeOnFail: true,
            });
            logger.log(`Build job ${job.id} finished. Scheduled database job at ${new Date().toISOString()}...`);
        } catch (e) {
            setTimeout(promotePendingDependents.bind(null, jobdata, builds_queue, logger), 1000);
            throw e;
        } finally {
            if (listener !== null)
                subscriber.off("message", on_cancel);
        }
        return BuildStatus.SUCCESS;
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

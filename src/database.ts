
import { Worker, Job, UnrecoverableError, QueueEvents, Queue } from 'bullmq';
import { RemoteSettings, JobData, current_version } from './types';
import { DockerManager } from './docker-manager';
import { BuildsRedisLogger } from './logging';
import { RepoManager } from './repo-manager';
import { RedisConnectionManager } from './redis-connection-manager';

async function publishSettingsObject(manager: RedisConnectionManager, settings: RemoteSettings): Promise<void> {
    const subscriber = manager.getSubscriber();
    const connection = manager.getClient();
    subscriber.on("message", async (channel: string, message: string) => {
        if (channel === "config-request") {
            connection.publish("config-response", JSON.stringify(settings));
        }
    });
    await subscriber.subscribe("config-request");
    connection.publish("config-response", JSON.stringify(settings));
}

export default function createDatabaseWorker(redis_connection_manager: RedisConnectionManager): Worker {
    const landing_zone = process.env.LANDING_ZONE_PATH || '';
    const landing_zone_adv = process.env.LANDING_ZONE_ADVERTISED_PATH || null;
    const repo_root = process.env.REPO_PATH || '';
    const gpg = process.env.GPG_PATH || '';

    const database_host = process.env.DATABASE_HOST || 'localhost';
    const database_port = Number(process.env.DATABASE_PORT || 22);
    const database_user = process.env.DATABASE_USER || 'root';

    const builder_image = process.env.BUILDER_IMAGE || 'registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest';
    
    const base_logs_url = process.env.LOGS_URL;
    var package_repos = process.env.PACKAGE_REPOS;
    var package_target_repos = process.env.PACKAGE_TARGET_REPOS;
    const package_repos_notifiers = process.env.PACKAGE_REPOS_NOTIFIERS;

    var repo_manager = new RepoManager(base_logs_url ? new URL(base_logs_url) : undefined);

    if (package_repos)
    {
        try {
            var obj = JSON.parse(package_repos);
            repo_manager.repoFromObject(obj);
        } catch (error) {
            console.error(error);
            throw new Error("Invalid package repos.");
        }
    }
    if (!package_repos)
    {
        repo_manager.repoFromObject({
            "chaotic-aur": {
                "url": "https://gitlab.com/garuda-linux/pkgsbuilds-aur"
            },
        });
    }

    if (package_target_repos)
    {
        try {
            var obj = JSON.parse(package_target_repos);
            repo_manager.targetRepoFromObject(obj);
        } catch (error) {
            console.error(error);
            throw new Error("Invalid package repos.");
        }
    }
    if (!package_target_repos)
    {
        repo_manager.targetRepoFromObject({
            "chaotic-aur": {
                "extra_repos": [
                    {
                        "name": "chaotic-aur",
                        "servers": [
                            "https://builds.garudalinux.org/repos/$repo/$arch"
                        ]
                    }
                ],
                "extra_keyrings": [
                    "https://cdn-mirror.chaotic.cx/chaotic-aur/chaotic-keyring.pkg.tar.zst"
                ]
            }
        })
    }

    if (package_repos_notifiers)
    {
        try {
            var obj = JSON.parse(package_repos_notifiers);
            repo_manager.notifiersFromObject(obj);
        } catch (error) {
            console.error(error);
        }
    }

    const settings: RemoteSettings = {
        database: {
            ssh: {
                host: database_host,
                port: database_port,
                user: database_user
            },
            landing_zone: landing_zone_adv || landing_zone,
        },
        builder: {
            image: builder_image,
        },
        repos: repo_manager.repoToObject(),
        target_repos: repo_manager.targetRepoToObject(),
        version: current_version
    };

    const connection = redis_connection_manager.getClient();

    const docker_manager = new DockerManager();
    const worker = new Worker("database", async (job: Job) => {
        if (job.id === undefined)
            throw new Error('Job ID is undefined');
        const logger = new BuildsRedisLogger(connection);
        logger.fromJob(job);

        logger.log(`\r\nProcessing database job ${job.id} at ${new Date().toISOString()}`);
        const arch = job.data.arch;
        const repo = job.data.repo;
        const packages: string[] = job.data.packages;

        if (packages.length === 0) {
            logger.log(`Job ${job.id} had no packages to add.`);
            throw new UnrecoverableError('No packages to add.');
        }

        const [err, out] = await docker_manager.run(settings.builder.image, ["repo-add", arch, "/landing_zone", "/repo_root", repo].concat(packages), [ `${landing_zone}:/landing_zone`, `${repo_root}:/repo_root`, `${gpg}:/root/.gnupg` ], [], logger.raw_log.bind(logger));

        if (err)
            logger.error(err);

        if (err || out.StatusCode !== undefined) {
            logger.log(`Job ${job.id} failed at ${new Date().toISOString()}`);
            throw new Error('repo-add failed.');
        } else {
            logger.log(`Finished job ${job.id} at ${new Date().toISOString()}.`);
        }
    }, { connection: connection });
    worker.pause();

    const builds_queue_events = new QueueEvents("builds", { connection });
    const builds_queue = new Queue("builds", { connection });

    builds_queue_events.on("added", async ({ jobId, name }) => {
        const logger = new BuildsRedisLogger(connection);
        var job = await logger.fromJobID(jobId, builds_queue);
        logger.setDefault();
        logger.log(`Added to build queue at ${new Date().toISOString()}. Waiting for builder...`);
        if (job) {
            const jobdata: JobData = job.data;
            const repo = repo_manager.getRepo(jobdata.srcrepo);
            // Wait 3 seconds before we make a request to the notifier. No point in changing the status within a few seconds.
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
                // There is a chance the job could disappear before we get here
                if ((await job.getState()) == "waiting")
                    await repo.notify(job, "pending", "Waiting for builder...");
            } catch (error) {
                console.error(error);
            }
        }
    });
    builds_queue_events.on("stalled", async ({ jobId }) => {
        const logger = new BuildsRedisLogger(connection);
        var job = await logger.fromJobID(jobId, builds_queue);
        logger.log(`Job stalled at ${new Date().toISOString()}`);
        if (job) {
            const jobdata: JobData = job.data;
            const repo = repo_manager.getRepo(jobdata.srcrepo);
            await repo.notify(job, "failed", "Build stalled. Retrying...");
            await repo.notify(job, "pending", "Build stalled. Retrying...");
        }
    });
    builds_queue_events.on("active", async ({ jobId }) => {
        const logger = new BuildsRedisLogger(connection);
        var job = await logger.fromJobID(jobId, builds_queue);
        if (job) {
            const jobdata: JobData = job.data;
            const repo = repo_manager.getRepo(jobdata.srcrepo);
            await repo.notify(job, "running", "Build in progress...");
        }
    });
    builds_queue_events.on("retries-exhausted", async ({ jobId }) => {
        const logger = new BuildsRedisLogger(connection);
        var job = await logger.fromJobID(jobId, builds_queue);
        if (job) {
            const jobdata: JobData = job.data;
            const repo = repo_manager.getRepo(jobdata.srcrepo);
            await repo.notify(job, "failed", "Build failed.");
            job.remove();
        }
    });

    worker.on('completed', async (job: Job) => {
        const jobdata: JobData = job.data;
        const repo = repo_manager.getRepo(jobdata.srcrepo);
        await repo.notify(job, "success", "Package successfully deployed.");
    });
    worker.on('failed', async (job: Job | undefined) => {
        if (!job)
            return;
        const jobdata: JobData = job.data;
        const repo = repo_manager.getRepo(jobdata.srcrepo);
        await repo.notify(job, "failed", "Error adding package to database.");
    });

    publishSettingsObject(redis_connection_manager, settings);

    docker_manager.scheduledPull(settings.builder.image).then(() => {
        worker.resume();
        console.log("Ready to deploy packages.");
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });

    return worker;
}

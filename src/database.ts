
import { Worker, Job, UnrecoverableError, QueueEvents, Queue, tryCatch } from 'bullmq';
import RedisConnection from 'ioredis';
import { RemoteSettings, SEVEN_DAYS, current_version } from './types';
import { DockerManager } from './docker-manager';
import { BuildsRedisLogger } from './logging';
import { RepoManager } from './repo-manager';

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
    const landing_zone_adv = process.env.LANDING_ZONE_ADVERTISED_PATH || null;
    const repo_root = process.env.REPO_PATH || '';
    const gpg = process.env.GPG_PATH || '';

    const database_host = process.env.DATABASE_HOST || 'localhost';
    const database_port = Number(process.env.DATABASE_PORT || 22);
    const database_user = process.env.DATABASE_USER || 'root';

    const builder_image = process.env.BUILDER_IMAGE || 'registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest';
    
    const base_logs_url = process.env.BASE_LOGS_URL;
    var package_repos = process.env.PACKAGE_REPOS;
    const package_repos_notifiers = process.env.PACKAGE_REPO_NOTIFIERS;

    var repo_manager = new RepoManager(base_logs_url ? new URL(base_logs_url) : undefined);

    if (package_repos)
    {
        try {
            var obj = JSON.parse(package_repos);
            repo_manager.fromObject(obj);
        } catch (error) {
            console.error(error);
            throw new Error("Invalid package repos.");
        }
    }
    if (!package_repos)
    {
        repo_manager.fromObject({
            "chaotic-aur": {
                "url": "https://gitlab.com/garuda-linux/pkgsbuilds-aur"
            },
        });
    }

    if (package_repos_notifiers)
    {
        try {
            var obj = JSON.parse(package_repos_notifiers);
            repo_manager.fromObject(obj);
        } catch (error) {
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
        repos: repo_manager.toObject(),
        version: current_version
    };

    const docker_manager = new DockerManager();
    const worker = new Worker("database", async (job: Job) => {
        if (job.id === undefined)
            throw new Error('Job ID is undefined');
        const logger = new BuildsRedisLogger(connection);
        logger.fromJob(job);

        logger.log(`Processing database job ${job.id} at ${new Date().toISOString()}`);
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
    }, { connection });
    worker.pause();

    const builds_queue_events = new QueueEvents("builds", { connection });
    const builds_queue = new Queue("builds", { connection });

    builds_queue_events.on("added", async ({ jobId, name }) => {
        const logger = new BuildsRedisLogger(connection);
        await logger.fromJobID(jobId, builds_queue);
        logger.setDefault();
        logger.log(`Added to build queue at ${new Date().toISOString()}. Waiting for builder...`);
    });
    builds_queue_events.on("stalled", async ({ jobId }) => {
        const logger = new BuildsRedisLogger(connection);
        await logger.fromJobID(jobId, builds_queue);
        logger.log(`Job stalled at ${new Date().toISOString()}`);
    });

    publishSettingsObject(connection, settings);

    docker_manager.scheduledPull(settings.builder.image).then(() => {
        worker.resume();
        console.log("Ready to deploy packages.");
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });

    return worker;
}

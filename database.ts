
import { Worker, Job, UnrecoverableError } from 'bullmq';
import RedisConnection from 'ioredis';
import { RemoteSettings, current_version } from './types';
import { DockerManager } from './docker-manager';

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
    const package_repo = process.env.PACKAGE_REPO || 'https://gitlab.com/garuda-linux/pkgsbuilds-aur.git';

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
            package_repo: package_repo
        },
        version: current_version
    };

    const docker_manager = new DockerManager();
    const worker = new Worker("database", async (job: Job) => {
        console.log(`Processing job ${job.id}`);
        const arch = job.data.arch;
        const repo = job.data.repo;
        const packages: string[] = job.data.packages;

        if (packages.length === 0) {
            console.log(`Job ${job.id} had no packages to add.`);
            throw new UnrecoverableError('No packages to add.');
        }

        const [err, out] = await docker_manager.run(settings.builder.image, ["repo-add", arch, "/landing_zone", "/repo_root", repo].concat(packages), [ `${landing_zone}:/landing_zone`, `${repo_root}:/repo_root`, `${gpg}:/root/.gnupg` ]);

        if (err)
            console.error(err);

        if (err || out.StatusCode !== undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('repo-add failed.');
        } else {
            console.log(`Finished job ${job.id}.`);
        }
    }, { connection });
    worker.pause();

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

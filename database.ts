
import { Worker, Job, UnrecoverableError } from 'bullmq';
import RedisConnection from 'ioredis';
import Docker from 'dockerode';
import to from 'await-to-js';
import config from 'config';

export default function createDatabaseWorker(connection: RedisConnection): Worker {
    const landing_zone = String(config.get("paths.landing_zone"));
    const repo_root = String(config.get("paths.repo_root"));
    const gpg = String(config.get("paths.gpg"));

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

        if (out.StatusCode !== undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('repo-add failed.');
        } else {
            console.log(`Finished job ${job.id}.`);
        }
    }, { connection });

    return worker;
}

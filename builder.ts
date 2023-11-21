
import { Worker, Queue, Job } from 'bullmq';
import RedisConnection from 'ioredis';
import Docker from 'dockerode';
import to from 'await-to-js';
import fs from 'fs';
import path from 'path';
import { Client } from 'node-scp';
import config from 'config';

function ensurePathClean(dir: string): void {
    if (fs.existsSync(dir))
        fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
}

export default function createBuilder(connection: RedisConnection): Worker {
    const remotemount: string = path.join(String(config.get("paths.shared")), 'pkgout');
    const mount = "/shared/pkgout"

    const docker = new Docker();
    const database_queue = new Queue("database", { connection });
    const worker = new Worker("builds", async (job: Job) => {
        console.log(`Processing job ${job.id}`);
        ensurePathClean(mount);
        const [err, out] = await to(docker.run('registry.gitlab.com/garuda-linux/pkgsbuilds-aur', ["build", String(job.id)], process.stdout, {
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
        if (out.StatusCode != undefined) {
            console.log(`Job ${job.id} failed`);
            throw new Error('Building failed.');
        }
        else
            console.log(`Finished build ${job.id}. Uploading...`);

        try {
            const client = await Client({
                host: String(config.get("database.host")),
                port: Number(config.get("database.port")),
                username: String(config.get("database.username")),
                privateKey: fs.readFileSync('sshkey'),
            })
            await client.uploadDir(
                mount,
                String(config.get("paths.landing_zone")),
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
    return worker;
}

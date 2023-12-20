import { Queue, Job, JobsOptions } from 'bullmq';
import RedisConnection from 'ioredis';

export default function schedulePackage(connection: RedisConnection, arch: string, repo: string, name: string): Promise<void> {
    return schedulePackages(connection, arch, repo, [ name ]);
}

export async function schedulePackages(connection: RedisConnection, arch: string, repo: string, packages: string[]): Promise<void> {
    const queue = new Queue("builds", { connection });
    const list: { name: string, data: any, opts?: JobsOptions }[] = [];
    const timestamp = Date.now();
    packages.forEach((pkg) => {
        list.push({
            name: String(timestamp),
            data: {
                arch: arch,
                repo: repo
            },
            opts: {
                jobId: pkg,
                removeOnComplete: true,
                removeOnFail: true,
                timestamp: timestamp
            }
        });
    });
    await queue.addBulk(list);
    await queue.close();
}

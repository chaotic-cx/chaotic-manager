import { Queue, Job, JobsOptions } from 'bullmq';
import RedisConnection from 'ioredis';
import { JobData } from './types';

export default function schedulePackage(connection: RedisConnection, arch: string, repo: string, name: string): Promise<void> {
    return schedulePackages(connection, arch, repo, [ name ]);
}

export async function schedulePackages(connection: RedisConnection, arch: string, repo: string, packages: string[]): Promise<void> {
    const queue = new Queue("builds", { connection });
    const list: { name: string, data: any, opts?: JobsOptions }[] = [];
    const timestamp = Date.now();
    packages.forEach((pkg) => {
        // pkg is in the following format, where the repo part is optional:
        // srcrepo:pkgbase
        const pkg_split = pkg.split(':');
        const src_repo = pkg_split.length > 1 ? pkg_split[0] : undefined;
        const pkg_base = pkg_split.length > 1 ? pkg_split[1] : pkg_split[0];

        var jobdata: JobData = {
            arch: arch,
            srcrepo: src_repo,
            timestamp: timestamp,
        };

        list.push({
            name: `${pkg_base}-${timestamp}`,
            data: jobdata,
            opts: {
                jobId: repo + "/" + pkg_base,
                removeOnComplete: { age: 5 },
                removeOnFail: { age: 5 },
                timestamp: timestamp
            }
        });
    });
    await queue.addBulk(list);
    await queue.close();
}

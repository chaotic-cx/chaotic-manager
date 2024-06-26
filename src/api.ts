import { Metrics, Queue } from "bullmq";
import { MetricsReturnObject, PackagesReturnObject, StatsReturnObject } from "./types";

/**
 * The ChaoticApi class is a wrapper around the Queue class from BullMQ. It provides a set of methods to interact with the
 * manager's queue stats and similar information.
 * @class
 */
export class ChaoticApi {
    private readonly builderQueue: Queue;
    private readonly databaseQueue: Queue;

    /**
     * Creates a new ChaoticApi instance.
     * @constructor
     * @param Queues The queues of the manager instance.
     */
    constructor({ builderQueue, databaseQueue }: { builderQueue: Queue; databaseQueue: Queue }) {
        this.builderQueue = builderQueue;
        this.databaseQueue = databaseQueue;
    }

    /**
     * Builds a stats object for the queue, which contains the count of each job type and the packages associated with them.
     *
     * @returns A promise that resolves to the stats object.
     */
    async buildStatsObject(): Promise<StatsReturnObject> {
        const stats: StatsReturnObject = [];
        const jobs = await this.builderQueue.getJobs();
        for (const job of jobs) {
            const jobState = await job.getState();
            const existingStat = stats.find((stat) => stat[jobState]);
            if (!existingStat) {
                stats.push({
                    [jobState]: {
                        count: 1,
                        packages: [job.id],
                    },
                });
            } else {
                existingStat[jobState].count += 1;
                existingStat[jobState].packages.push(job.id);
            }
        }
        return stats;
    }

    /**
     * Builds a packages object which contains the all packages currently queued up and corresponding information like
     * architecture and target repository.
     *
     * @returns A promise that resolves to the packages object.
     */
    async buildPackagesObject(): Promise<PackagesReturnObject> {
        const packages = [];
        const jobs = await this.builderQueue.getJobs();
        for (const job of jobs) {
            if (job.id !== undefined) {
                packages.push({
                    [job.id.toString()]: {
                        arch: job.data.arch,
                        srcrepo: job.data.srcrepo,
                        timestamp: job.data.timestamp,
                        repo_files: job.data.repo_files,
                    },
                });
            }
        }
        return packages;
    }

    /**
     * Builds a metrics object which contains the count of completed and failed jobs in the builder and database queues.
     */
    async buildMetricsObject(): Promise<MetricsReturnObject> {
        const metrics: Metrics[] = await Promise.all([
            this.builderQueue.getMetrics("completed"),
            this.builderQueue.getMetrics("failed"),
            this.databaseQueue.getMetrics("completed"),
            this.databaseQueue.getMetrics("failed"),
        ]);
        return {
            builder_queue: {
                completed: metrics[0].count,
                failed: metrics[1].count,
            },
            database_queue: {
                completed: metrics[2].count,
                failed: metrics[3].count,
            },
        };
    }
}

import express, {Request, Response} from 'express';
import {JobType, Queue} from 'bullmq';
import to from 'await-to-js';
import {RedisConnectionManager} from './redis-connection-manager';
import Timeout from 'await-timeout';

export async function startWebServer(port: number, manager: RedisConnectionManager) {
    const connection = manager.getClient();
    const subscriber = manager.getSubscriber();

    const builder_queue = new Queue("builds", { connection });
    const database_queue = new Queue("database", { connection });

    const app = express();

    async function getOrStreamLog(req: Request, res: Response): Promise<any> {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Connection', 'keep-alive');

        const id: string = req.params.id;
        var timestamp: string = req.params.timestamp;
        // Verify if timestamp is a number and if id is alphanumerical or -/_ via regex
        if (!/^\d+$/.test(timestamp) || !/^[a-zA-Z0-9-_]+$/.test(id)) {
            res.status(400).send("Invalid timestamp");
            return;
        }

        var unref: any[] = [];

        const subscribable = "build-logs." + id + "." + timestamp;

        const closer = () => {
            subscriber.unsubscribe(subscribable);
            for (const unrefable of unref) {
                res.removeListener('close', unrefable);
                res.removeListener('finish', unrefable);
                subscriber.removeListener("message", unrefable);
            }
        };
        unref.push(closer);
        res.once('close', closer);
        res.once('finish', closer);

        var [err, out] = await to(Promise.all([connection.get("build-logs:" + id + ":" + timestamp), subscriber.subscribe(subscribable)]));
        if (err || !out || !out[0]) {
            res.status(404).send("Not found");
            return;
        }

        res.write(out[0]);

        const forwarder = async (channel: string, message: string) => {
            if (channel === subscribable) {
                if (message == "END") {
                    await Timeout.set(1000);
                    try {
                        res.end();
                    } catch (e) {
                    }
                }
                else
                    res.write(message.substring(3));
            }
        }

        unref.push(forwarder);
        subscriber.on("message", forwarder);

        var busy: boolean = false;
        var [err, active] = await to(connection.keys(`bull:[^:]*:[^:]*/${id}`));
        if (active && active.length > 0) {
            var full_key;
            for (const key of active) {
                // Extract full key from redis via regex
                const temp_key = key.match(/^bull:[^:]*:([^:]*\/[^:]*)$/)?.[1];
                if (!temp_key)
                    continue;
                full_key = temp_key;
                break;
            }
            if (full_key) {
                const jobs = await Promise.all([builder_queue.getJob(full_key), database_queue.getJob(full_key)]);
                for (const job of jobs) {
                    if (!job || !job.data || job.data.timestamp !== Number(timestamp))
                        continue;
                    const state = await job.getState();
                    if (['active', 'waiting'].includes(state)) {
                        busy = true;
                        break;
                    }
                }
            }
        }

        if (!busy)
            res.end();
    }

    /**
     * Builds a stats object for the queue, which contains the count of each job type and the packages associated with them.
     * @param res The response object to send the stats object to.
     * @returns A promise that resolves to the stats object.
     */
    async function buildStatsObject(res: Response): Promise<Object> {
        const validJobTypes: JobType[] = ['completed', 'failed', 'active', 'delayed', 'prioritized', 'waiting', 'waiting-children', 'paused', 'repeat'];
        let stats = [];
        for (const currType of validJobTypes) {
            try {
                const jobs = await builder_queue.getJobs([currType])
                if (jobs.length !== 0) {
                    stats.push({
                        [currType]: {
                            count: jobs.length,
                            packages: jobs.map((job) => job.id),
                        }
                    });
                }
            } catch (err) {
                console.error(err);
            }
        }
        return stats;
    }

    /**
     * Builds a packages object which contains the all packages currently queued up and corresponding information like
     * architecture and target repository.
     * @param res The response object to send the packages object to.
     * @returns A promise that resolves to the packages object.
     */
    async function buildPackagesObject(res: Response): Promise<Object> {
        const validJobTypes: JobType[] = ['completed', 'failed', 'active', 'delayed', 'prioritized', 'waiting', 'waiting-children', 'paused', 'repeat'];
        let packages = [];
        for (const currType of validJobTypes) {
            try {
                const jobs = await builder_queue.getJobs(currType)
                if (jobs.length !== 0) {
                    for (let i = 0; i < jobs.length; i++) {
                        const job = jobs[i];
                        if (job.opts.jobId !== undefined) {
                            packages.push({
                                [job.opts.jobId.toString()]: {
                                    arch: job.data.arch,
                                    srcrepo: job.data.srcrepo,
                                    timestamp: job.data.timestamp,
                                    repo_files: job.data.repo_files,
                                }
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(err);
            }
        }
        return packages;
    }

    app.get("/api/logs/:id/:timestamp", getOrStreamLog);

    app.get("/api/logs/:id", async (req: Request, res: Response) => {
        const [err, out] = await to(connection.get("build-logs:" + req.params.id + ":default"));
        if (err || !out) {
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Content-Type", "text/plain");
            res.status(404).send("Not found");
            return;
        }

        req.params.timestamp = out;
        return await getOrStreamLog(req, res);
    });

    app.get("/api/queue/stats", async (req: Request, res: Response) => {
        try {
            const stats = await buildStatsObject(res);
            return res.json(stats);
        } catch (err) {
            console.error(err);
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Content-Type", "text/plain");
            res.status(500).send("The server exploded!");
            return
        }
    });

    app.get("/api/queue/packages", async (req: Request, res: Response) => {
        try {
            const packages = await buildPackagesObject(res);
            return res.json(packages);
        } catch (err) {
            console.error(err);
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Content-Type", "text/plain");
            res.status(500).send("The server exploded!");
            return
        }
    });

    app.get("/api/queue/metrics", async (req: Request, res: Response) => {
        try {
            const metricsBuilderCompleted = await builder_queue.getMetrics('completed');
            const metricsBuilderFailed = await builder_queue.getMetrics('failed');
            const metricsDbCompleted = await database_queue.getMetrics('completed');
            const metricsDbFailed = await database_queue.getMetrics('failed');
            return res.json({
                builder_queue: {
                    completed: metricsBuilderCompleted.count,
                failed: metricsBuilderFailed.count,
                },
                database_queue: {
                    completed: metricsDbCompleted.count,
                    failed: metricsDbFailed.count,
                }
            });
        } catch (err) {
            console.error(err);
            res.status(500).send("The server exploded!");
            return
        }
    });

    app.use(express.static("public", {
        // 1 day in milliseconds
        maxAge: 1000 * 60 * 60 * 24
    }));

    app.listen(port, () => {
        console.log(`Web server listening on port ${port}`);
    });
}
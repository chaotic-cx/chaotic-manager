import express, { Request, Response } from 'express';
import { Queue } from 'bullmq';
import to from 'await-to-js';
import { RedisConnectionManager } from './redis-connection-manager';
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
            console.log("closing???");
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

    app.get('/api/logs/:id/:timestamp', getOrStreamLog);

    app.get('/api/logs/:id', async (req: Request, res: Response) => {
        const [err, out] = await to(connection.get("build-logs:" + req.params.id + ":default"));
        if (err || !out) {
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Content-Type', 'text/plain');
            res.status(404).send("Not found");
            return;
        }

        req.params.timestamp = out;
        return await getOrStreamLog(req, res);
    });

    app.use(express.static('public', {
        // 1 day in milliseconds
        maxAge: 1000 * 60 * 60 * 24
    }));

    app.listen(port, () => {
        console.log(`Web server listening on port ${port}`);
    });
}
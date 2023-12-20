import RedisConnection from 'ioredis';
import express, { Request, Response } from 'express';
import { Job, Queue, QueueEvents } from 'bullmq';
import to from 'await-to-js';
import EventEmitter from 'events';

export async function startWebServer(port: number, connection: RedisConnection) {
    const emitter = new EventEmitter();
    
    const database_queue_events = new QueueEvents("database", { connection });
    database_queue_events.on('completed', ({ jobId }) => {
        emitter.emit('ended', jobId);
    });
    database_queue_events.on('failed', ({ jobId }) => {
        emitter.emit('ended', jobId);
    });

    const builder_queue = new Queue("builds", { connection });
    const database_queue = new Queue("database", { connection });

    const subscriber = connection.duplicate();
    await subscriber.connect();

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
    
        var unref: [] = [];
    
        const subscribable = "build-logs." + id + "." + timestamp;
    
        const closer =  () => {
            subscriber.unsubscribe(subscribable);
            for (const unrefable of unref) {
                res.removeListener('close', unrefable);
                res.removeListener('finish', unrefable);
                subscriber.removeListener("message", unrefable);
                emitter.removeListener('ended', unrefable);
            }
        };
        res.once('close', closer);
        res.once('finish', closer);
    
        var [err, out] = await to(Promise.all([connection.get("build-logs:" + id + ":" + timestamp), subscriber.subscribe(subscribable)]));
        if (err || !out || !out[0]) {
            res.status(404).send("Not found");
            return;
        }
    
        res.write(out[0]);
    
        const forwarder = (channel: string, message: string) => {
            if (channel === subscribable)
                res.write(message);
        }
    
        const emitter_listener = (jobId: string) => {
            if (jobId === id)
                res.end();
        }
    
        subscriber.on("message", forwarder);
        emitter.once('ended', emitter_listener);
    
        const jobs = await Promise.all([builder_queue.getJob(id), database_queue.getJob(id)]);
        var busy: boolean = false;
        for (const job of jobs) {
            if (!job || job.timestamp !== Number(timestamp))
                continue;
            const state = await job.getState();
            if (['active', 'waiting'].includes(state)) {
                busy = true;
                break;
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

    app.use(express.static('public'));

    app.listen(port, () => {
        console.log(`Web server listening on port ${port}`);
    });
}
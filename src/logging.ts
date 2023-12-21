import { Job, Queue } from 'bullmq';
import RedisConnection from 'ioredis';
import { splitJobId } from './utils';
import { JobData, SEVEN_DAYS } from './types';
import to from 'await-to-js';

// Console.log immitation that saves to a variable instead of stdout
export class SshLogger {
    logs: string[] = [];

    log(arg: any): void {
        this.logs.push(arg);
    }
    dump(): string {
        return this.logs.join('\n');
    }
}

export class BuildsRedisLogger {
    private init = false;
    private connection: RedisConnection;
    private channel: string = "";
    private key: string = "";
    private default_key: string = "";
    private timestamp: number = 0;

    constructor(connection: RedisConnection) {
        this.connection = connection;
    }

    public fromJob(job: Job) {
        var job_data = job.data as JobData;
        const { target_repo, pkgbase } = splitJobId(job.id as string);

        this.channel = "build-logs." + pkgbase + "." + job_data.timestamp;
        this.key = "build-logs:" + pkgbase + ":" + job_data.timestamp;
        this.default_key = "build-logs:" + pkgbase + ":default";
        this.timestamp = job_data.timestamp;
        this.init = true;
    }

    public async fromJobID(job_id: string, queue: Queue) {
        var [err, job] = await to(queue.getJob(job_id));
        if (err || !job) {
            const { target_repo, pkgbase } = splitJobId(job_id);
            this.default_key = "build-logs:" + pkgbase + ":default";

            var [err, out] = await to(this.connection.get(this.default_key));
            if (err || !out) {
                throw new Error("Job not found");
            } else {
                this.channel = "build-logs." + pkgbase + "." + out;
                this.key = "build-logs:" + pkgbase + ":" + out;
                this.timestamp = parseInt(out);
                this.init = true;
            }
        } else {
            this.fromJob(job);
        }
    }

    private internal_log(arg: Buffer, err: boolean = false): void {
        if (this.init === false)
            return console.warn("Logger not initialized");
        // Pipelining results in a single roundtrip to the server and this prevents requests from getting out of order
        var pipeline = this.connection.pipeline();
        pipeline.publish(this.channel, arg);
        pipeline.append(this.key, arg);
        pipeline.expire(this.key, 60 * 60 * 24 * 7); // 7 days
        pipeline.exec().catch(() => {});

        if (err)
            process.stderr.write(arg);
        else
            process.stdout.write(arg);
    }

    raw_log = this.internal_log;

    log(arg: any): void {
        // Convert to buffer
        this.internal_log(Buffer.from(arg + "\r\n"));
    }

    error(arg: any): void {
        // Convert to buffer
        this.internal_log(Buffer.from(arg + "\r\n"), true);
    }

    public async setDefault() {
        if (this.init === false)
            return console.warn("Logger not initialized");
        await this.connection.setex(this.default_key, SEVEN_DAYS, this.timestamp);
    }
}
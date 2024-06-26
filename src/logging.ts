import RedisConnection from "ioredis";
import to from "await-to-js";
import { BuildJobData } from "./types";
import { Job, MetricsTime, Queue } from "bullmq";
import { splitJobId } from "./utils";

// Console.log imitation that saves to a variable instead of stdout
export class SshLogger {
    logs: string[] = [];

    log(arg: any): void {
        this.logs.push(arg);
    }
    dump(): string {
        return this.logs.join("\n");
    }
}

export class BuildsRedisLogger {
    private init = false;
    private connection: RedisConnection;
    private channel = "";
    private key = "";
    private default_key = "";
    private timestamp = 0;

    constructor(connection: RedisConnection) {
        this.connection = connection;
    }

    public fromJob(job: Job) {
        const job_data = job.data as BuildJobData;
        const { target_repo, pkgbase } = splitJobId(job.id as string);

        this.channel = "build-logs." + pkgbase + "." + job_data.timestamp;
        this.key = "build-logs:" + pkgbase + ":" + job_data.timestamp;
        this.default_key = "build-logs:" + pkgbase + ":default";
        this.timestamp = job_data.timestamp;
        this.init = true;
    }

    public async fromJobID(job_id: string, queue: Queue): Promise<Job | undefined> {
        const [err, job] = await to(queue.getJob(job_id));
        if (err || !job) {
            const { target_repo, pkgbase } = splitJobId(job_id);
            this.default_key = "build-logs:" + pkgbase + ":default";

            const [err, out] = await to(this.connection.get(this.default_key));
            if (err || !out) {
                throw new Error("Job not found");
            } else {
                this.channel = "build-logs." + pkgbase + "." + out;
                this.key = "build-logs:" + pkgbase + ":" + out;
                this.timestamp = parseInt(out);
                this.init = true;
                return undefined;
            }
        } else {
            this.fromJob(job);
            return job;
        }
    }

    private internal_log(arg: string, err = false): void {
        if (!this.init) return console.warn("Logger not initialized");
        // Pipelining results in a single roundtrip to the server and this prevents requests from getting out of order
        const pipeline = this.connection.pipeline();
        pipeline.publish(this.channel, "LOG" + arg);
        pipeline.append(this.key, arg);
        pipeline.expire(this.key, 60 * 60 * 24 * 7); // 7 days
        void pipeline.exec();

        if (err) process.stderr.write(arg);
        else process.stdout.write(arg);
    }

    async end_log(): Promise<void> {
        await this.connection.publish(this.channel, "END");
    }

    raw_log = this.internal_log;

    log(arg: any): void {
        // Convert to buffer
        this.internal_log(arg + "\r\n");
    }

    error(arg: any): void {
        // Convert to buffer
        this.internal_log(arg + "\r\n", true);
    }

    public async setDefault() {
        if (!this.init) return console.warn("Logger not initialized");
        await this.connection.setex(this.default_key, MetricsTime.ONE_WEEK, this.timestamp);
    }
}

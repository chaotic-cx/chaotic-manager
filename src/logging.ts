import to from "await-to-js";
import type RedisConnection from "ioredis";
import { LoggerInstance } from "moleculer";

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
    private logger: LoggerInstance;

    constructor(connection: RedisConnection, logger: LoggerInstance) {
        this.connection = connection;
        this.logger = logger;
    }

    public async from(pkgbase: string, timestamp?: number) {
        this.default_key = "build-logs:" + pkgbase + ":default";

        if (timestamp === undefined) {
            const [err, out] = await to(this.connection.get(this.default_key));
            if (err || !out) throw new Error("Job not found");
            timestamp = Number.parseInt(out);
        }

        this.channel = "build-logs." + pkgbase + "." + timestamp;
        this.key = "build-logs:" + pkgbase + ":" + timestamp;
        this.timestamp = timestamp;
        this.init = true;
    }

    private internal_log(arg: string, err = false): void {
        if (!this.init) return this.logger.warn("Logger not initialized");
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
        if (!this.init) return this.logger.warn("Logger not initialized");
        await this.connection.set(this.default_key, this.timestamp, "EX", 60 * 60 * 24 * 7); // 7 days
    }
}

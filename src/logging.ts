import RedisConnection from 'ioredis';

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
    private connection: RedisConnection;
    private channel: string;
    private key: string;

    constructor(connection: RedisConnection, jobName: string, timestamp: number) {
        this.connection = connection;
        this.channel = "build-logs." + jobName + "." + timestamp;
        this.key = "build-logs:" + jobName + ":" + timestamp;
    }

    private internal_log(arg: Buffer, err: boolean = false): void {
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
}
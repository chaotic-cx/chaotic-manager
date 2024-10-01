import type RedisConnection from "ioredis";

export class RedisConnectionManager {
    private subscriber: RedisConnection | undefined;
    private clients: RedisConnection[] = [];
    constructor(private client: RedisConnection) {}

    public getClient(): RedisConnection {
        return this.client;
    }

    public getSubscriber(): RedisConnection {
        if (!this.subscriber) {
            this.subscriber = this.client.duplicate();
        }
        return this.subscriber;
    }

    public getNewClient(redisopts: any): RedisConnection {
        const newClient = this.client.duplicate(redisopts);
        this.clients.push(newClient);
        return newClient;
    }

    public shutdown(): void {
        this.clients.forEach((client) => client.disconnect());
        if (this.subscriber) this.subscriber.disconnect();
        this.client.disconnect();
    }
}

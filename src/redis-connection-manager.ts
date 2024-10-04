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
        this.clients.forEach((client: any) => {
            if (client.connector.stream) client.connector.stream.unref();
            else client.quit();
        });
        const subscriber: any = this.subscriber;
        if (subscriber) {
            if (subscriber.connector.stream) subscriber.connector.stream.unref();
            else subscriber.quit();
        }
        const client: any = this.client;
        if (client.connector.stream) client.connector.stream.unref();
        else client.quit();
    }
}

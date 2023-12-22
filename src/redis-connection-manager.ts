import RedisConnection from 'ioredis';

export class RedisConnectionManager {
    private subscriber: RedisConnection | undefined;
    constructor(private client: RedisConnection) {
    }

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
        return this.client.duplicate(redisopts);
    }
};
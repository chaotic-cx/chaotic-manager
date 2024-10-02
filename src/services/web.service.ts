import type { RequestOptions } from "https";
import * as http from "node:http";
import Timeout from "await-timeout";
import to from "await-to-js";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type RedisConnection from "ioredis";
import { type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import type { RedisConnectionManager } from "../redis-connection-manager";
import { HTTP_CACHE_MAX_AGE, type MetricsRequest, corsOptions } from "../types";
import { getDurationInMilliseconds } from "../utils";

export class WebService extends Service {
    private app = express();
    private chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");
    private httpLogger: LoggerInstance = this.broker.getLogger("HTTP");
    private connection: RedisConnection;
    private subscriber: RedisConnection;
    private server: http.Server | null = null;

    constructor(
        broker: ServiceBroker,
        private port: number,
        manager: RedisConnectionManager,
    ) {
        super(broker);

        this.connection = manager.getClient();
        this.subscriber = manager.getSubscriber();

        if (process.env.TRUST_PROXY) {
            this.app.set("trust proxy", process.env.TRUST_PROXY);
        }

        // Log HTTP requests if not explicitly denied
        if (!process.env.NO_HTTP_LOG) {
            this.app.use((req: Request, res: Response, next: NextFunction) => {
                // Measure time to answer
                const start: [number, number] = process.hrtime();

                const afterResponse = () => {
                    const untilAnswer = getDurationInMilliseconds(start);

                    res.removeListener("finish", afterResponse);
                    res.removeListener("close", afterResponse);
                    this.httpLogger.info(
                        `${req.method} ${req.ip} ${req.path} ${res.statusCode} ${untilAnswer.toLocaleString()}ms`,
                    );
                };

                res.on("finish", afterResponse);
                res.on("close", afterResponse);
                next();
            });
        }

        this.app.get("/api/logs/:id/:timestamp", this.getOrStreamLog.bind(this));
        this.app.get("/api/logs/:id", this.getOrStreamLogFromID.bind(this));
        this.app.get("/metrics", this.getMetrics.bind(this));
        this.app.get("/prometheus", cors(corsOptions), this.getPrometheusData.bind(this));

        // Error handling
        this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
            this.chaoticLogger.error(err.stack);
            res.status(500).send(
                "This application had a sudden increase of chaotic matters and couldn't serve your request!",
            );
        });

        this.app.use(
            express.static("public", {
                maxAge: HTTP_CACHE_MAX_AGE,
            }),
        );

        this.parseServiceSchema({
            name: "web",
            events: {
                "$broker.started": {
                    handler: this.start,
                },
            },
        });
    }

    private serverError(res: Response, code: number, message: string): void {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.status(code).send(message);
    }

    private async getOrStreamLog(req: Request, res: Response): Promise<any> {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Connection", "keep-alive");

        // Get variables, ensuring also packages with "+" in the name are getting parsed validly
        const id: string = req.params.id.replaceAll(/%2B/g, "+");
        const timestamp: string = req.params.timestamp;

        // Verify if the timestamp is a number and if id is alphanumerical or -/_ via regex
        if (!/^\d+$/.test(timestamp) || !/^[a-zA-Z0-9-_+]+$/.test(id)) {
            res.status(400).send("Invalid timestamp");
            return;
        }

        const unref: any[] = [];

        const subscribable = "build-logs." + id + "." + timestamp;

        const closer = () => {
            this.subscriber.unsubscribe(subscribable);
            for (const unrefable of unref) {
                res.removeListener("close", unrefable);
                res.removeListener("finish", unrefable);
                this.subscriber.removeListener("message", unrefable);
            }
        };
        unref.push(closer);
        res.once("close", closer);
        res.once("finish", closer);

        const [err, out] = await to(
            Promise.all([
                this.connection.get("build-logs:" + id + ":" + timestamp),
                this.subscriber.subscribe(subscribable),
            ]),
        );
        if (err || !out || !out[0]) {
            this.serverError(res, 404, "Not found");
            return;
        }

        res.write(out[0]);

        const forwarder = async (channel: string, message: string) => {
            if (channel === subscribable) {
                if (message == "END") {
                    await Timeout.set(1000);
                    try {
                        res.end();
                    } catch {
                        /* empty */
                    }
                } else res.write(message.substring(3));
            }
        };

        unref.push(forwarder);
        this.subscriber.on("message", forwarder);

        const build: boolean = await this.broker.call("coordinator.jobExists", {
            pkgbase: id,
            timestamp: Number(timestamp),
        });
        if (!build) {
            res.end();
        }
    }

    async getOrStreamLogFromID(req: Request, res: Response) {
        const [err, out] = await to(this.connection.get("build-logs:" + req.params.id + ":default"));
        if (err || !out) {
            this.serverError(res, 404, "Not found");
            return;
        }
        req.params.timestamp = out;
        return await this.getOrStreamLog(req, res);
    }

    async getPrometheusData(req: Request, res: Response) {
        const options: RequestOptions = {
            host: "127.0.0.1",
            port: 3030,
            path: "/metrics",
            method: "GET",
            headers: req.headers,
        };
        const forwardRequest = http
            .request(options, (pres) => {
                pres.setEncoding("utf8");
                if (pres.statusCode != null) {
                    res.writeHead(pres.statusCode);
                }
                pres.on("data", (chunk) => {
                    res.write(chunk);
                });
                pres.on("close", () => {
                    res.end();
                });
                pres.on("end", () => {
                    res.end();
                });
            })
            .on("error", (err: Error) => {
                this.chaoticLogger.error(err.message);
                try {
                    res.writeHead(500);
                    res.write(err.message);
                } catch (err: any) {
                    this.chaoticLogger.error(err.message);
                }
                res.end();
            });
        forwardRequest.end();
    }

    async getMetrics(req: Request, res: Response) {
        const [err, out] = await to(this.broker.call("chaotic-metrics.getMetrics"));
        if (err || !out) {
            this.chaoticLogger.error(err);
            this.serverError(res, 500, "Encountered an error while fetching metrics");
            return;
        }
        const metrics = out as MetricsRequest;
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.json(metrics);
    }

    async start() {
        this.server = this.app.listen(this.port);
    }

    stop() {
        this.server!.close();
        this.server = null;
    }

    stopped() {
        this.schema.stop.bind(this.schema)();
    }
}

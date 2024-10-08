import * as http from "node:http";
import Timeout from "await-timeout";
import to from "await-to-js";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type RedisConnection from "ioredis";
import { type BrokerNode, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import type { RedisConnectionManager } from "../redis-connection-manager";
import {
    corsOptions,
    HTTP_CACHE_MAX_AGE,
    type MetricsRequest,
    type MetricsReturnObject,
    type PackagesReturnObject,
    type StatsReturnObject,
    type ValidMetrics,
} from "../types";
import { getDurationInMilliseconds, getPureNodeName, isNumeric, isValidPkgbase } from "../utils";
import type { QueueStatus, TrackedJobs } from "./coordinator.service";

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

        this.app.get("/api/logs/:id", this.getOrStreamLogFromID.bind(this));
        this.app.get("/api/logs/:id/:timestamp", this.getOrStreamLog.bind(this));
        this.app.get("/api/queue/metrics", cors(corsOptions), this.getCountMetrics.bind(this));
        this.app.get("/api/queue/packages", cors(corsOptions), this.getPackageStats.bind(this));
        this.app.get("/api/queue/stats", cors(corsOptions), this.getQueueStats.bind(this));

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
                "$broker.stopped": {
                    handler: this.stop,
                },
            },
        });
    }

    private invalidLogRequest(res: Response): void {
        this.serverError(
            res,
            400,
            "\x1B[1;3;31mParameters are invalid or no parameters provided. Did you copy the querystring?\x1B[0m ",
        );
    }
    private notFoundLogRequest(res: Response): void {
        this.serverError(res, 404, "\x1B[1;3;31mBuild task not found\x1B[0m ");
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

        const id: string = req.params.id;
        const timestamp: string = req.params.timestamp;

        // Verify if the timestamp is a number and if id is valid
        if (!isNumeric(timestamp) || !isValidPkgbase(id)) {
            return this.invalidLogRequest(res);
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
            return this.notFoundLogRequest(res);
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
        // Verify if the id is valid
        if (!isValidPkgbase(req.params.id)) {
            return this.invalidLogRequest(res);
        }
        const [err, out] = await to(this.connection.get("build-logs:" + req.params.id + ":default"));
        if (err || !out) {
            return this.notFoundLogRequest(res);
        }
        req.params.timestamp = out;
        return await this.getOrStreamLog(req, res);
    }

    async getCountMetrics(req: Request, res: Response) {
        const request: ValidMetrics[] = [
            "builders.active",
            "builders.idle",
            "builds.alreadyBuilt",
            "builds.cancelled",
            "builds.failed.build",
            "builds.failed.software",
            "builds.failed.timeout",
            "builds.skipped",
            "builds.success",
            "builds.time.elapsed",
            "builds.total",
            "queue.current",
        ];

        const [errMetrics, outMetrics] = await to(
            this.broker.call<MetricsRequest, ValidMetrics[]>("chaoticMetrics.getMetrics", request),
        );

        if (errMetrics || !outMetrics) {
            errMetrics && this.chaoticLogger.error(errMetrics);
            this.serverError(res, 500, "Encountered an error while fetching metrics");
            this.chaoticLogger.error(errMetrics);
            return;
        }

        const returnValue: MetricsReturnObject = {
            builder_queue: {
                completed: outMetrics["builds.success"]!.value ? outMetrics["builds.success"]!.value : 0,
                failed:
                    outMetrics["builds.failed.build"]!.value +
                    outMetrics["builds.failed.software"]!.value +
                    outMetrics["builds.failed.timeout"]!.value,
            },
            database_queue: {
                completed: outMetrics["builds.success"]!.value ? outMetrics["builds.success"]!.value : 0,
                failed:
                    outMetrics["builds.failed.build"]!.value +
                    outMetrics["builds.failed.software"]!.value +
                    outMetrics["builds.failed.timeout"]!.value,
            },
        };

        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.json(returnValue);
    }

    async getPackageStats(req: Request, res: Response) {
        const [errQueue, outQueue] = await to(this.broker.call<TrackedJobs>("coordinator.getQueue"));
        if (errQueue || !outQueue) {
            this.serverError(res, 500, "Failed to fetch package stats");
            this.chaoticLogger.error(errQueue);
            return;
        }

        const packageReturn: PackagesReturnObject = [];
        for (const queueItem of Object.values(outQueue)) {
            this.chaoticLogger.debug(queueItem);
            packageReturn.push({
                [queueItem.pkgbase]: {
                    arch: queueItem.arch,
                    build_class: queueItem.build_class,
                    srcrepo: queueItem.target_repo,
                    timestamp: queueItem.timestamp,
                },
            });
        }

        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.json(packageReturn);
    }

    async getQueueStats(req: Request, res: Response) {
        const [errStats, outStats] = await to(this.broker.call<QueueStatus>("coordinator.getQueue"));
        const [errNodes, outNodes] = await to(this.broker.call<BrokerNode[]>("coordinator.getAvailableNodes"));

        if (errStats || errNodes || !outStats) {
            this.serverError(res, 500, "Failed to fetch queue stats");
            this.chaoticLogger.error(errStats);
            return;
        }

        const statsReturn: StatsReturnObject = {
            active: { count: 0, packages: [] },
            waiting: { count: 0, packages: [] },
            idle: {
                count: outNodes ? outNodes.length : 0,
                nodes: outNodes
                    ? outNodes.map((node) => {
                          return {
                              name: getPureNodeName(node.id),
                              build_class:
                                  node.metadata?.build_class !== undefined ? node.metadata?.build_class : "unknown",
                          };
                      })
                    : [],
            },
        };
        this.chaoticLogger.debug(outStats);
        this.chaoticLogger.debug(statsReturn);

        outStats.forEach((value) => {
            if (value.status === "active") {
                statsReturn.active.count += 1;
                statsReturn.active.packages?.push({
                    name: value.jobData.toId(),
                    node: getPureNodeName(value.node!),
                    build_class: value.buildClass,
                    liveLog: value.liveLogUrl,
                });
            } else {
                statsReturn.waiting.count += 1;
                statsReturn.waiting.packages?.push({ name: value.jobData.toId(), build_class: value.buildClass });
            }
        });

        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.json(statsReturn);
    }

    async start() {
        this.server = this.app.listen(this.port);
    }

    stop() {
        if (this.server) {
            this.server.close();
        }
        this.server = null;
    }
}

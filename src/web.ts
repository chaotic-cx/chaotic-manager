import Timeout from "await-timeout";
import to from "await-to-js";
// import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { RedisConnectionManager } from "./redis-connection-manager";
import { corsOptions, HTTP_CACHE_MAX_AGE } from "./types";
import { LoggerInstance, ServiceBroker } from "moleculer";
import { getDurationInMilliseconds } from "./utils";
import cors from "cors";
import * as http from "node:http";
import { RequestOptions } from "node:http";

export async function startWebServer(broker: ServiceBroker, port: number, manager: RedisConnectionManager) {
    const connection = manager.getClient();
    const subscriber = manager.getSubscriber();

    const chaoticLogger: LoggerInstance = broker.getLogger("CHAOTIC");
    const httpLogger: LoggerInstance = broker.getLogger("HTTP");

    /*const chaoticApi: ChaoticApi = new ChaoticApi({
        builderQueue: builder_queue,
        databaseQueue: database_queue,
    });*/

    const app = express();

    // If behind a proxy
    if (process.env.TRUST_PROXY) {
        app.set("trust proxy", process.env.TRUST_PROXY);
    }

    // Log HTTP requests if not explicitly denied
    if (!process.env.NO_HTTP_LOG) {
        app.use(function (req: Request, res: Response, next: NextFunction) {
            // Measure time to answer
            const start: [number, number] = process.hrtime();

            function afterResponse() {
                const untilAnswer = getDurationInMilliseconds(start);

                res.removeListener("finish", afterResponse);
                res.removeListener("close", afterResponse);
                httpLogger.info(
                    `${req.method} ${req.ip} ${req.path} ${res.statusCode} ${untilAnswer.toLocaleString()}ms`,
                );
            }

            res.on("finish", afterResponse);
            res.on("close", afterResponse);
            next();
        });
    }

    function serverError(res: Response, code: number, message: string): void {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Content-Type", "text/plain");
        res.status(code).send(message);
    }

    async function getOrStreamLog(req: Request, res: Response): Promise<any> {
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
            subscriber.unsubscribe(subscribable);
            for (const unrefable of unref) {
                res.removeListener("close", unrefable);
                res.removeListener("finish", unrefable);
                subscriber.removeListener("message", unrefable);
            }
        };
        unref.push(closer);
        res.once("close", closer);
        res.once("finish", closer);

        const [err, out] = await to(
            Promise.all([connection.get("build-logs:" + id + ":" + timestamp), subscriber.subscribe(subscribable)]),
        );
        if (err || !out || !out[0]) {
            serverError(res, 404, "Not found");
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
        subscriber.on("message", forwarder);

        const build: boolean = await broker.call("coordinator.jobExists", {
            pkgbase: id,
            timestamp: Number(timestamp),
        });
        if (!build) {
            res.end();
        }
    }

    app.get("/api/logs/:id/:timestamp", getOrStreamLog);

    app.get("/api/logs/:id", async (req: Request, res: Response) => {
        const [err, out] = await to(connection.get("build-logs:" + req.params.id + ":default"));
        if (err || !out) {
            serverError(res, 404, "Not found");
            return;
        }
        req.params.timestamp = out;
        return await getOrStreamLog(req, res);
    });

    /*app.get("/api/queue/stats", cors(corsOptions), async (req: Request, res: Response): Promise<Response> => {
        const [err, out] = await to(chaoticApi.buildStatsObject());
        if (err || !out) {
            serverError(res, 500, "Internal server error");
            return res;
        }
        return res.json(out);
    });

    app.get("/api/queue/packages", cors(corsOptions), async (req: Request, res: Response): Promise<Response> => {
        const [err, out] = await to(chaoticApi.buildPackagesObject());
        if (err || !out) {
            serverError(res, 500, "Internal server error");
            return res;
        }
        return res.json(out);
    });

    app.get("/api/queue/metrics", cors(corsOptions), async (req: Request, res: Response): Promise<Response> => {
        const [err, out] = await to(chaoticApi.buildMetricsObject());
        if (err || !out) {
            serverError(res, 500, "Internal server error");
            return res;
        }
        return res.json(out);
    });*/

    // Forward Prometheus metrics to the metrics endpoint of the app server
    app.get("/metrics", cors(corsOptions), (req: Request, res: Response) => {
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
                chaoticLogger.error(err.message);
                try {
                    res.writeHead(500);
                    res.write(err.message);
                } catch (err: any) {
                    chaoticLogger.error(err.message);
                }
                res.end();
            });
        forwardRequest.end();
    });

    // Error handling
    app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        chaoticLogger.error(err.stack);
        res.status(500).send(
            "This application had a sudden increase of chaotic matters and couldn't serve your request!",
        );
    });

    app.use(
        express.static("public", {
            maxAge: HTTP_CACHE_MAX_AGE,
        }),
    );

    const server = app.listen(port, () => {
        chaoticLogger.info(`Web server listening on port ${port}`);
    });
}

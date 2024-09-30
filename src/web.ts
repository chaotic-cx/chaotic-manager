import Timeout from "await-timeout";
import to from "await-to-js";
// import cors from "cors";
import express, { type Request, type Response } from "express";
// import { register } from "prom-client";
// import { ChaoticApi } from "./api";
// import { getMetrics } from "./prometheus";
import type { RedisConnectionManager } from "./redis-connection-manager";
import { corsOptions, HTTP_CACHE_MAX_AGE } from "./types";
import { LoggerInstance, ServiceBroker } from "moleculer";

export async function startWebServer(broker: ServiceBroker, port: number, manager: RedisConnectionManager, logger: LoggerInstance) {
    const connection = manager.getClient();
    const subscriber = manager.getSubscriber();

    /*const chaoticApi: ChaoticApi = new ChaoticApi({
        builderQueue: builder_queue,
        databaseQueue: database_queue,
    });*/

    const app = express();

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

        let build: boolean = await broker.call("coordinator.jobExists", { pkgbase: id, timestamp: Number(timestamp) });
        if (!build) {
            res.end();
        }
    };

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
    });

    app.get("/metrics", cors(corsOptions), async (req: Request, res: Response): Promise<Response> => {
        const [err, out] = await to(getMetrics(builder_queue, database_queue));
        if (err || !out) {
            serverError(res, 500, "Internal server error");
            return res;
        }
        res.setHeader("Content-Type", register.contentType);
        return res.send(out);
    });*/

    app.use(
        express.static("public", {
            maxAge: HTTP_CACHE_MAX_AGE,
        }),
    );

    let server = app.listen(port, () => {
        logger.info(`Web server listening on port ${port}`);
    });
}

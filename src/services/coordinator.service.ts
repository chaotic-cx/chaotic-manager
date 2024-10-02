import { Mutex } from "async-mutex";
import { DepGraph } from "dependency-graph";
import { type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import { BuildsRedisLogger } from "../logging";
import type { RedisConnectionManager } from "../redis-connection-manager";
import { type Repo, RepoManager, type TargetRepo } from "../repo-manager";
import {
    BuildStatus,
    type BuildStatusReturn,
    type Builder_Action_BuildPackage_Params,
    CoordinatorJob,
    type CoordinatorJobSavable,
    type Coordinator_Action_AddJobsToQueue_Params,
    type Coordinator_Action_AutoRepoRemove_Params,
    type DatabaseRemoveStatusReturn,
    type Database_Action_AutoRepoRemove_Params,
    type Database_Action_fetchUploadInfo_Response,
    type FailureNotificationParams,
    type MetricsCounterLabels,
    type SuccessNotificationParams,
    current_version,
} from "../types";
import { currentTime } from "../utils";
import { MoleculerConfigCommonService } from "./moleculer.config";

class CoordinatorTrackedJob extends CoordinatorJob {
    replacement?: CoordinatorTrackedJob;
    redisLogger: BuildsRedisLogger;
    node?: string;
    timer?: any;

    constructor(
        pkgbase: string,
        target_repo: string,
        source_repo: string,
        arch: string,
        build_class: number,
        pkgnames: string[] | undefined,
        dependencies: string[] | undefined,
        commit: string | undefined,
        timestamp: number,
        redisLogger: BuildsRedisLogger,
        timer?: any,
    ) {
        super(pkgbase, target_repo, source_repo, arch, build_class, pkgnames, dependencies, commit, timestamp);
        this.redisLogger = redisLogger;
        this.node = undefined;

        if (timer) this.timer = timer;
    }

    toSavable(): CoordinatorJob {
        if (this.replacement) return this.replacement.toSavable();
        const base: any = structuredClone(this);
        delete base.logger;
        delete base.node;
        delete base.timestamp;
        return base;
    }
}

function toTracked(job: CoordinatorJobSavable, timestamp: number, logger: BuildsRedisLogger): CoordinatorTrackedJob {
    const ret: any = job;
    ret.timestamp = timestamp;
    ret.logger = logger;
    ret.logger.from(ret.pkgbase, ret.timestamp);
    return ret;
}

/**
 * The coordinator service is responsible for managing the build queue and assigning jobs to the builder nodes.
 */
export class CoordinatorService extends Service {
    base_logs_url = process.env.LOGS_URL;
    package_repos = process.env.PACKAGE_REPOS;
    package_target_repos = process.env.PACKAGE_TARGET_REPOS;
    package_repos_notifiers = process.env.PACKAGE_REPOS_NOTIFIERS;
    builder_image =
        process.env.BUILDER_IMAGE || "registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest";

    queue: { [key: string]: CoordinatorTrackedJob } = {};
    redis_connection_manager: RedisConnectionManager;
    repo_manager: RepoManager;
    busy_nodes: { [key: string]: CoordinatorTrackedJob } = {};
    mutex: Mutex = new Mutex();
    chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");

    active = false;

    constructor(broker: ServiceBroker, redis_connection_manager: RedisConnectionManager) {
        super(broker);

        this.repo_manager = new RepoManager(
            this.base_logs_url ? new URL(this.base_logs_url) : undefined,
            this.chaoticLogger,
        );
        this.initRepoManager(this.repo_manager);
        this.redis_connection_manager = redis_connection_manager;

        this.chaoticLogger.debug(this.redis_connection_manager);

        this.parseServiceSchema({
            name: "coordinator",

            actions: {
                addJobsToQueue: this.addJobsToQueue,
                autoRepoRemove: this.autoRepoRemove,
                jobExists: this.jobExists,
            },
            events: {
                "$node.connected": {
                    handler: this.assignJobs,
                },
                started: {
                    handler: this.start,
                },
                stopped: {
                    handler: this.stop,
                },
            },
            ...MoleculerConfigCommonService,
        });
    }

    /**
     * Fetches the upload information from the database, containing all necessary information to connect to the target
     * server via SCP.
     * @returns The upload information as a response object.
     */
    async getUploadInfo(): Promise<Database_Action_fetchUploadInfo_Response> {
        return this.broker.call("database.fetchUploadInfo");
    }

    /**
     * Handles the completion of a job, updating the job status and notifying the source repository.
     * Also handles the increase of metrics counters.
     * @param promise The promise that resolves to the build status.
     * @param job The job that was completed, containing all necessary information.
     * @param source_repo The source repository of the job.
     * @param node_id The ID of the node that executed the job.
     * @private
     */
    private onJobComplete(
        promise: Promise<BuildStatusReturn>,
        job: CoordinatorTrackedJob,
        source_repo: Repo,
        node_id: string,
    ): void {
        const metricsParams: MetricsCounterLabels = {
            pkgname: job.pkgbase,
            target_repo: job.target_repo,
            replaced: false,
            build_class: job.build_class,
            arch: job.arch,
        };

        promise
            .then((ret: BuildStatusReturn) => {
                switch (ret.success) {
                    case BuildStatus.ALREADY_BUILT: {
                        void source_repo.notify(job, "canceled", "Build skipped because package was already built.");
                        job.redisLogger.log(`Job ${job.toId()} skipped because all packages were already built.`);

                        metricsParams.status = BuildStatus.ALREADY_BUILT;
                        void this.broker.call("chaotic-metrics.incCounterAlreadyBuilt", metricsParams);
                        break;
                    }
                    case BuildStatus.SUCCESS: {
                        void source_repo.notify(job, "success", "Package successfully deployed.");
                        job.redisLogger.log(`Build job ${job.toId()} finished at ${currentTime()}...`);

                        const notify_params: SuccessNotificationParams = {
                            packages: ret.packages!,
                            event: `📣 New deployment to ${job.target_repo}`,
                        };
                        void this.broker.call("notifier.notifyPackages", notify_params);

                        metricsParams.status = BuildStatus.SUCCESS;
                        void this.broker.call("chaotic-metrics.incCounterBuildSuccess", metricsParams);
                        break;
                    }
                    case BuildStatus.SKIPPED: {
                        void source_repo.notify(job, "canceled", "Build skipped intentionally via build tools.");
                        job.redisLogger.log(`Job ${job.toId()} skipped intentionally via build tools.`);

                        metricsParams.status = BuildStatus.SKIPPED;
                        void this.broker.call("chaotic-metrics.incCounterBuildSkipped", metricsParams);
                        break;
                    }
                    case BuildStatus.FAILED: {
                        void source_repo.notify(job, "failed", "Build failed.");
                        job.redisLogger.log(`Job ${job.toId()} failed`);

                        const notify_params: FailureNotificationParams = {
                            pkgbase: job.pkgbase,
                            event: `🚨 Failed deploying to ${job.target_repo}`,
                            source_repo_url: source_repo.getUrl(),
                            timestamp: job.timestamp,
                            commit: job.commit,
                        };
                        void this.broker.call("notifier.notifyFailure", notify_params);

                        metricsParams.status = BuildStatus.FAILED;
                        void this.broker.call("chaotic-metrics.incCounterBuildFailure", metricsParams);
                        break;
                    }
                    case BuildStatus.CANCELED: {
                        metricsParams.status = BuildStatus.CANCELED;

                        if (job.replacement) {
                            void source_repo.notify(job, "canceled", "Build canceled and replaced.");
                            job.redisLogger.log(
                                `Job ${job.toId()} was canceled and replaced by a newer build request.`,
                            );
                            metricsParams.replaced = true;
                            void this.broker.call("chaotic-metrics.incCounterBuildCancelled", metricsParams);
                        } else {
                            void source_repo.notify(job, "canceled", "Build canceled.");
                            job.redisLogger.log(`Job ${job.toId()} was canceled.`);
                            void this.broker.call("chaotic-metrics.incCounterBuildCancelled", metricsParams);
                        }
                        break;
                    }
                    case BuildStatus.TIMED_OUT: {
                        void source_repo.notify(job, "failed", "Build timed out.");
                        job.redisLogger.log(`Job ${job.toId()} reached a timeout during the build phase.`);

                        const notify_params: FailureNotificationParams = {
                            pkgbase: job.pkgbase,
                            event: `⏳ Build for ${job.target_repo} failed due to a timeout`,
                            source_repo_url: source_repo.getUrl(),
                            timestamp: job.timestamp,
                            commit: job.commit,
                        };
                        void this.broker.call("notifier.notifyFailure", notify_params);

                        metricsParams.status = BuildStatus.TIMED_OUT;
                        void this.broker.call("chaotic-metrics.incCounterBuildTimeout", metricsParams);
                        break;
                    }
                }
            })
            .catch((err) => {
                this.chaoticLogger.error("Failed during package deployment:", err);
                void source_repo.notify(job, "failed", "Build failed.");
                job.redisLogger.log(`Job ${job?.toId()} failed`);

                const notify_params: FailureNotificationParams = {
                    pkgbase: job.pkgbase,
                    event: `💥 The code blew up while deploying to ${job.target_repo}`,
                    source_repo_url: source_repo.getUrl(),
                    timestamp: job.timestamp,
                    commit: job.commit,
                };
                void this.broker.call("notifier.notifyFailure", notify_params);

                metricsParams.status = BuildStatus.SOFTWARE_FAILURE;
                void this.broker.call("chaotic-metrics.incCounterSoftwareFailure", metricsParams);
            })
            .finally(() => {
                void this.broker.call("chaotic-metrics.incCounterBuildTotal", metricsParams);
                if (job.timer) job.timer();

                void job.redisLogger.end_log();
                const job_id = job.toId();
                if (job.replacement) this.queue[job_id] = job.replacement;
                else delete this.queue[job_id];
                delete this.busy_nodes[node_id];
                void this.assignJobs();
            });
    }

    /**
     * Assigns jobs to the available builder nodes.
     * This includes fetching the list of available builder nodes, generating a dependency graph of the jobs,
     * and assigning jobs to the nodes based on their build class.
     * @private
     */
    private async assignJobs(): Promise<void> {
        if (!this.active) return;
        await this.mutex.runExclusive(async () => {
            // Fetch the list of available builder nodes
            const services: any[] = await this.broker.call("$node.services");
            let nodes: string[] | undefined;
            for (const entry of services) {
                if (entry.name === "builder") {
                    nodes = entry.nodes;
                    break;
                }
            }

            // If no builder nodes are available, we log a warning and return
            if (!nodes || nodes.length == 0) {
                this.chaoticLogger.warn("No builder nodes available.");
                return;
            }

            // Fetch the full list of nodes
            const full_node_list: any[] = await this.broker.call("$node.list");
            if (!full_node_list || full_node_list.length == 0) {
                return;
            }

            // nodes.includes(node.id) -> check if the node is in the list of builder nodes
            // node.available -> check if the node is available (not offline)
            // !this.busy_nodes[node.id] -> check if the node is not in the list of busy nodes
            const available_nodes: any[] = full_node_list.filter(
                (node: any) => nodes.includes(node.id) && node.available && !this.busy_nodes[node.id],
            );

            if (available_nodes.length == 0) {
                return;
            }

            const graph: DepGraph<CoordinatorTrackedJob> = this.constructDependencyGraph(this.queue);
            const upload_info: Database_Action_fetchUploadInfo_Response = await this.getUploadInfo();

            for (const node of available_nodes) {
                const jobs: CoordinatorTrackedJob[] = this.getPossibleJobs(graph, node.metadata.build_class);
                if (jobs.length == 0) {
                    continue;
                }
                const job: CoordinatorTrackedJob | undefined = jobs.shift();
                if (!job) {
                    continue;
                }

                this.busy_nodes[node.id] = job;
                const source_repo: Repo = this.repo_manager.getRepo(job.source_repo);
                const target_repo: TargetRepo = this.repo_manager.getTargetRepo(job.target_repo);
                const params: Builder_Action_BuildPackage_Params = {
                    pkgbase: job.pkgbase,
                    target_repo: job.target_repo,
                    source_repo: job.source_repo,
                    source_repo_url: source_repo.getUrl(),
                    extra_repos: target_repo.repoToString(),
                    extra_keyrings: target_repo.keyringsToBashArray(),
                    arch: job.arch,
                    builder_image: this.builder_image,
                    upload_info,
                    timestamp: job.timestamp,
                    commit: job.commit,
                };

                job.node = node.id;

                const promise = this.broker.call<BuildStatusReturn, Builder_Action_BuildPackage_Params>(
                    "builder.buildPackage",
                    params,
                    {
                        nodeID: node.id,
                    },
                );
                this.onJobComplete(promise, job, source_repo, node.id);
            }
        });
    }

    /**
     * Adds new jobs to the queue.
     * @param ctx The Moleculer context object.
     */
    async addJobsToQueue(ctx: Context): Promise<void> {
        const timestamp: number = Date.now();
        const data = ctx.params as Coordinator_Action_AddJobsToQueue_Params;
        const jobs: CoordinatorTrackedJob[] = [];

        const redis = this.redis_connection_manager.getClient();

        for (const pkg of data.packages) {
            const logger = new BuildsRedisLogger(redis, this.chaoticLogger);
            logger.from(pkg.pkgbase, timestamp);
            jobs.push(
                new CoordinatorTrackedJob(
                    pkg.pkgbase,
                    data.target_repo,
                    data.source_repo,
                    data.arch,
                    pkg.build_class || 1,
                    pkg.pkgnames,
                    pkg.dependencies,
                    data.commit,
                    timestamp,
                    logger,
                ),
            );
        }

        for (const job of jobs) {
            const log = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.chaoticLogger);
            log.from(job.pkgbase, job.timestamp);
            void (async () => {
                await log.setDefault();
                log.log(`Added to build queue at ${currentTime()}. Waiting for builder...`);
                this.chaoticLogger.info(`Added job for ${job.pkgbase} to the build queue.`);
            })();

            const id = job.toId();
            const entry = this.queue[id];
            // Is queued
            if (entry) {
                // Is running
                if (entry.node) {
                    void ctx.call("builder.cancelBuild", undefined, { nodeID: entry.node });
                    entry.redisLogger.log(
                        `Job cancellation requested at ${currentTime()}. Job is being replaced by newer build request.`,
                    );
                    this.chaoticLogger.info(
                        `Job for ${job.pkgbase} was canceled and replaced with a new job before execution.`,
                    );
                    entry.replacement = job;
                    continue;
                    // Not running
                } else {
                    await (async () => {
                        entry.redisLogger.log(`Job was canceled and replaced with a new job before execution.`);
                        this.chaoticLogger.info(
                            `Job for ${job.pkgbase} canceled and replaced with a new job before execution.`,
                        );
                        await entry.redisLogger.end_log();
                    })();
                }
            }
            this.queue[id] = job;
        }

        void this.assignJobs();
    }

    /**
     * Schedules a cleanup job for a repository, handling eventual outcomes.
     * @param ctx The Moleculer context object.
     */
    async autoRepoRemove(ctx: Context): Promise<void> {
        const data = ctx.params as Coordinator_Action_AutoRepoRemove_Params;
        const request: Database_Action_AutoRepoRemove_Params = {
            builder_image: this.builder_image,
            ...data,
        };
        const result = await this.broker.call<DatabaseRemoveStatusReturn, Database_Action_AutoRepoRemove_Params>(
            "database.autoRepoRemove",
            request,
        );

        if (result.success) {
            await this.broker.call("notifier.notifyGeneric", {
                message: `✅ Cleanup job for ${data.repo} finished successfully`,
            });
        } else {
            await this.broker.call("notifier.notifyGeneric", {
                message: `🚫 Cleanup job ${data.repo} failed to remove packages`,
            });
        }
    }

    /**
     * Initializes the repository manager with the given configuration.
     * @param repo_manager The repository manager instance.
     * @private
     */
    private initRepoManager(repo_manager: RepoManager): void {
        if (this.package_repos) {
            try {
                const obj = JSON.parse(this.package_repos);
                repo_manager.repoFromObject(obj);
            } catch (error) {
                this.chaoticLogger.error(error);
                throw new Error("Invalid package repos.");
            }
        }

        if (!this.package_repos) {
            repo_manager.repoFromObject({
                "chaotic-aur": {
                    url: "https://gitlab.com/chaotic-aur/pkgbuilds",
                },
            });
        }

        if (this.package_target_repos) {
            try {
                const obj = JSON.parse(this.package_target_repos);
                repo_manager.targetRepoFromObject(obj);
            } catch (error) {
                this.chaoticLogger.error(error);
                throw new Error("Invalid package repos.");
            }
        }

        if (!this.package_target_repos) {
            repo_manager.targetRepoFromObject({
                "chaotic-aur": {
                    extra_repos: [
                        {
                            name: "chaotic-aur",
                            servers: ["https://builds.garudalinux.org/repos/$repo/$arch"],
                        },
                    ],
                    extra_keyrings: ["https://cdn-mirror.chaotic.cx/chaotic-aur/chaotic-keyring.pkg.tar.zst"],
                },
            });
        }

        if (this.package_repos_notifiers) {
            try {
                const obj = JSON.parse(this.package_repos_notifiers);
                repo_manager.notifiersFromObject(obj);
            } catch (error) {
                this.chaoticLogger.error(error);
            }
        }
    }

    /**
     * Constructs a dependency graph for the given queue.
     * @param queue The queue of jobs as a dictionary.
     * @returns The dependency graph as a DepGraph object.
     * @private
     */
    private constructDependencyGraph(queue: { [key: string]: CoordinatorTrackedJob }): DepGraph<CoordinatorTrackedJob> {
        const graph = new DepGraph<CoordinatorTrackedJob>({ circular: true });
        const mapped_pkgbases = new Map<string, string>(); // pkgname -> pkgbase
        const mapped_deps = new Map<string, string[]>(); // pkgbase -> [dependencies]

        for (const job of Object.values(queue)) {
            const job_ident = `${job.target_repo}/${job.pkgbase}`;
            graph.addNode(job_ident, job);

            if (!job.pkgnames || !job.dependencies) break;

            for (const name of job.pkgnames) {
                mapped_pkgbases.set(name, job_ident);
            }
            mapped_deps.set(job_ident, job.dependencies);
        }

        for (const [job_ident, deps] of mapped_deps) {
            for (const dep of deps) {
                const dep_pkgbase = mapped_pkgbases.get(dep);

                // We do not know of this dependency, so we skip it
                if (!dep_pkgbase) continue;
                graph.addDependency(job_ident, dep_pkgbase);
            }
        }

        return graph;
    }

    /**
     * Returns a list of possible jobs that can be assigned to a builder node.
     * @param graph The dependency graph of the jobs.
     * @param builder_class The builder class of the node. Jobs with a build class higher than this value will be ignored.
     * @returns A list of possible jobs that can be assigned to the builder node.
     * @private
     */
    private getPossibleJobs(graph: DepGraph<CoordinatorTrackedJob>, builder_class: number): CoordinatorTrackedJob[] {
        const jobs: CoordinatorTrackedJob[] = [];
        const nodes: string[] = graph.overallOrder(true);

        for (const node of nodes) {
            const job: CoordinatorTrackedJob = graph.getNodeData(node);
            if (job.build_class <= builder_class) {
                jobs.push(job);
            }
        }

        return jobs;
    }

    /**
     * Checks if a job exists in the queue.
     * @param ctx The Moleculer context object.
     * @returns True if the job exists, false otherwise.
     */
    public jobExists(ctx: Context): boolean {
        const data: { pkgbase: string; timestamp: number } = ctx.params as any;
        for (const job of Object.values(this.queue)) {
            if (job.pkgbase === data.pkgbase && job.timestamp === data.timestamp) {
                return true;
            }
        }
        return false;
    }

    /**
     * Saves the current build queue to the Redis database.
     * @private
     */
    private async saveQueue(): Promise<void> {
        const save_queue: CoordinatorJob[] = [];
        for (const job of Object.values(this.queue)) {
            save_queue.push(job.toSavable());
        }
        await this.redis_connection_manager.getClient().set(
            "build-queue",
            JSON.stringify({
                save_queue,
                version: current_version,
            }),
        );
    }

    /**
     * Restores the build queue from the Redis database.
     */
    async start(): Promise<void> {
        const timestamp = Date.now();
        const client = this.redis_connection_manager.getClient();
        try {
            const queue = await client.get("build-queue");
            if (queue) {
                const data = JSON.parse(queue);
                if (data.version === current_version) {
                    for (const savedJob of data.save_queue) {
                        const logger = new BuildsRedisLogger(client, this.chaoticLogger);
                        const job = toTracked(savedJob, timestamp, logger);
                        const id = job.toId();
                        job.redisLogger.log(`Restored job ${id} at ${currentTime()}`);
                        this.chaoticLogger.info(`Restored job ${id} for ${job.pkgbase}`);
                        this.queue[id] = job;
                    }
                }
            }
        } catch (error) {
            this.chaoticLogger.error("Error restoring build queue:", error);
        }

        this.broker.waitForServices(["$node"]).then(() => {
            this.active = true;
            void this.assignJobs();
        });
    }

    /**
     * Stops the coordinator service, canceling all running jobs. Also saves the current build queue to the Redis database.
     */
    async stop(): Promise<void> {
        // Make sure no new scheduler jobs are started
        this.active = false;

        await this.saveQueue();

        const promises: Promise<void>[] = [];
        for (const job of Object.values(this.queue)) {
            if (job.node) {
                job.redisLogger.log(`Job cancellation requested at ${currentTime()}. Coordinator is shutting down.`);
                this.chaoticLogger.info(
                    `Job for ${job.pkgbase} was canceled before execution. Coordinator is shutting down.`,
                );
                promises.push(this.broker.call("builder.cancelBuild", undefined, { nodeID: job.node }));
            } else {
                job.redisLogger.log(`Job was canceled before execution. Coordinator is shutting down.`);
                this.chaoticLogger.info(
                    `Job for ${job.pkgbase} canceled before execution. Coordinator is shutting down.`,
                );
            }
        }

        await Promise.all(promises);
    }
}

export default CoordinatorService;

import { Mutex } from "async-mutex";
import { DepGraph } from "dependency-graph";
import type Redis from "ioredis";
import { type BrokerNode, type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import { BuildsRedisLogger } from "../logging";
import type { RedisConnectionManager } from "../redis-connection-manager";
import { type Repo, RepoManager, type TargetRepo } from "../repo-manager";
import {
    type BuildClass,
    type Builder_Action_BuildPackage_Params,
    BuildStatus,
    type BuildStatusReturn,
    type Coordinator_Action_AddJobsToQueue_Params,
    type Coordinator_Action_AutoRepoRemove_Params,
    CoordinatorJob,
    CoordinatorJobSavable,
    current_version,
    type Database_Action_AutoRepoRemove_Params,
    type Database_Action_fetchUploadInfo_Response,
    type DatabaseRemoveStatusReturn,
    type DeploymentNotificationParams,
    type GenericNotificationParams,
    MAX_SHUTDOWN_TIME,
    type MetricsCounterLabels,
    type MetricsGaugeContext,
} from "../types";
import { currentTime, getLogUrl, getPureNodeName, isValidPkgbase } from "../utils";
import { MoleculerConfigCommonService } from "./moleculer.config";

export class CoordinatorTrackedJob extends CoordinatorJob {
    replacement?: CoordinatorTrackedJob;
    node?: string;

    constructor(
        pkgbase: string,
        target_repo: string,
        source_repo: string,
        arch: string,
        build_class: BuildClass,
        pkgnames: string[] | undefined,
        dependencies: string[] | undefined,
        commit: string | undefined,
        timestamp: number,
        public logger: BuildsRedisLogger,
    ) {
        super(pkgbase, target_repo, source_repo, arch, build_class, pkgnames, dependencies, commit, timestamp);
        this.node = undefined;
    }

    toSavable(): CoordinatorJobSavable {
        if (this.replacement) return this.replacement.toSavable();
        return new CoordinatorJobSavable(
            this.pkgbase,
            this.target_repo,
            this.source_repo,
            this.arch,
            this.build_class,
            this.pkgnames,
            this.dependencies,
            this.commit,
        );
    }
}

function toTracked(job: CoordinatorJobSavable, timestamp: number, logger: BuildsRedisLogger): CoordinatorTrackedJob {
    return new CoordinatorTrackedJob(
        job.pkgbase,
        job.target_repo,
        job.source_repo,
        job.arch,
        job.build_class,
        job.pkgnames,
        job.dependencies,
        job.commit,
        timestamp,
        logger,
    );
}

export interface TrackedJobs {
    [key: string]: CoordinatorTrackedJob;
}

export type JobStatus = "active" | "queued";

export interface QueuedJob {
    buildClass: BuildClass;
    jobData: CoordinatorJobSavable;
    node?: string;
    status: JobStatus;
    liveLogUrl?: string;
}

export type QueueStatus = QueuedJob[];

/**
 * The coordinator service is responsible for managing the build queue and assigning jobs to the builder nodes.
 */
export class CoordinatorService extends Service {
    private base_logs_url = process.env.LOGS_URL;
    private package_repos = process.env.PACKAGE_REPOS;
    private package_target_repos = process.env.PACKAGE_TARGET_REPOS;
    private package_repos_notifiers = process.env.PACKAGE_REPOS_NOTIFIERS;
    private builder_image =
        process.env.BUILDER_IMAGE || "registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest";

    private queue: TrackedJobs = {};
    private readonly repo_manager: RepoManager;
    private busy_nodes: TrackedJobs = {};
    private mutex: Mutex = new Mutex();
    private chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");

    private active = false;
    private drainedNotifier: (() => void) | null = null;

    constructor(
        broker: ServiceBroker,
        private redis_connection_manager: RedisConnectionManager,
    ) {
        super(broker);

        this.repo_manager = new RepoManager(
            this.base_logs_url ? new URL(this.base_logs_url) : undefined,
            this.chaoticLogger,
        );
        this.initRepoManager(this.repo_manager);

        this.parseServiceSchema({
            name: "coordinator",

            actions: {
                addJobsToQueue: this.addJobsToQueue,
                autoRepoRemove: this.autoRepoRemove,
                getAvailableNodes: this.getAvailableNodes,
                getCurrentQueue: this.getQueue,
                getQueue: this.getQueue,
                jobExists: this.jobExists,
            },
            events: {
                "$node.connected": {
                    handler: this.assignJobs,
                },
                "$broker.started": {
                    handler: this.start,
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
            arch: job.arch,
            build_class: job.build_class,
            builder_name: getPureNodeName(node_id),
            commit: job.commit,
            logUrl: this.base_logs_url ? getLogUrl(job, this.base_logs_url) : undefined,
            pkgname: job.pkgbase,
            replaced: false,
            target_repo: job.target_repo,
            timestamp: job.timestamp,
        };

        const notificationPromises: Promise<any>[] = [];

        promise
            .then(
                async (ret: BuildStatusReturn) => {
                    metricsParams.duration = ret.duration;

                    // Special logic, don't be needlessly noisy and prevent other logic
                    if (
                        !this.active &&
                        (ret.success === BuildStatus.CANCELED || ret.success === BuildStatus.CANCELED_REQUEUE)
                    ) {
                        await source_repo.notify(job, "canceled", "Build canceled due to coordinator shutdown.");
                        metricsParams.status = ret.success;
                        notificationPromises.push(
                            this.broker.broadcast<MetricsCounterLabels>("builds.canceled-requeue", metricsParams),
                        );
                        return;
                    }
                    switch (ret.success) {
                        case BuildStatus.ALREADY_BUILT: {
                            void source_repo.notify(
                                job,
                                "canceled",
                                "Build skipped because package was already built.",
                            );
                            job.logger.log(`Job ${job.toId()} skipped because all packages were already built.`);

                            metricsParams.status = BuildStatus.ALREADY_BUILT;
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterAlreadyBuilt",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.alreadyBuilt", metricsParams),
                            );
                            break;
                        }
                        case BuildStatus.SUCCESS: {
                            notificationPromises.push(
                                source_repo.notify(job, "success", "Package successfully deployed."),
                            );
                            job.logger.log(`Build job ${job.toId()} finished at ${currentTime()}...`);

                            const notify_params: DeploymentNotificationParams = {
                                commit: job.commit,
                                event: `📣 New deployment to ${job.target_repo}`,
                                node: job.node,
                                packages: ret.packages!,
                                pkgbase: job.pkgbase,
                                source_repo_url: source_repo.getUrl(),
                                timestamp: job.timestamp,
                            };
                            metricsParams.status = BuildStatus.SUCCESS;
                            notificationPromises.push(
                                this.broker.call<void, DeploymentNotificationParams>(
                                    "notifier.notifyDeployment",
                                    notify_params,
                                ),
                            );
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterBuildSuccess",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.success", metricsParams),
                            );
                            break;
                        }
                        case BuildStatus.SKIPPED: {
                            notificationPromises.push(
                                source_repo.notify(job, "canceled", "Build skipped intentionally via build tools."),
                            );
                            job.logger.log(`Job ${job.toId()} skipped intentionally via build tools.`);

                            metricsParams.status = BuildStatus.SKIPPED;
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterBuildSkipped",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.skipped", metricsParams),
                            );
                            break;
                        }
                        case BuildStatus.FAILED: {
                            job.logger.log(`Job ${job.toId()} failed`);
                            notificationPromises.push(source_repo.notify(job, "failed", "Build failed."));

                            const notify_params: DeploymentNotificationParams = {
                                commit: job.commit,
                                event: `🚨 Failed deploying to ${job.target_repo}`,
                                node: job.node,
                                pkgbase: job.pkgbase,
                                source_repo_url: source_repo.getUrl(),
                                timestamp: job.timestamp,
                            };
                            metricsParams.status = BuildStatus.FAILED;
                            notificationPromises.push(
                                this.broker.call<void, DeploymentNotificationParams>(
                                    "notifier.notifyDeployment",
                                    notify_params,
                                ),
                            );
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterBuildFailure",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.failed", metricsParams),
                            );
                            break;
                        }
                        case BuildStatus.CANCELED: {
                            metricsParams.status = BuildStatus.CANCELED;
                            if (job.replacement) {
                                job.logger.log(`Job ${job.toId()} was canceled and replaced by a newer build request.`);

                                notificationPromises.push(
                                    source_repo.notify(job, "canceled", "Build canceled and replaced."),
                                );
                                metricsParams.replaced = true;
                                notificationPromises.push(
                                    this.broker.call<void, MetricsCounterLabels>(
                                        "metrics.incCounterBuildCancelled",
                                        metricsParams,
                                    ),

                                    this.broker.broadcast<MetricsCounterLabels>("builds.replaced", metricsParams),
                                );
                            } else {
                                job.logger.log(`Job ${job.toId()} was canceled.`);

                                metricsParams.replaced = false;
                                notificationPromises.push(source_repo.notify(job, "canceled", "Build canceled."));
                                notificationPromises.push(
                                    this.broker.call<void, MetricsCounterLabels>(
                                        "metrics.incCounterBuildCancelled",
                                        metricsParams,
                                    ),

                                    this.broker.broadcast<MetricsCounterLabels>("builds.canceled", metricsParams),
                                );
                            }
                            break;
                        }
                        case BuildStatus.CANCELED_REQUEUE: {
                            notificationPromises.push(
                                source_repo.notify(job, "canceled", "Builder shutdown requested."),
                            );
                            metricsParams.replaced = true;
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterBuildCancelled",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.canceled-requeue", metricsParams),
                            );
                            job.logger.log(`Job ${job.toId()} was canceled and re-queued due to builder shutdown.`);
                            const new_job = job.toSavable();
                            job.replacement = toTracked(new_job, job.timestamp, job.logger);
                            break;
                        }
                        case BuildStatus.TIMED_OUT: {
                            notificationPromises.push(source_repo.notify(job, "failed", "Build timed out."));
                            job.logger.log(`Job ${job.toId()} reached a timeout during the build phase.`);

                            const notify_params: DeploymentNotificationParams = {
                                commit: job.commit,
                                event: `⏳ Build for ${job.target_repo} failed due to a timeout`,
                                node: job.node,
                                pkgbase: job.pkgbase,
                                source_repo_url: source_repo.getUrl(),
                                timestamp: job.timestamp,
                            };
                            notificationPromises.push(
                                this.broker.call<void, DeploymentNotificationParams>(
                                    "notifier.notifyDeployment",
                                    notify_params,
                                ),
                            );
                            metricsParams.status = BuildStatus.TIMED_OUT;
                            notificationPromises.push(
                                this.broker.call<void, MetricsCounterLabels>(
                                    "metrics.incCounterBuildTimeout",
                                    metricsParams,
                                ),

                                this.broker.broadcast<MetricsCounterLabels>("builds.timeout", metricsParams),
                            );
                            break;
                        }
                    }
                },
                (err) => {
                    this.chaoticLogger.error("Unexpected promise rejection during package deployment:", err);
                    notificationPromises.push(source_repo.notify(job, "failed", "Build failed."));
                    job.logger.log(`Job ${job?.toId()} failed`);

                    const notify_params: DeploymentNotificationParams = {
                        commit: job.commit,
                        event: `💥 The code blew up while deploying to ${job.target_repo}`,
                        node: job.node,
                        pkgbase: job.pkgbase,
                        source_repo_url: source_repo.getUrl(),
                        timestamp: job.timestamp,
                    };
                    notificationPromises.push(
                        this.broker.call<void, DeploymentNotificationParams>(
                            "notifier.notifyDeployment",
                            notify_params,
                        ),
                    );
                    metricsParams.status = BuildStatus.SOFTWARE_FAILURE;
                    notificationPromises.push(
                        this.broker.call<void, MetricsCounterLabels>(
                            "metrics.incCounterSoftwareFailure",
                            metricsParams,
                        ),

                        this.broker.broadcast<MetricsCounterLabels>("builds.softwareFailure", metricsParams),
                    );
                },
            )
            .catch((err) => {
                this.chaoticLogger.error("Coordinator error during job completion:", err);
            })
            .finally(async () => {
                const promises = await Promise.allSettled(notificationPromises);
                for (const promise of promises) {
                    if (promise.status === "rejected") {
                        this.chaoticLogger.error("Failure during post-job notification:", promise.reason);
                    }
                }

                this.chaoticLogger.info(`Job for ${job.pkgbase} finished on node ${node_id}.`);

                void job.logger.end_log();
                const job_id = job.toId();
                if (job.replacement) this.queue[job_id] = job.replacement;
                else delete this.queue[job_id];
                delete this.busy_nodes[node_id];
                if (this.drainedNotifier && Object.keys(this.busy_nodes).length === 0) {
                    this.drainedNotifier();
                }
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
        await this.mutex
            .runExclusive(async () => {
                // Fetch the list of available builder nodes
                const available_nodes: BrokerNode[] = await this.getAvailableNodes();

                if (available_nodes.length == 0) {
                    return;
                }

                const graph: DepGraph<CoordinatorTrackedJob> = this.constructDependencyGraph(this.queue);
                const upload_info: Database_Action_fetchUploadInfo_Response = await this.getUploadInfo();

                for (const node of available_nodes) {
                    const jobs: CoordinatorTrackedJob[] = this.getPossibleJobs(
                        graph,
                        node.metadata.build_class as number,
                        getPureNodeName(node.id),
                    );
                    if (jobs.length == 0) {
                        continue;
                    }
                    const job: CoordinatorTrackedJob | undefined = jobs.shift();
                    if (!job) {
                        continue;
                    }

                    const source_repo: Repo = this.repo_manager.getRepo(job.source_repo);
                    const target_repo: TargetRepo = this.repo_manager.getTargetRepo(job.target_repo);
                    const params: Builder_Action_BuildPackage_Params = {
                        arch: job.arch,
                        builder_image: this.builder_image,
                        commit: job.commit,
                        extra_keyrings: target_repo.keyringsToBashArray(),
                        extra_repos: target_repo.repoToString(),
                        pkgbase: job.pkgbase,
                        source_repo: job.source_repo,
                        source_repo_url: source_repo.getUrl(),
                        target_repo: job.target_repo,
                        timestamp: job.timestamp,
                        upload_info,
                    };

                    job.node = node.id;
                    this.busy_nodes[node.id] = job;

                    this.chaoticLogger.info(
                        `Assigning job (${job.build_class}) for ${job.pkgbase} to node ${node.id} (${node.metadata.build_class})`,
                    );
                    source_repo.notify(job, "running", "Build in progress...");

                    const promise = this.broker.call<BuildStatusReturn, Builder_Action_BuildPackage_Params>(
                        "builder.buildPackage",
                        params,
                        {
                            nodeID: node.id,
                        },
                    );
                    this.onJobComplete(promise, job, source_repo, node.id);
                }
            })
            .finally(async () => {
                await this.saveQueue();
                await this.updateMetrics();
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

        const redis: Redis = this.redis_connection_manager.getClient();

        for (const pkg of data.packages) {
            if (!isValidPkgbase(pkg.pkgbase)) {
                this.chaoticLogger.error(`Refusing to queue pkgbase: ${pkg.pkgbase}`);
                continue;
            }
            const logger = new BuildsRedisLogger(redis, this.broker, "BUILD");
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
            const log = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.broker, "BUILD");
            log.from(job.pkgbase, job.timestamp);
            void (async () => {
                this.chaoticLogger.info(`Added job for ${job.pkgbase} to the build queue.`);
                await log.setDefault();
                log.log(`Added to build queue at ${currentTime()}. Waiting for builder...`);
                // Notify the source repository that the job is pending
                const source_repo: Repo = this.repo_manager.getRepo(data.source_repo);
                source_repo.notify(job, "pending", "Waiting for builder...");
            })();

            const id = job.toId();
            const previous = this.queue[id];
            // Is queued
            if (previous) {
                // Is running
                if (previous.node) {
                    void ctx.call("builder.cancelBuild", undefined, { nodeID: previous.node }).catch((err) => {});
                    previous.logger.log(
                        `Job cancellation requested at ${currentTime()}. Job is being replaced by newer build request.`,
                    );
                    this.chaoticLogger.info(
                        `Cancellation requested for currently running job ${job.pkgbase} at ${currentTime()}. Job is being replaced by newer build request.`,
                    );
                    previous.replacement = job;
                    continue;
                    // Not running
                } else {
                    void (async () => {
                        this.chaoticLogger.info(
                            `Job for ${job.pkgbase} canceled and replaced with a new job before execution.`,
                        );
                        const previous_source_repo: Repo = this.repo_manager.getRepo(previous.source_repo);
                        previous_source_repo.notify(job, "canceled", "Build canceled and replaced.");
                        await previous.logger.log(`Job was canceled and replaced with a new job before execution.`);
                        await previous.logger.end_log();
                    })().catch((err) => {});
                }
            }
            this.queue[id] = job;
        }

        this.assignJobs();
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
            await this.broker.call<void, GenericNotificationParams>("notifier.notifyGeneric", {
                message: `✅ Cleanup job for ${data.repo} finished successfully`,
            });
        } else {
            await this.broker.call<void, GenericNotificationParams>("notifier.notifyGeneric", {
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

            if (!job.pkgnames || !job.dependencies) continue;

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
     * Returns a list of possible jobs that can be assigned to a builder node. Also handles circular dependencies.
     * @param graph The dependency graph of the jobs.
     * @param builder_class The builder class of the node. Jobs with a build class higher than this value will be ignored.
     * @param node_name The name of the node.
     * @returns A list of possible jobs that can be assigned to the builder node.
     * @private
     */
    private getPossibleJobs(
        graph: DepGraph<CoordinatorTrackedJob>,
        builder_class: number,
        node_name: string,
    ): CoordinatorTrackedJob[] {
        const jobs: CoordinatorTrackedJob[] = [];
        let nodes: string[] = graph.overallOrder();
        // Used to
        // 1. Skip jobs that depend on other jobs
        // 2. Handle circular dependencies gently
        let unresolvable: string[] = [];

        for (const node of nodes) {
            const job: CoordinatorTrackedJob = graph.getNodeData(node);
            // Skip jobs that are already assigned to a node
            if (job.node) {
                unresolvable.push(...graph.dependantsOf(node));
                continue;
            }
            if (unresolvable.includes(node)) continue;
            if (typeof job.build_class === "number" && builder_class !== null && job.build_class <= builder_class) {
                jobs.push(job);
                unresolvable.push(...graph.dependantsOf(node));
            } else if (typeof job.build_class === "string" && job.build_class === node_name) {
                jobs.push(job);
                unresolvable.push(...graph.dependantsOf(node));
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
     * Fetches the list of available builder nodes (not busy).
     * @private
     */
    private async getAvailableNodes(): Promise<BrokerNode[]> {
        const services: Service[] = await this.broker.call<Service[]>("$node.services");
        let nodes: string[] | undefined;
        for (const entry of services) {
            if (entry.name === "builder") {
                nodes = entry.nodes;
                break;
            }
        }

        if (!nodes || nodes.length == 0) {
            return [];
        }

        // Fetch the full list of nodes
        const full_node_list: BrokerNode[] = await this.broker.call("$node.list");
        if (!full_node_list || full_node_list.length == 0) {
            return [];
        }

        // node.metadata.version === current_version → check if the node is compatible with the coordinator
        // nodes.includes(node.id) → check if the node is in the list of builder nodes
        // node.available → check if the node is available (not offline)
        // !this.busy_nodes[node.id] → check if the node is not in the list of busy nodes
        return full_node_list.filter(
            (node: BrokerNode) =>
                node.metadata.version === current_version &&
                nodes.includes(node.id) &&
                node.available &&
                !this.busy_nodes[node.id],
        );
    }

    /**
     * Updates all relevant metrics counters for the coordinator service.
     * @private
     */
    private async updateMetrics(): Promise<void> {
        const available_nodes: BrokerNode[] = await this.getAvailableNodes();
        try {
            await this.broker.call<void, MetricsGaugeContext>("metrics.setGaugeActiveBuilders", {
                count: Object.keys(this.busy_nodes).length,
            });
            await this.broker.call<void, MetricsGaugeContext>("metrics.setGaugeIdleBuilders", {
                count: available_nodes.length,
            });
            await this.broker.call<void, MetricsGaugeContext>("metrics.setGaugeCurrentQueue", {
                count: Object.keys(this.queue).length,
                labels: {
                    build_class: Object.keys(this.queue).map((key) => this.queue[key].build_class) as BuildClass[],
                    pkgname: Object.keys(this.queue).map((key) => this.queue[key].pkgbase),
                    target_repo: Object.keys(this.queue).map((key) => this.queue[key].target_repo),
                },
            });
        } catch (error) {
            this.chaoticLogger.error("Error updating metrics:", error);
        }
    }

    /**
     * Saves the current build queue to the Redis database.
     * @private
     */
    private async saveQueue(): Promise<void> {
        const save_queue: CoordinatorJobSavable[] = [];
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
                        const logger = new BuildsRedisLogger(client, this.broker, "BUILD");
                        logger.from(savedJob.pkgbase, timestamp);
                        const job = toTracked(savedJob, timestamp, logger);
                        const id = job.toId();
                        job.logger.log(`Restored job ${id} at ${currentTime()}`);
                        void job.logger.setDefault();
                        this.chaoticLogger.info(`Restored saved job ${job.pkgbase} for ${job.target_repo}`);
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

        let timeout: NodeJS.Timeout | null = null;
        const drained = new Promise((resolve: any) => {
            if (Object.keys(this.busy_nodes).length === 0) resolve();
            else {
                this.drainedNotifier = resolve;
                timeout = setTimeout(() => {
                    this.chaoticLogger.error("Coordinator shutdown timeout reached. Forcing shutdown.");
                    resolve();
                }, MAX_SHUTDOWN_TIME);
            }
        });

        await this.saveQueue();

        for (const job of Object.values(this.queue)) {
            if (job.node) {
                job.logger.log(`Job cancellation requested at ${currentTime()}. Coordinator is shutting down.`);
                this.chaoticLogger.info(`Job for ${job.pkgbase} was canceled due to coordinator shutdown.`);
                // Make sure not to requeue the job
                job.replacement = undefined;
                this.broker.call("builder.cancelBuild", undefined, { nodeID: job.node }).catch((err) => {
                    this.chaoticLogger.error(`Failed to cancel build ${job.toId()}:`, err);
                });
            } else {
                job.logger.log(`Job was canceled before execution. Coordinator is shutting down.`);
                this.chaoticLogger.info(`Job for ${job.pkgbase} was canceled before execution.`);
            }
        }

        await drained;
        if (timeout) clearTimeout(timeout);
    }

    async stopped(): Promise<void> {
        await this.schema.stop.bind(this.schema)();
    }

    /**
     * Fetches the current build queue.
     * @returns The current build queue.
     */
    async getQueue(): Promise<QueueStatus> {
        const queue: QueueStatus = [];
        Object.values(this.queue).forEach((job) => {
            queue.push({
                status: job.node ? "active" : "queued",
                node: job.node,
                buildClass: job.build_class,
                jobData: job.toSavable(),
                liveLogUrl: this.base_logs_url ? getLogUrl(job, this.base_logs_url) : undefined,
            });
        });

        return queue;
    }
}

export default CoordinatorService;

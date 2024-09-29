import { Context, Service, ServiceBroker } from "moleculer";
import {
    Builder_Action_BuildPackage_Params,
    BuildStatus,
    BuildStatusReturn,
    Coordinator_Action_AddJobsToQueue_Params,
    Coordinator_Action_AutoRepoRemove_Params,
    CoordinatorJob,
    Database_Action_AutoRepoRemove_Params,
    Database_Action_fetchUploadInfo_Response,
    DatabaseRemoveStatusReturn,
    FailureNotificationParams,
    SuccessNotificationParams,
} from "../types";
import { Repo, RepoManager, TargetRepo } from "../repo-manager";
import { DepGraph } from "dependency-graph";
import { BuildsRedisLogger } from "../logging";
import { RedisConnectionManager } from "../redis-connection-manager";
import { currentTime } from "../utils";

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

    queue: { [key: string]: CoordinatorJob } = {};
    redis_connection_manager: RedisConnectionManager;
    repo_manager = new RepoManager(this.base_logs_url ? new URL(this.base_logs_url) : undefined, this.logger);
    busy_nodes: { [key: string]: CoordinatorJob } = {};

    constructor(broker: ServiceBroker, redis_connection_manager: RedisConnectionManager) {
        super(broker);

        this.initRepoManager(this.repo_manager);

        this.parseServiceSchema({
            name: "coordinator",
            version: 1,

            settings: {
                $noVersionPrefix: true,
            },
            actions: {
                assignJobs: this.assignJobs,
                addJobsToQueue: this.addJobsToQueue,
                autoRepoRemove: this.autoRepoRemove,
            },
            events: {
                "$node.connected": {
                    handler(): void {
                        void broker.call("coordinator.assignJobs");
                    },
                },
            },
        });

        this.redis_connection_manager = redis_connection_manager;

        this.broker.waitForServices(["$node"]).then(() => {
            void this.assignJobs();
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
     * Assigns jobs to the builder nodes. This function is called recursively to ensure that all available nodes are
     * utilized and existing build jobs are assigned to them.
     */
    async assignJobs(): Promise<void> {
        let services: any[] = await this.broker.call("$node.services");
        let nodes: string[] | undefined;
        for (const entry of services) {
            if (entry.name === "builder") {
                nodes = entry.nodes;
                break;
            }
        }

        // Check if any of the nodes are in the busy_nodes list
        if (!nodes || nodes.length == 0) {
            this.logger.warn("No builder nodes available.");
            return;
        }

        let full_node_list: any[] = await this.broker.call("$node.list");
        if (!full_node_list || full_node_list.length == 0) {
            this.logger.error("No nodes listed??");
            return;
        }

        // nodes.includes(node.id) -> check if the node is in the list of builder nodes
        // node.available -> check if the node is available (not offline)
        // !this.busy_nodes[node.id] -> check if the node is not in the list of busy nodes
        let available_nodes: any[] = full_node_list.filter(
            (node: any) => nodes.includes(node.id) && node.available && !this.busy_nodes[node.id],
        );

        if (available_nodes.length == 0) {
            return;
        }

        let graph: DepGraph<CoordinatorJob> = this.constructDependencyGraph(this.queue);
        let upload_info: Database_Action_fetchUploadInfo_Response = await this.getUploadInfo();

        for (const node of available_nodes) {
            let jobs: CoordinatorJob[] = this.getPossibleJobs(graph, node.metadata.build_class);
            if (jobs.length == 0) {
                continue;
            }
            let job: CoordinatorJob | undefined = jobs.shift();
            if (!job) {
                continue;
            }

            this.busy_nodes[node.id] = job;
            let source_repo: Repo = this.repo_manager.getRepo(job.source_repo);
            let target_repo: TargetRepo = this.repo_manager.getTargetRepo(job.target_repo);
            let params: Builder_Action_BuildPackage_Params = {
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

            let logger = new BuildsRedisLogger(this.redis_connection_manager.getClient(), this.logger);
            void logger.from(job.pkgbase, job.timestamp);
            void logger.setDefault();

            this.broker
                .call<BuildStatusReturn, Builder_Action_BuildPackage_Params>("builder.buildPackage", params, {
                    nodeID: node.id,
                })
                .then((ret: BuildStatusReturn) => {
                    switch (ret.success) {
                        case BuildStatus.ALREADY_BUILT: {
                            source_repo.notify(job, "canceled", "Build skipped because package was already built.");
                            logger.log(`Job ${job?.toId()} skipped because all packages were already built.`);
                            break;
                        }
                        case BuildStatus.SUCCESS: {
                            source_repo.notify(job, "success", "Package successfully deployed.");
                            logger.log(`Build job ${job?.toId()} finished at ${currentTime()}...`);

                            const notify_params: SuccessNotificationParams = {
                                packages: ret.packages!,
                                event: `📣 New deployment to ${job.target_repo}`,
                            };
                            this.broker.call("notifier.notifyPackages", notify_params);
                            break;
                        }
                        case BuildStatus.SKIPPED: {
                            source_repo.notify(job, "canceled", "Build skipped intentionally via build tools.");
                            logger.log(`Job ${job?.toId()} skipped intentionally via build tools.`);
                            break;
                        }
                        case BuildStatus.FAILED: {
                            source_repo.notify(job, "failed", "Build failed.");
                            logger.log(`Job ${job?.toId()} failed`);

                            const notify_params: FailureNotificationParams = {
                                pkgbase: params.pkgbase,
                                event: `🚨 Failed deploying to ${job.target_repo}`,
                                source_repo_url: params.source_repo_url,
                                source_repo: params.source_repo,
                                timestamp: params.timestamp,
                                commit: params.commit,
                            };
                            this.broker.call("notifier.notifyFailure", notify_params);
                            break;
                        }
                        case BuildStatus.TIMED_OUT: {
                            source_repo.notify(job, "failed", "Build timed out.");
                            logger.log(`Job ${job?.toId()} reached a timeout during the build phase.`);

                            const notify_params: FailureNotificationParams = {
                                pkgbase: params.pkgbase,
                                event: `⏳ Build for ${params.source_repo} failed due to a timeout`,
                                source_repo_url: params.source_repo_url,
                                source_repo: params.source_repo,
                                timestamp: params.timestamp,
                                commit: params.commit,
                            };
                            this.broker.call("notifier.notifyFailure", notify_params);
                            break;
                        }
                    }
                })
                .catch((err) => {
                    this.logger.error("Failed during package deployment:", err);
                    source_repo.notify(job, "failed", "Build failed.");
                    logger.log(`Job ${job?.toId()} failed`);

                    const notify_params: FailureNotificationParams = {
                        pkgbase: params.pkgbase,
                        event: `💥 The code blew up while deploying to ${job.target_repo}`,
                        source_repo_url: params.source_repo_url,
                        source_repo: params.source_repo,
                        timestamp: params.timestamp,
                        commit: params.commit,
                    };
                    this.broker.call("notifier.notifyFailure", notify_params);
                })
                .finally(() => {
                    delete this.queue[job.toId()];
                    delete this.busy_nodes[node.id];
                    this.assignJobs();
                });
        }
    }

    /**
     * Adds new jobs to the queue.
     * @param ctx The Moleculer context object.
     */
    async addJobsToQueue(ctx: Context): Promise<void> {
        const timestamp: number = Date.now();
        const data = ctx.params as Coordinator_Action_AddJobsToQueue_Params;
        const jobs: CoordinatorJob[] = [];

        for (const pkg of data.packages) {
            jobs.push(
                new CoordinatorJob(
                    pkg.pkgbase,
                    data.target_repo,
                    data.source_repo,
                    data.arch,
                    pkg.build_class || 0,
                    pkg.pkgnames,
                    pkg.dependencies,
                    timestamp,
                    data.commit,
                ),
            );
        }
        for (const job of jobs) {
            let id = job.toId();
            if (this.queue[id]) {
                // Job already in queue
                // TODO: cancel jobs if they are currently active
                continue;
            }
            this.queue[job.toId()] = job;
        }
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
            void this.broker.call("notifier.notifyGeneric", {
                message: `✅ Cleanup job for ${data.repo} finished successfully`,
            });
        } else {
            void this.broker.call("notifier.notifyGeneric", {
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
                let obj = JSON.parse(this.package_repos);
                repo_manager.repoFromObject(obj);
            } catch (error) {
                this.logger.error(error);
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
                let obj = JSON.parse(this.package_target_repos);
                repo_manager.targetRepoFromObject(obj);
            } catch (error) {
                this.logger.error(error);
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
                let obj = JSON.parse(this.package_repos_notifiers);
                repo_manager.notifiersFromObject(obj);
            } catch (error) {
                this.logger.error(error);
            }
        }
    }

    /**
     * Constructs a dependency graph for the given queue.
     * @param queue The queue of jobs as a dictionary.
     * @returns The dependency graph as a DepGraph object.
     * @private
     */
    private constructDependencyGraph(queue: { [key: string]: CoordinatorJob }): DepGraph<CoordinatorJob> {
        const graph = new DepGraph<CoordinatorJob>({ circular: true });
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
    private getPossibleJobs(graph: DepGraph<CoordinatorJob>, builder_class: number): CoordinatorJob[] {
        const jobs: CoordinatorJob[] = [];
        const nodes: string[] = graph.overallOrder(true);

        for (const node of nodes) {
            const job: CoordinatorJob = graph.getNodeData(node);
            if (job.build_class <= builder_class) {
                jobs.push(job);
            }
        }

        return jobs;
    }
}

export default CoordinatorService;

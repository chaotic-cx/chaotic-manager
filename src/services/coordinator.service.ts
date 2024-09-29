import { Context, Service, ServiceBroker } from "moleculer";
import {
    CoordinatorJob, Builder_Action_BuildPackage_Params, BuildStatus, BuildStatusReturn, Coordinator_Action_AddJobsToQueue_Params,
    Coordinator_Action_AutoRepoRemove_Params, Database_Action_AutoRepoRemove_Params, Database_Action_fetchUploadInfo_Response,
    SuccessNotificationParams, FailureNotificationParams
} from "../types";
import { RepoManager } from "../repo-manager";
import { DepGraph } from "dependency-graph";

const base_logs_url = process.env.LOGS_URL;
const package_repos = process.env.PACKAGE_REPOS;
const package_target_repos = process.env.PACKAGE_TARGET_REPOS;
const package_repos_notifiers = process.env.PACKAGE_REPOS_NOTIFIERS;
const builder_image = process.env.BUILDER_IMAGE || "registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest";

function initRepoManager(repo_manager: RepoManager) {
    if (package_repos) {
        try {
            let obj = JSON.parse(package_repos);
            repo_manager.repoFromObject(obj);
        } catch (error) {
            console.error(error);
            throw new Error("Invalid package repos.");
        }
    }
    if (!package_repos) {
        repo_manager.repoFromObject({
            "chaotic-aur": {
                url: "https://gitlab.com/chaotic-aur/pkgbuilds",
            },
        });
    }

    if (package_target_repos) {
        try {
            let obj = JSON.parse(package_target_repos);
            repo_manager.targetRepoFromObject(obj);
        } catch (error) {
            console.error(error);
            throw new Error("Invalid package repos.");
        }
    }
    if (!package_target_repos) {
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

    if (package_repos_notifiers) {
        try {
            let obj = JSON.parse(package_repos_notifiers);
            repo_manager.notifiersFromObject(obj);
        } catch (error) {
            console.error(error);
        }
    }
}

function constructDependencyGraph(queue: { [key: string]: CoordinatorJob }): DepGraph<CoordinatorJob> {
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

function getPossibleJobs(graph: DepGraph<CoordinatorJob>, builder_class: number): CoordinatorJob[] {
    const jobs: CoordinatorJob[] = [];
    const nodes = graph.overallOrder(true);

    console.log("Available jobs in queue graph: ", nodes);

    for (const node of nodes) {
        const job = graph.getNodeData(node);
        if (job.build_class <= builder_class) {
            jobs.push(job);
        }
    }
    
    console.log("Available jobs: ", jobs);
    return jobs;
}

function createAssignLoop(coordinator: CoordinatorService) {
    setTimeout(() => {
        console.log("AAAAAAAAAAAAAAAAAAAAAAAA", coordinator.queue)
        
        coordinator.assignJobs().finally(() => {
            createAssignLoop(coordinator);
        });
    }, 5000);
}

export class CoordinatorService extends Service {
    queue: { [key: string]: CoordinatorJob } = {};
    repo_manager = new RepoManager(base_logs_url ? new URL(base_logs_url) : undefined);
    busy_nodes: { [key: string]: CoordinatorJob } = {};

    constructor(broker: ServiceBroker) {
        super(broker);

        initRepoManager(this.repo_manager);

        this.parseServiceSchema({
            name: "coordinator",
            version: 1,

            settings: {
                $noVersionPrefix: true,
            },
            actions: {
                addJobsToQueue: this.addJobsToQueue,
                autoRepoRemove: this.autoRepoRemove,
            },
        });

        this.broker.waitForServices(["$node"]).then(() => {
            createAssignLoop(this);
        });
    }

    async getUploadInfo(): Promise<Database_Action_fetchUploadInfo_Response> {
        return this.broker.call("database.fetchUploadInfo");
    }

    async assignJobs() {
        console.debug("Coordinator: Trying to assign jobs...")

        let services: any[] = await this.broker.call("$node.services");
        let nodes: string[] | undefined;
        for (const entry of services) {
            if (entry.name === "builder") {
                nodes = entry.nodes;
                break;
            }
        }

        // check if any of the nodes are in the busy_nodes list
        if (!nodes || nodes.length == 0) {
            console.log("Coordinator: No builder nodes available.");
            return;
        }

        let full_node_list: any[] = await this.broker.call("$node.list");
        if (!full_node_list || full_node_list.length == 0) {
            console.log("Coordinator: No nodes listed??");
            return;
        }

        // nodes.includes(node.id) -> check if the node is in the list of builder nodes
        // node.available -> check if the node is available (not offline)
        // !this.busy_nodes[node.id] -> check if the node is not in the list of busy nodes
        let available_nodes: any[] = full_node_list.filter((node: any) => nodes.includes(node.id) && node.available && !this.busy_nodes[node.id]);

        if (available_nodes.length == 0) {
            console.log("Coordinator: All builder nodes are busy or unavailable.");
            return;
        }

        let graph = constructDependencyGraph(this.queue);
        let upload_info = await this.getUploadInfo();

        console.debug("Coordinator: Entering available nodes loop")

        for (const node of available_nodes) {
            let jobs = getPossibleJobs(graph, node.metadata.build_class);
            if (jobs.length == 0) {
                continue;
            }
            let job = jobs.shift();
            if (!job) {
                continue;
            }

            this.busy_nodes[node.id] = job;
            let source_repo = this.repo_manager.getRepo(job.source_repo);
            let target_repo = this.repo_manager.getTargetRepo(job.target_repo);
            let params: Builder_Action_BuildPackage_Params = {
                pkgbase: job.pkgbase,
                target_repo: job.target_repo,
                source_repo: job.source_repo,
                source_repo_url: source_repo.getUrl(),
                extra_repos: target_repo.repoToString(),
                extra_keyrings: target_repo.keyringsToBashArray(),
                arch: job.arch,
                builder_image,
                upload_info,
                timestamp: job.timestamp,
                commit: job.commit
            };

            job.node = node.id;

            this.broker.call<BuildStatusReturn, Builder_Action_BuildPackage_Params>("builder.buildPackage", params, { nodeID: node.id }).then((ret: BuildStatusReturn) => {
                switch (ret.success) {
                    case BuildStatus.ALREADY_BUILT: {
                        source_repo.notify(job, "canceled", "Build skipped because package was already built.");
                        break;
                    }
                    case BuildStatus.SUCCESS: {
                        source_repo.notify(job, "success", "Package successfully deployed.");
                        const notify_params: SuccessNotificationParams = {
                            packages: ret.packages!,
                            event: `📣 New deployment to ${job.target_repo}`
                        }
                        this.broker.call("notifier.notifyPackages", notify_params)
                        break;
                    }
                    case BuildStatus.SKIPPED: {
                        source_repo.notify(job, "canceled", "Build skipped intentionally via build tools.");
                        break;
                    }
                    case BuildStatus.FAILED: {
                        const notify_params: FailureNotificationParams = {
                            pkgbase: params.pkgbase,
                            event: `🚨 Failed deploying to ${job.target_repo}`,
                            source_repo_url: params.source_repo_url,
                            source_repo: params.source_repo,
                            timestamp: params.timestamp,
                            commit: params.commit
                        }
                        this.broker.call("notifier.notifyFailure", params)
                        source_repo.notify(job, "failed", "Build failed.");
                        break;
                    }
                    case BuildStatus.TIMED_OUT: {
                        const notify_params: FailureNotificationParams = {
                            pkgbase: params.pkgbase,
                            event: `⏳ Build for ${params.source_repo} failed due to a timeout`,
                            source_repo_url: params.source_repo_url,
                            source_repo: params.source_repo,
                            timestamp: params.timestamp,
                            commit: params.commit
                        }

                        this.broker.call("notifier.notifyFailure", notify_params)
                        source_repo.notify(job, "failed", "Build timed out.");
                        break;
                    }
                }
            }).catch((err) => {
                console.error("Failed during package deployment:", err);
                source_repo.notify(job, "failed", "Build failed.");
                const notify_params: FailureNotificationParams = {
                    pkgbase: params.pkgbase,
                    event: `💥 The code blew up while deploying to ${job.target_repo}`,
                    source_repo_url: params.source_repo_url,
                    source_repo: params.source_repo,
                    timestamp: params.timestamp,
                    commit: params.commit
                }
                this.broker.call("notifier.notifyFailure", notify_params)
            }).finally(() => {
                delete this.queue[job.toId()];
                delete this.busy_nodes[node.id];
            });
        }
    }

    // Add jobs to the queue, executed from scheduler
    async addJobsToQueue(ctx: Context) {
        const timestamp: number = Date.now();
        const data = ctx.params as Coordinator_Action_AddJobsToQueue_Params;
        const jobs: CoordinatorJob[] = [];

        console.debug("Called!", data);

        for (const pkg of data.packages) {
            jobs.push(new CoordinatorJob(pkg.pkgbase, data.target_repo, data.source_repo, data.arch, pkg.build_class || 0, pkg.pkgnames, pkg.dependencies, timestamp, data.commit));
            console.log("Pushing new job", pkg)
        }
        for (const job of jobs) {
            let id = job.toId();
            if (this.queue[id]) {
                // Job already in queue
                // TODO: cancel jobs if they are currently active
                continue;
            }
            console.debug("Queued", job)
            this.queue[job.toId()] = job;
        }
    }

    async autoRepoRemove(ctx: Context) {
        const data = ctx.params as Coordinator_Action_AutoRepoRemove_Params;
        const request: Database_Action_AutoRepoRemove_Params = {
            builder_image,
            ...data,
        }
        return await this.broker.call("database.autoRepoRemove", request);
    }
};

export default CoordinatorService;

// TODO:
// 
// assignJobs should not be called in a loop, but rather be called when a job is finished/a new builder is available
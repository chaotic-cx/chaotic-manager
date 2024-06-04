import Notifier from "./notifier";
import Redis from "ioredis";
import Timeout from "await-timeout";
import fs from "fs";
import path from "path";
import to from "await-to-js";
import { BuildJobData, BuildStatus, current_version, DatabaseJobData, DispatchJobData, RemoteSettings } from "./types";
import { BuildsRedisLogger } from "./logging";
import { BulkJobOptions, Job, MetricsTime, Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import { DockerManager } from "./docker-manager";
import { RedisConnectionManager } from "./redis-connection-manager";
import { Repo, RepoManager } from "./repo-manager";
import { createLogUrl, currentTime, splitJobId } from "./utils";
import { promotePendingDependents } from "./buildorder";

async function publishSettingsObject(manager: RedisConnectionManager, settings: RemoteSettings): Promise<void> {
    const subscriber = manager.getSubscriber();
    const connection = manager.getClient();
    subscriber.on("message", async (channel: string, message: string): Promise<void> => {
        if (channel === "config-request") {
            connection.publish("config-response", JSON.stringify(settings));
        }
    });
    await subscriber.subscribe("config-request");
    connection.publish("config-response", JSON.stringify(settings));
}

export default function createDatabaseWorker(redis_connection_manager: RedisConnectionManager): {
    database_worker: Worker;
    dispatch_worker: Worker;
} {
    let obj;
    const landing_zone = process.env.LANDING_ZONE_PATH || "";
    const landing_zone_adv = process.env.LANDING_ZONE_ADVERTISED_PATH || null;
    const repo_root = process.env.REPO_PATH || "";
    const gpg = process.env.GPG_PATH || "";
    const mount = "/repo_root";

    const database_host = process.env.DATABASE_HOST || "localhost";
    const database_port = Number(process.env.DATABASE_PORT || 22);
    const database_user = process.env.DATABASE_USER || "root";

    const builder_image =
        process.env.BUILDER_IMAGE || "registry.gitlab.com/garuda-linux/tools/chaotic-manager/builder:latest";

    const base_logs_url = process.env.LOGS_URL;
    const package_repos = process.env.PACKAGE_REPOS;
    const package_target_repos = process.env.PACKAGE_TARGET_REPOS;
    const package_repos_notifiers = process.env.PACKAGE_REPOS_NOTIFIERS;

    const repo_manager = new RepoManager(base_logs_url ? new URL(base_logs_url) : undefined);
    const notifier = new Notifier();

    /**
     * Creates a notification text for a deployment event.
     * @param packages The array of packages to notify about.
     * @param event The event to notify about, "New deployment" or "Failed deploying".
     * @returns A promise that resolves when the notification is sent.
     */
    async function createDeploymentNotification(packages: string[], event: string): Promise<void> {
        let text = `*${event}:*\n`;
        for (const pkg of packages) {
            text += ` > ${pkg.replace(/\.pkg.tar.zst$/, "")}\n`;
        }
        const [err]: [Error, undefined] | [null, void] = await to(notifier.notify(text));
        if (err) console.error(err);
    }

    /**
     * Creates a notification text for a failed event.
     * @param repo The Repo object of the failed build.
     * @param jobId The job ID of the failed build.
     * @param buildJobData The BuildJobData object of the failed build.
     * @param event The event to notify about, e.g., "Build for repo failed".
     * @returns A promise that resolves when the notification is sent.
     */
    async function createFailedBuildNotification(
        repo: Repo,
        jobId: string,
        buildJobData: BuildJobData,
        event: string,
    ): Promise<void> {
        const { target_repo, pkgbase } = splitJobId(jobId);
        let text = `*${event}:*\n > ${pkgbase}`;

        if (base_logs_url !== undefined) {
            const logsUrl = `${createLogUrl(base_logs_url, pkgbase, buildJobData.timestamp)}`;
            text += ` - [logs](${logsUrl})`;
        }

        // If we have a package_repos object, as well as a commit hash, we can add a link to the commit.
        // But only if it is either a GitHub or a GitLab repo as of now.
        if (package_repos !== undefined && buildJobData.commit !== undefined) {
            if (repo.getUrl().includes("gitlab.com")) {
                const commit = buildJobData.commit.split(":")[0];
                const commitUrl = `${repo.getUrl()}/-/commit/${commit}`;
                text += ` - [commit](${commitUrl})\n`;
            } else if (repo.getUrl().includes("github.com")) {
                const commitUrl = `${repo.getUrl()}/commit/${buildJobData.commit}`;
                text += ` - [commit](${commitUrl})\n`;
            }
        } else {
            text += "\n";
        }
        const [err]: [Error, undefined] | [null, void] = await to(notifier.notify(text));
        if (err) console.error(err);
    }

    if (package_repos) {
        try {
            obj = JSON.parse(package_repos);
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
            obj = JSON.parse(package_target_repos);
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
            obj = JSON.parse(package_repos_notifiers);
            repo_manager.notifiersFromObject(obj);
        } catch (error) {
            console.error(error);
        }
    }

    const settings: RemoteSettings = {
        database: {
            ssh: {
                host: database_host,
                port: database_port,
                user: database_user,
            },
            landing_zone: landing_zone_adv || landing_zone,
        },
        builder: {
            image: builder_image,
        },
        repos: repo_manager.repoToObject(),
        target_repos: repo_manager.targetRepoToObject(),
        version: current_version,
    };

    const connection: Redis = redis_connection_manager.getClient();

    const docker_manager = new DockerManager();
    const database_worker = new Worker(
        "database",
        async (job: Job): Promise<void> => {
            if (job.id === undefined) throw new Error("Job ID is undefined");

            const { target_repo, pkgbase } = splitJobId(job.id);
            if (pkgbase == "repo-remove") {
                console.log(`\r\nProcessing repo-remove job for ${target_repo} at ${currentTime()}`);
                const arch = job.data.arch;
                const pkgbases: string[] = job.data.pkgbases;

                if (pkgbases.length === 0) {
                    console.log("Intended package list is empty. Assuming this is in error.");
                    throw new UnrecoverableError("Intended package list is empty. Assuming this is in error.");
                }

                const [err, out] = await docker_manager.run(
                    settings.builder.image,
                    ["auto-repo-remove", arch, "/repo_root", target_repo].concat(pkgbases),
                    [`${repo_root}:/repo_root`],
                    [],
                    process.stdout.write.bind(process.stdout),
                );

                if (err) console.log(err);

                if (err || out.StatusCode !== undefined) {
                    console.log(`Repo remove job for ${target_repo} failed at ${currentTime()}`);
                    throw new Error("auto-repo-remove failed.");
                }
                console.log(`Finished repo-remove job for ${target_repo} at ${currentTime()}.`);
            } else {
                const logger = new BuildsRedisLogger(connection);
                logger.fromJob(job);

                logger.log(`\r\nProcessing database job ${job.id} at ${currentTime()}`);
                const arch = job.data.arch;
                const jobdata: DatabaseJobData = job.data;
                const packages: string[] = jobdata.packages;

                try {
                    if (packages.length === 0) {
                        logger.log(`Job ${job.id} had no packages to add.`);
                        throw new UnrecoverableError("No packages to add.");
                    }

                    const [err, out] = await docker_manager.run(
                        settings.builder.image,
                        ["repo-add", arch, "/landing_zone", "/repo_root", target_repo].concat(packages),
                        [`${landing_zone}:/landing_zone`, `${repo_root}:/repo_root`, `${gpg}:/root/.gnupg`],
                        [],
                        logger.raw_log.bind(logger),
                    );

                    if (err) logger.error(err);

                    if (err || out.StatusCode !== undefined) {
                        logger.log(`Job ${job.id} failed at ${currentTime()}`);
                        throw new Error("repo-add failed.");
                    } else {
                        logger.log(`Finished job ${job.id} at ${currentTime()}.`);
                    }
                } finally {
                    setTimeout(promotePendingDependents.bind(null, jobdata, builds_queue, logger), 1000);
                }
            }
        },
        { connection: connection },
    );
    const dispatch_worker = new Worker(
        "dispatch",
        async (job: Job): Promise<void> => {
            if (job.id === undefined) throw new Error("Job ID is undefined");

            const data = job.data as DispatchJobData;

            if (data.type === "add-job") {
                const add_job_data = data.data;

                // Generate a file list to avoid adding packages that are already in the repository
                const directory: string = path.join(mount, add_job_data.target_repo, add_job_data.arch);
                let file_list: string[] = [];
                if (fs.existsSync(directory)) {
                    file_list = fs.readdirSync(directory);
                }

                const remove_promise_list: Promise<number>[] = [];
                const timestamp: number = Date.now();

                const out: {
                    name: string;
                    data: BuildJobData;
                    opts: BulkJobOptions;
                }[] = add_job_data.packages.map((pkg) => {
                    const id = `${add_job_data.target_repo}/${pkg.pkgbase}`;
                    remove_promise_list.push(builds_queue.remove(id));
                    return {
                        name: `${id}-${timestamp}`,
                        data: {
                            arch: add_job_data.arch,
                            srcrepo: add_job_data.source_repo,
                            timestamp: timestamp,
                            commit: add_job_data.commit,
                            deptree: pkg.deptree,
                            repo_files: file_list,
                        },
                        opts: {
                            jobId: id,
                            removeOnComplete: { age: 5 },
                            removeOnFail: { age: 5 },
                        },
                    };
                });

                // Cancel running jobs
                {
                    const remove_promise_list_results: PromiseSettledResult<number>[] =
                        await Promise.allSettled(remove_promise_list);
                    const job_state_list: Promise<string>[] = [];

                    for (const i in remove_promise_list_results) {
                        const result: PromiseSettledResult<number> = remove_promise_list_results[i];
                        if (result.status === "fulfilled" && result.value === 0)
                            job_state_list.push(builds_queue.getJobState(out[i].opts.jobId!));
                        else job_state_list.push(Promise.resolve("unknown"));
                    }

                    const job_state_list_results: PromiseSettledResult<string>[] =
                        await Promise.allSettled(job_state_list);
                    const wait_for_finished_list: Promise<unknown>[] = [];

                    for (const i in job_state_list_results) {
                        const result: PromiseSettledResult<string> = job_state_list_results[i];
                        if (result.status === "fulfilled" && result.value === "active") {
                            const to_wait: Job = new Job(builds_queue, "", undefined, undefined, out[i].opts.jobId);
                            wait_for_finished_list.push(to_wait.waitUntilFinished(builds_queue_events));
                            connection.publish("cancel-job", out[i].opts.jobId!);
                        }
                    }
                    await Promise.allSettled(wait_for_finished_list);
                    // For safety, wait a second to ensure the job is removed from the queue (we don't want to add a job that is still in the queue)
                    await Timeout.set(1000);
                }

                const jobs: Job[] = await builds_queue.addBulk(out);

                for (const job of jobs) {
                    const logger = new BuildsRedisLogger(connection);
                    logger.fromJob(job);
                    void logger.setDefault();
                    logger.log(`Added to build queue at ${currentTime()}. Waiting for builder...`);
                }

                setTimeout(async (): Promise<void> => {
                    try {
                        const repo: Repo = repo_manager.getRepo(add_job_data.source_repo);
                        for (const job of jobs) {
                            await Timeout.set(200);
                            if ((await job.getState()) == "waiting")
                                await repo.notify(job, "pending", "Waiting for builder...");
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }, 3000);
            }
        },
        {
            connection: connection,
        },
    );
    void database_worker.pause();
    void dispatch_worker.pause();

    const builds_queue_events = new QueueEvents("builds", { connection });
    const builds_queue = new Queue("builds", { connection });

    builds_queue_events.on("stalled", async ({ jobId }): Promise<void> => {
        try {
            const logger = new BuildsRedisLogger(connection);
            const job: Job | undefined = await logger.fromJobID(jobId, builds_queue);
            logger.log(`Job stalled at ${currentTime()}`);
            if (job) {
                const jobdata: BuildJobData = job.data;
                const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
                await repo.notify(job, "failed", "Build stalled. Retrying...");
                await repo.notify(job, "pending", "Build stalled. Retrying...");
            }
        } catch (error) {
            console.error(error);
        }
    });
    builds_queue_events.on("active", async ({ jobId }): Promise<void> => {
        try {
            const logger = new BuildsRedisLogger(connection);
            const job: Job | undefined = await logger.fromJobID(jobId, builds_queue);
            if (job) {
                const jobdata: BuildJobData = job.data;
                const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
                await repo.notify(job, "running", "Build in progress...");
            }
        } catch (error) {
            console.error(error);
        }
    });
    builds_queue_events.on("retries-exhausted", async ({ jobId }): Promise<void> => {
        try {
            const logger = new BuildsRedisLogger(connection);
            const job: Job | undefined = await logger.fromJobID(jobId, builds_queue);
            if (job) {
                const jobdata: BuildJobData = job.data;
                const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
                void job.remove();
                await repo.notify(job, "failed", "Build failed.");
                void createFailedBuildNotification(repo, jobId, jobdata, `🚫 Build for ${jobdata.srcrepo} failed`);
                await logger.end_log();
            }
        } catch (error) {
            console.error(error);
        }
    });
    builds_queue_events.on("completed", async ({ jobId }): Promise<void> => {
        try {
            const logger = new BuildsRedisLogger(connection);
            const job: Job | undefined = await logger.fromJobID(jobId, builds_queue);
            if (job) {
                const jobdata: BuildJobData = job.data;
                const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
                const [err, out] = await to(job.waitUntilFinished(builds_queue_events));
                void job.remove();
                if (!err && out === BuildStatus.ALREADY_BUILT) {
                    await repo.notify(job, "canceled", "Build skipped because package was already built.");
                    await logger.end_log();
                }
            }
        } catch (error) {
            console.error(error);
        }
    });

    database_worker.on("completed", async (job: Job): Promise<void> => {
        try {
            const jobdata: DatabaseJobData = job.data;
            const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
            await repo.notify(job, "success", "Package successfully deployed.");
            void createDeploymentNotification(jobdata.packages, `📣 New deployment to ${jobdata.srcrepo}`);
            const logger = new BuildsRedisLogger(connection);
            logger.fromJob(job);
            await logger.end_log();
        } catch (error) {
            console.error(error);
        }
    });
    database_worker.on("failed", async (job: Job | undefined): Promise<void> => {
        try {
            if (!job) return;
            const jobdata: DatabaseJobData = job.data;
            const repo: Repo = repo_manager.getRepo(jobdata.srcrepo);
            await repo.notify(job, "failed", "Error adding package to database.");
            void createDeploymentNotification(jobdata.packages, `🚨 Failed deploying to ${jobdata.srcrepo}`);
            const logger = new BuildsRedisLogger(connection);
            logger.fromJob(job);
            await logger.end_log();
        } catch (error) {
            console.error(error);
        }
    });

    void publishSettingsObject(redis_connection_manager, settings);

    docker_manager
        .scheduledPull(settings.builder.image)
        .then(() => {
            database_worker.resume();
            dispatch_worker.resume();
            console.log("Ready to deploy packages.");
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });

    return { database_worker, dispatch_worker };
}

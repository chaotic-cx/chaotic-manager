import { URL } from "url";
import to from "await-to-js";
import type { LoggerInstance } from "moleculer";
import type { CoordinatorJob, PacmanRepo } from "./types";

export type GitlabState = "pending" | "running" | "success" | "failed" | "canceled";

class GitlabNotifier {
    constructor(
        public gitlab_id: string,
        public token: string,
        public check_name: string,
        public base_log_url: URL,
        public chaoticLogger: LoggerInstance,
    ) {}

    getLogUrl(job: CoordinatorJob) {
        const url = new URL(this.base_log_url.toString());
        url.searchParams.set("timestamp", job.timestamp.toString());
        url.searchParams.set("id", job.pkgbase);
        return {
            url: url.toString(),
            target_repo: job.target_repo,
            pkgbase: job.pkgbase,
        };
    }

    async notify(job: CoordinatorJob, status?: GitlabState, description?: string) {
        if (job.commit === undefined) return;
        // format of job.data.commit is: commit:pipeline_id, but pipeline_id is optional
        const commit_split = job.commit.split(":");
        const commit = commit_split[0];
        const pipeline_id = commit_split.length > 1 ? commit_split[1] : undefined;

        const log_url = this.getLogUrl(job);

        const [err, out] = await to(
            fetch(`https://gitlab.com/api/v4/projects/${this.gitlab_id}/statuses/${commit}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "PRIVATE-TOKEN": this.token,
                },
                body: JSON.stringify({
                    state: status,
                    context: this.check_name.replace("%pkgbase%", log_url.pkgbase),
                    target_url: log_url.url,
                    description: description,
                    pipeline_id,
                }),
            }),
        );
        if (err || !out) {
            this.chaoticLogger.error(err);
            return;
        }

        if (out.status < 200 || out.status >= 300) {
            this.chaoticLogger.error(await out.text());
            return;
        }
    }
}

export class Repo {
    constructor(
        public id: string,
        public repo: string,
        private notifier: GitlabNotifier | undefined,
    ) {}

    async notify(job: CoordinatorJob, status?: GitlabState, description?: string) {
        if (this.notifier !== undefined) await this.notifier.notify(job, status, description);
    }

    getUrl() {
        return this.repo;
    }

    setNotifier(notifier: GitlabNotifier) {
        this.notifier = notifier;
    }
}

export class TargetRepo {
    extra_repos: PacmanRepo[] = [];
    extra_keyrings: URL[] = [];

    constructor(public name: string) {}

    fromObject(obj: any) {
        if (typeof obj.extra_repos != "undefined") {
            if (!Array.isArray(obj.extra_repos)) throw new Error("Invalid extra_repos");
            for (const repo of obj.extra_repos) {
                if (typeof repo.name !== "string" || !Array.isArray(repo.servers))
                    throw new Error("Attempted to add invalid repo");
            }
            this.extra_repos = obj.extra_repos;
        }
        if (typeof obj.extra_keyrings != "undefined") {
            if (!Array.isArray(obj.extra_keyrings)) throw new Error("Invalid extra_keyrings");
            for (let link of obj.extra_keyrings) {
                if (typeof link !== "string") throw new Error("Attempted to add invalid gpg link");
                // Normalize link
                link = new URL(link);
            }
            this.extra_keyrings = obj.extra_keyrings;
        }
    }

    toObject() {
        return {
            extra_repos: this.extra_repos,
            extra_keyrings: this.extra_keyrings.map((link) => link.toString()),
        };
    }

    repoToString(): string {
        let out = "";
        for (const repo of this.extra_repos) {
            out += `[${repo.name}]\n`;
            for (const server of repo.servers) {
                out += `Server = ${server}\n`;
            }
        }
        return out;
    }

    keyringsToBashArray(): string {
        let out = "";
        for (const link of this.extra_keyrings) {
            out += link.toString() + " ";
        }
        return out;
    }
}

export class RepoManager {
    repos: Record<string, Repo> = {};
    target_repos: Record<string, TargetRepo> = {};

    constructor(
        public base_log_url: URL | undefined,
        public chaoticLogger: LoggerInstance,
    ) {
        this.chaoticLogger = chaoticLogger;
    }

    repoFromObject(obj: object) {
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value.url !== "string") {
                throw new Error("Invalid repo object");
            }
            this.repos[key] = new Repo(key, value["url"], undefined);
        }
    }

    targetRepoFromObject(obj: object) {
        for (const [key, value] of Object.entries(obj)) {
            const repo = (this.target_repos[key] = new TargetRepo(key));
            repo.fromObject(value);
        }
    }

    repoToObject() {
        const out: Record<string, { url: string }> = {};
        for (const [key, value] of Object.entries(this.repos)) {
            out[key] = {
                url: value.getUrl(),
            };
        }
        return out;
    }

    targetRepoToObject() {
        const out: Record<
            string,
            {
                extra_repos: PacmanRepo[];
                extra_keyrings: string[];
            }
        > = {};
        for (const [key, value] of Object.entries(this.target_repos)) {
            out[key] = value.toObject();
        }
        return out;
    }

    notifiersFromObject(obj: object) {
        if (!this.base_log_url) {
            this.chaoticLogger.warn("No base log url set, GitLab notifiers disabled");
            return;
        }
        for (const [key, value] of Object.entries(obj)) {
            if (
                typeof value.id !== "string" ||
                typeof value.token !== "string" ||
                typeof value.check_name !== "string"
            ) {
                throw new Error("Invalid notifier object");
            }
            if (typeof this.repos[key] === "undefined") {
                this.chaoticLogger.warn(`Notifier for non-existent repo ${key}`);
                continue;
            }
            this.repos[key].setNotifier(
                new GitlabNotifier(
                    value["id"],
                    value["token"],
                    value["check_name"],
                    this.base_log_url,
                    this.chaoticLogger,
                ),
            );
        }
    }

    async notify(job: CoordinatorJob, status?: GitlabState, description?: string) {
        if (typeof this.repos[job.source_repo] !== "undefined")
            await this.repos[job.source_repo].notify(job, status, description);
    }

    getRepo(repo: string | undefined): Repo {
        let out: Repo | undefined;
        // Default: pick the first repo
        if (repo === undefined) {
            out = Object.values(this.repos)[0];
        } else {
            out = this.repos[repo];
            if (out === undefined) throw new Error(`Repo ${repo} not found`);
        }
        return out as Repo;
    }

    getTargetRepo(repo: string) {
        const out = this.target_repos[repo];
        if (out === undefined) throw new Error(`Target repo ${repo} not found`);
        return out;
    }
}

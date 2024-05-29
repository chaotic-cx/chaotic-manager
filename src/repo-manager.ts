import to from "await-to-js";
import { Job } from "bullmq";
import { PacmanRepo } from "./types";
import { URL } from "url";
import { splitJobId } from "./utils";

export type GitlabState = "pending" | "running" | "success" | "failed" | "canceled";

class GitlabNotifier {
    constructor(
        public gitlab_id: string,
        public token: string,
        public check_name: string,
        public base_log_url: URL,
    ) {}

    getLogUrl(job: Job) {
        const { target_repo, pkgbase } = splitJobId(job.id as string);
        const url = new URL(this.base_log_url.toString());
        url.searchParams.set("timestamp", job.data.timestamp);
        url.searchParams.set("id", pkgbase);
        return {
            url: url.toString(),
            target_repo: target_repo,
            pkgbase: pkgbase,
        };
    }

    async notify(job: Job, status?: GitlabState, description?: string) {
        if (job.data.commit === undefined) return;
        // format of job.data.commit is: commit:pipeline_id, but pipeline_id is optional
        const commit_split = job.data.commit.split(":");
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
            console.error(err);
            return;
        }

        if (out.status < 200 || out.status >= 300) {
            console.error(await out.text());
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

    async notify(job: Job, status?: GitlabState, description?: string) {
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

    constructor(public base_log_url: URL | undefined) {}

    repoFromObject(obj: Object) {
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value.url !== "string") {
                throw new Error("Invalid repo object");
            }
            this.repos[key] = new Repo(key, value["url"], undefined);
        }
    }

    targetRepoFromObject(obj: Object) {
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

    notifiersFromObject(obj: Object) {
        if (!this.base_log_url) {
            console.warn("No base log url set, gitlab notifiers disabled");
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
                console.warn(`Notifier for non-existant repo ${key}`);
                continue;
            }
            this.repos[key].setNotifier(
                new GitlabNotifier(value["id"], value["token"], value["check_name"], this.base_log_url),
            );
        }
    }

    async notify(job: Job, status?: GitlabState, description?: string) {
        if (typeof this.repos[job.data.repo] !== "undefined")
            await this.repos[job.data.repo].notify(job, status, description);
    }

    getRepo(repo: string | undefined) {
        let out;
        // Default: pick the first repo
        if (repo === undefined) {
            out = Object.values(this.repos)[0];
        } else {
            out = this.repos[repo];
            if (out === undefined) throw new Error(`Repo ${repo} not found`);
        }
        return out;
    }

    getTargetRepo(repo: string) {
        const out = this.target_repos[repo];
        if (out === undefined) throw new Error(`Target repo ${repo} not found`);
        return out;
    }
}

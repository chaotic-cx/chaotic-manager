import to from 'await-to-js';
import { Job } from 'bullmq';
import { URL } from 'url';
import { splitJobId } from './utils';

export type GitlabState = 'pending' | 'running' | 'success' | 'failed' | 'canceled';

class GitlabNotifier {
    constructor (public gitlab_id: string, public token: string, public check_name: string, public base_log_url: URL) {
    }

    getLogUrl(job: Job) {
        var { target_repo, pkgbase } = splitJobId(job.id as string);
        var url = new URL(this.base_log_url.toString());
        url.searchParams.set('timestamp', job.data.timestamp);
        url.searchParams.set('id', pkgbase);
        return {
            url: url.toString(),
            target_repo: target_repo,
            pkgbase: pkgbase
        }
    }

    async notify(job: Job, status?: GitlabState, description?: string) {
        if (job.data.commit === undefined)
            return;
        // format of job.data.commit is: commit:pipeline_id, but pipeline_id is optional
        const commit_split = job.data.commit.split(':');
        const commit = commit_split[0];
        const pipeline_id = commit_split.length > 1 ? commit_split[1] : undefined;

        var log_url = this.getLogUrl(job);

        var [err, out] = await to(fetch(`https://gitlab.com/api/v4/projects/${this.gitlab_id}/statuses/${commit}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'PRIVATE-TOKEN': this.token
            },
            body: JSON.stringify({
                state: status,
                context: this.check_name.replace("%pkgbase%", log_url.pkgbase),
                target_url: log_url.url,
                description: description,
                pipeline_id
            })
        }));
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
    constructor(public id: string, public repo: string, private notifier: GitlabNotifier | undefined) {}

    async notify(job: Job, status?: GitlabState, description?: string) {
        if (this.notifier !== undefined)
            await this.notifier.notify(job, status, description);
    }

    getUrl() {
        return this.repo;
    }

    setNotifier(notifier: GitlabNotifier) {
        this.notifier = notifier;
    }
}

export class RepoManager {
    repos: { [key: string]: Repo } = {};

    constructor(public base_log_url: URL | undefined) {
    }

    fromObject(obj: Object) {
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value.url !== 'string') {
                throw new Error('Invalid repo object');
            }
            this.repos[key] = new Repo(key, value['url'], undefined);
        }
    }

    toObject() {
        var out: { [key: string]: { url: string } } = {};
        for (const [key, value] of Object.entries(this.repos)) {
            out[key] = {
                url: value.getUrl()
            };
        }
        return out;
    }

    notifiersFromObject(obj: Object) {
        if (!this.base_log_url) {
            console.warn("No base log url set, gitlab notifiers disabled");
            return;
        }
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value.id !== 'string' || typeof value.token !== 'string' || typeof value.check_name !== 'string') {
                throw new Error('Invalid notifier object');
            }
            if (typeof this.repos[key] === 'undefined') {
                console.warn(`Notifier for non-existant repo ${key}`);
                continue;
            }
            this.repos[key].setNotifier(new GitlabNotifier(value['id'], value['token'], value['check_name'], this.base_log_url));
        }
    }

    async notify(job: Job, status?: GitlabState, description?: string) {
        if (typeof this.repos[job.data.repo] !== 'undefined')
            await this.repos[job.data.repo].notify(job, status, description);
    }

    getRepo(repo: string | undefined) {
        var out;
        // Default: pick the first repo
        if (repo === undefined) {
            out = Object.values(this.repos)[0];
        }
        else {
            out = this.repos[repo];
            if (out === undefined)
                throw new Error(`Repo ${repo} not found`);
        }
        return out;
    }
}
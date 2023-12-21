import to from 'await-to-js';
import { Job } from 'bullmq';
import { URL } from 'url';

class GitlabNotifier {
    constructor (public gitlab_id: string, public token: string, public check_name: string, public base_log_url: string) {
    }

    getLogUrl(job: Job) {
        return `${this.base_log_url}/${job.id}/${job.data.timestamp}`;
    }

export class Repo {
    constructor(public id: string, public repo: string, private notifier: GitlabNotifier | undefined) {}

    async notify(job: Job) {
        if (this.notifier !== undefined)
            await this.notifier.notify(job);
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
            this.repos[key].setNotifier(new GitlabNotifier(value['id'], value['token'], value['check_name'], this.base_log_url.toString()));
        }
    }

    async notify(job: Job) {
        if (typeof this.repos[job.data.repo] !== 'undefined')
            await this.repos[job.data.repo].notify(job);
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
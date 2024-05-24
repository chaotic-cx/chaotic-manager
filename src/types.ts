import {JobType} from "bullmq";

export type PacmanRepo = {
    name: string,
    servers: string[],
};

export type RemoteSettings = {
    database: {
        ssh: {
            host: string,
            port: number,
            user: string,
        },
        landing_zone: string,
    };
    builder: {
        image: string
    },
    repos: {
        [key: string]: {
            url: string
        }
    },
    target_repos: {
        [key: string]: {
            extra_repos: PacmanRepo[],
            extra_keyrings: string[]
        }
    },
    version: number;
};

export type BuildJobData = {
    arch: string,
    srcrepo: string | undefined,
    timestamp: number,
    commit: string | undefined,
    deptree: {
        dependencies: string[],
        dependents: string[],
    } | null,
    repo_files: string[],
};

export type DatabaseJobData = Omit<BuildJobData, "repo_files"> & {
    packages: string[],
};

export type DispatchJobData = {
    type: "add-job",
    data: {
        target_repo: string,
        source_repo: string,
        commit: string | undefined,
        arch: string,
        packages: {
            pkgbase: string,
            deptree: {
                dependencies: string[],
                dependents: string[],
            } | null,
        }[]
    },
};

export enum BuildStatus {
    SUCCESS,
    ALREADY_BUILT
}

// The object the API should return on /api/packages calls
export interface PackagesReturnObject {
    [x: string]: {
        arch: string,
        srcrepo: string,
        timestamp: string,
        repo_files: string
    }
}

export type StatsReturnObject = {
    [x in JobType]?: {
        count: string;
        packages: string;
    };
};

export const current_version: number = 8;

export const SEVEN_DAYS: number = 60 * 60 * 24 * 7;
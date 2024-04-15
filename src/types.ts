
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
    deptree?: {
        dependencies: string[],
        dependents: string[],
    },
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
            deptree?: {
                dependencies: string[],
                dependents: string[],
            },
        }[]
    },
};

export const current_version = 6;

export const SEVEN_DAYS = 60 * 60 * 24 * 7;
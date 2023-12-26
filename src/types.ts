
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

export type JobData = {
    arch: string,
    srcrepo: string | undefined,
    timestamp: number,
    commit: string | undefined
};

export const current_version = 5;

export const SEVEN_DAYS = 60 * 60 * 24 * 7;
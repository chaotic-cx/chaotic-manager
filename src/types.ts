
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
    version: number;
};

export type JobData = {
    arch: string,
    srcrepo: string | undefined,
    timestamp: number,
    commit: string | undefined
};

export const current_version = 4;

export const SEVEN_DAYS = 60 * 60 * 24 * 7;
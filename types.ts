
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
        image: string,
        package_repo: string,
    }
    version: number;
};

export const current_version = 2;
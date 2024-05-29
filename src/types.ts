export interface PacmanRepo {
    name: string;
    servers: string[];
}

export interface RemoteSettings {
    database: {
        ssh: {
            host: string;
            port: number;
            user: string;
        };
        landing_zone: string;
    };
    builder: {
        image: string;
        name?: string;
    };
    repos: Record<
        string,
        {
            url: string;
        }
    >;
    target_repos: Record<
        string,
        {
            extra_repos: PacmanRepo[];
            extra_keyrings: string[];
        }
    >;
    version: number;
}

export interface BuildJobData {
    arch: string;
    srcrepo: string | undefined;
    timestamp: number;
    commit: string | undefined;
    deptree: {
        dependencies: string[];
        dependents: string[];
    } | null;
    repo_files: string[];
}

export type DatabaseJobData = Omit<BuildJobData, "repo_files"> & {
    packages: string[];
};

export interface DispatchJobData {
    type: "add-job";
    data: {
        target_repo: string;
        source_repo: string;
        commit: string | undefined;
        arch: string;
        packages: {
            pkgbase: string;
            deptree: {
                dependencies: string[];
                dependents: string[];
            } | null;
        }[];
    };
}

export enum BuildStatus {
    SUCCESS,
    ALREADY_BUILT,
}

export const current_version = 8;

export const SEVEN_DAYS: number = 60 * 60 * 24 * 7;
export const ONE_DAY: number = 1000 * 60 * 60 * 24;

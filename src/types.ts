import { CorsOptions } from "cors";

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
        timeout?: number;
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
    repo?: string;
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
    TIMED_OUT,
}

// The object the API should return on /api/packages calls
export type PackagesReturnObject = Record<
    string,
    {
        arch: string;
        srcrepo: string;
        timestamp: string;
        repo_files: string;
    }
>[];

export type StatsReturnObject = Record<
    string,
    {
        count: number;
        packages: (string | undefined)[];
    }
>[];

export interface MetricsReturnObject {
    builder_queue: {
        completed: number;
        failed: number;
    };
    database_queue: {
        completed: number;
        failed: number;
    };
}

export const current_version = 8;

const ONE_UNIX_DAY = 1000 * 60 * 60 * 24;
const ONE_UNIX_MONTH = 1000 * 60 * 60 * 24 * 30;

export const SOURCECACHE_MAX_LIFETIME = ONE_UNIX_MONTH;
export const HTTP_CACHE_MAX_AGE = ONE_UNIX_DAY;

export const ALLOWED_CORS_ORIGINS = ["https://aur.chaotic.cx", "https://caur-frontend.pages.dev"];
export const ALLOWED_CORS_METHODS = ["GET"];
export const corsOptions: CorsOptions = {
    origin: ALLOWED_CORS_ORIGINS,
    methods: ALLOWED_CORS_METHODS,
};

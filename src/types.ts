import type { CorsOptions } from "cors";

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
        ci_code_skip?: number;
        image: string;
        is_hpc?: boolean;
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

export enum BuildStatus {
    SUCCESS = 0,
    ALREADY_BUILT = 1,
    SKIPPED = 2,
    FAILED = 3,
    TIMED_OUT = 4,
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

export type Database_Action_fetchUploadInfo_Response = {
    database: {
        ssh: {
            host: string;
            port: number;
            user: string;
        };
        landing_zone: string;
    };
};

export type Database_Action_AddToDb_Params = {
    pkgbase: string;
    arch: string;
    pkgfiles: string[];
    target_repo: string;
    source_repo: string;
    builder_image: string;
    timestamp: number;
};

export type Database_Action_AutoRepoRemove_Params = {
    pkgbases: string[];
    arch: string;
    repo: string;
    builder_image: string;
};

export type Database_Action_GenerateDestFillerFiles_Params = {
    target_repo: string;
    arch: string;
};

export type Builder_Action_BuildPackage_Params = {
    target_repo: string;
    source_repo: string;
    source_repo_url: string;
    arch: string;
    pkgbase: string;
    builder_image: string;
    extra_repos: string;
    extra_keyrings: string;
    upload_info: Database_Action_fetchUploadInfo_Response;
    timestamp: number;
    commit?: string;
};

export type BuildStatusReturn = {
    success: BuildStatus;
    packages?: string[];
};

export interface DatabaseRemoveStatusReturn {
    success: boolean;
}

export interface Coordinator_Action_PackageMetaData_Single {
    pkgbase: string;
    pkgnames?: string[];
    dependencies?: string[];
    build_class?: number;
}

export type Coordinator_Action_PackageMetaData_List = Coordinator_Action_PackageMetaData_Single[];

export type Coordinator_Action_AddJobsToQueue_Params = {
    target_repo: string;
    source_repo: string;
    commit: string | undefined;
    arch: string;
    packages: Coordinator_Action_PackageMetaData_List;
};

export type Coordinator_Action_AutoRepoRemove_Params = Omit<Database_Action_AutoRepoRemove_Params, "builder_image">;

export enum BuildClass {
    "Small" = 0,
    "Medium" = 1,
    "Heavy" = 2,
}

export class CoordinatorJob {
    pkgbase: string;
    target_repo: string;
    source_repo: string;
    arch: string;
    build_class: number;
    pkgnames: string[] | undefined;
    dependencies: string[] | undefined;
    node: string;
    timestamp: number;
    commit: string | undefined;
    replacement?: CoordinatorJob;

    constructor(
        pkgbase: string,
        target_repo: string,
        source_repo: string,
        arch: string,
        build_class: number,
        pkgnames: string[] | undefined,
        dependencies: string[] | undefined,
        timestamp: number,
        commit: string | undefined,
    ) {
        this.pkgbase = pkgbase;
        this.target_repo = target_repo;
        this.source_repo = source_repo;
        this.arch = arch;
        this.build_class = build_class;
        this.pkgnames = pkgnames;
        this.dependencies = dependencies;
        this.timestamp = timestamp;
        this.commit = commit;

        this.node = "";
    }

    toId(): string {
        return `${this.target_repo}/${this.arch}/${this.pkgbase}`;
    }
}

export interface SuccessNotificationParams {
    packages: string[];
    event: string;
}

export interface FailureNotificationParams {
    pkgbase: string;
    timestamp: number;
    event: string;
    commit?: string;
    source_repo_url: string;
}

export interface GenericNotificationParams {
    message: string;
}

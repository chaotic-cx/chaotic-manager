import type { CorsOptions } from "cors";
import type { GenericObject } from "moleculer";

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
    CANCELED = 5,
    CANCELED_REQUEUE = 6,
    SOFTWARE_FAILURE = 7,
}

// The object the API should return on /api/packages calls
export type PackagesReturnObject = Record<
    string,
    {
        arch: string;
        build_class: BuildClass;
        repo_files?: string;
        srcrepo: string;
        timestamp: number;
    }
>[];

export interface StatsReturnObject {
    active: {
        count: number;
        packages: { name: string; node: string; build_class: number | string; liveLog?: string }[];
    };
    waiting: {
        count: number;
        packages: { name: string; build_class: BuildClass }[];
    };
    idle: {
        count: number;
        nodes: { name: string; build_class: number }[];
    };
}

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

// This value is used to isolate builder nodes that are on a different version of the internal API than the coordinator.
export const current_version = 1;

const ONE_UNIX_DAY = 1000 * 60 * 60 * 24;
const ONE_UNIX_MONTH = 1000 * 60 * 60 * 24 * 30;

export const MAX_SHUTDOWN_TIME = 1000 * 30;

export const SOURCECACHE_MAX_LIFETIME = ONE_UNIX_MONTH;
export const HTTP_CACHE_MAX_AGE = ONE_UNIX_DAY;

export const ALLOWED_CORS_ORIGINS = [
    "https://aur.chaotic.cx",
    "https://caur-frontend.pages.dev",
    "https://v2.caur-frontend.pages.dev",
];
export const ALLOWED_CORS_METHODS = ["GET"];
export const corsOptions: CorsOptions = {
    origin: ALLOWED_CORS_ORIGINS,
    methods: ALLOWED_CORS_METHODS,
};

export interface Database_Action_fetchUploadInfo_Response {
    database: {
        ssh: {
            host: string;
            port: number;
            user: string;
        };
        landing_zone: string;
    };
}

export interface Database_Action_AddToDb_Params {
    arch: string;
    builder_image: string;
    pkgbase: string;
    pkgfiles: string[];
    source_repo: string;
    target_repo: string;
    timestamp: number;
}

export interface Database_Action_AutoRepoRemove_Params {
    arch: string;
    builder_image: string;
    pkgbases: string[];
    repo: string;
}

export interface Database_Action_GenerateDestFillerFiles_Params {
    target_repo: string;
    arch: string;
}

export interface Builder_Action_BuildPackage_Params {
    arch: string;
    builder_image: string;
    commit?: string;
    extra_keyrings: string;
    extra_repos: string;
    pkgbase: string;
    source_repo: string;
    source_repo_url: string;
    target_repo: string;
    timestamp: number;
    upload_info: Database_Action_fetchUploadInfo_Response;
    arch_mirror?: string;
}

export interface BuildStatusReturn {
    duration?: number;
    namcapAnalysis?: string;
    packages?: string[];
    success: BuildStatus;
}

export interface DatabaseRemoveStatusReturn {
    success: boolean;
}

export interface Coordinator_Action_PackageMetaData_Single {
    build_class: BuildClass | null;
    dependencies?: string[];
    pkgbase: string;
    pkgnames?: string[];
}

export type Coordinator_Action_PackageMetaData_List = Coordinator_Action_PackageMetaData_Single[];

export interface Coordinator_Action_AddJobsToQueue_Params {
    arch: string;
    commit: string | undefined;
    packages: Coordinator_Action_PackageMetaData_List;
    source_repo: string;
    target_repo: string;
    arch_mirror: string | undefined;
}

export type Coordinator_Action_AutoRepoRemove_Params = Omit<Database_Action_AutoRepoRemove_Params, "builder_image">;

export type BuildClass = string | number;

export class CoordinatorJobSavable {
    constructor(
        public pkgbase: string,
        public target_repo: string,
        public source_repo: string,
        public arch: string,
        public build_class: BuildClass,
        public pkgnames: string[] | undefined,
        public dependencies: string[] | undefined,
        public commit: string | undefined,
        public arch_mirror: string | undefined,
    ) {}

    toId(): string {
        return `${this.target_repo}/${this.arch}/${this.pkgbase}`;
    }
}

export class CoordinatorJob extends CoordinatorJobSavable {
    constructor(
        pkgbase: string,
        target_repo: string,
        source_repo: string,
        arch: string,
        build_class: BuildClass,
        pkgnames: string[] | undefined,
        dependencies: string[] | undefined,
        commit: string | undefined,
        public timestamp: number,
        arch_mirror: string | undefined,
    ) {
        super(pkgbase, target_repo, source_repo, arch, build_class, pkgnames, dependencies, commit, arch_mirror);
    }
}

export interface DeploymentNotificationParams {
    commit?: string;
    event: string;
    node: string | undefined;
    pkgbase: string;
    source_repo_url: string;
    packages?: string[];
    timestamp: number;
}

export interface GenericNotificationParams {
    message: string;
}

export interface MetricsTimerLabels {
    pkgname: string;
    target_repo: string;
    build_class: BuildClass;
    arch: string;
    node: string;
}

export interface MetricsCounterLabels {
    arch: string;
    build_class: BuildClass;
    builder_name: string;
    commit?: string;
    duration?: number;
    logUrl?: string;
    pkgname: string;
    replaced: boolean;
    status?: BuildStatus;
    target_repo: string;
    timestamp: number;
    namcapAnalysis?: string;
}

export interface MetricsGaugeLabels {
    build_class: BuildClass[];
    pkgname: string[];
    target_repo: string[];
}

export interface MetricsHistogramLabels {
    arch: string;
    pkgbase: string;
    target_repo: string;
}

export interface MetricsHistogramContext {
    duration: number;
    labels: MetricsHistogramLabels;
}

export interface MetricsGaugeContext {
    count: number;
    labels?: MetricsGaugeLabels;
}

export type MetricsRequest = {
    [p in ValidMetrics]?: MetricsEntry;
};

export interface MetricsEntry {
    value: number;
    labels: GenericObject;
    timestamp: number;
}

export type ValidMetrics =
    | "builders.active"
    | "builders.idle"
    | "builds.alreadyBuilt"
    | "builds.cancelled"
    | "builds.failed.build"
    | "builds.failed.software"
    | "builds.failed.timeout"
    | "builds.skipped"
    | "builds.success"
    | "builds.time.elapsed"
    | "builds.total"
    | "queue.current";

export interface MetricsDatabaseLabels {
    arch: string;
    pkgname: string;
    target_repo: string;
}

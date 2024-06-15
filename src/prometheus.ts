import * as Prometheus from "prom-client";
import { Queue } from "bullmq";

/**
 *  Prometheus metrics, counting the number of builds and their outcome via labels
 */
const buildMetricsCount = new Prometheus.Counter({
    name: "chaotic_manager_builder_total_count",
    help: "Count of total runs made by this builder instance",
    labelNames: ["status", "repo"],
});

/**
 * Creates a new Prometheus metric for elapsed time between start and end of builds.
 * Creates 100 buckets, starting on 0 and a width of 120 (seconds)
 */
export const buildMetricsTime = new Prometheus.Histogram({
    name: "chaotic_manager_builder_elapsed_time",
    help: "Collects the time it takes to build a package without database process",
    labelNames: ["jobId", "outcome"],
    buckets: Prometheus.linearBuckets(0, 120, 100),
});

/**
 * Creates a new Prometheus metric for elapsed time between the start of a build and the final deployment.
 * Creates 100 buckets, starting on 0 and a width of 120 (seconds)
 */
export const buildToDeployMetricsTime = new Prometheus.Histogram({
    name: "chaotic_manager_build_to_deployment_elapsed_time",
    help: "Collects the time it takes to build and fully deploy a package",
    labelNames: ["jobId", "outcome"],
    buckets: Prometheus.linearBuckets(0, 120, 100),
});

/**
 * Creates a new Prometheus metric for showing a gauge of the currently active builds jobs.
 */
const amountActiveBuildJobs = new Prometheus.Gauge({
    name: "chaotic_manager_active_build_jobs",
    help: "Shows the amount of currently active build jobs",
});

/**
 * Creates a new Prometheus metric for showing a gauge of the currently active database jobs.
 */
const amountActiveDatabaseJobs = new Prometheus.Gauge({
    name: "chaotic_manager_running_builds",
    help: "Shows the amount of currently active database jobs",
});

/**
 * Creates a Prometheus metric for showing the number of currently waiting build jobs.
 */
const amountWaitingBuildJobs = new Prometheus.Gauge({
    name: "chaotic_manager_active_build_jobs",
    help: "Shows the amount of currently waiting build jobs",
});

/**
 * Creates a Prometheus metric for showing the number of currently waiting database jobs.
 */
const amountWaitingDatabaseJobs = new Prometheus.Gauge({
    name: "chaotic_manager_active_build_jobs",
    help: "Shows the amount of currently waiting database jobs",
});

/**
 * Register the metrics with the Prometheus client and start the timer.
 */
export function registerMetrics(): void {
    Prometheus.register.registerMetric(buildMetricsCount);
    Prometheus.register.registerMetric(buildMetricsTime);
    Prometheus.register.registerMetric(buildToDeployMetricsTime);
    Prometheus.register.registerMetric(amountActiveBuildJobs);
    Prometheus.register.registerMetric(amountActiveDatabaseJobs);
    Prometheus.register.registerMetric(amountWaitingBuildJobs);
    Prometheus.register.registerMetric(amountWaitingDatabaseJobs);
}

/**
 * Increase the count of build counter. This function should be called at the
 * end of a build process.
 */
export function increaseBuildCountMetrics(repo: string, status: string): void {
    buildMetricsCount.inc({ status, repo });
}

/**
 * Take the elapsed time of a build process. This function should be called at
 * the end of a build process.
 */
export function increaseBuildElapsedTimeMetrics(jobId: string, outcome: string, time: number): void {
    buildMetricsTime.observe({ jobId, outcome }, time);
}

/**
 * Take the elapsed time of a build process till deployment. This function should be called at
 * the end of a deployment (database) process.
 */
export function increaseBuildToDeployElapsedTimeMetrics(jobId: string, outcome: string, time: number): void {
    buildToDeployMetricsTime.observe({ jobId, outcome }, time);
}

/**
 * Increase the amount of running builds. This function should be called at the
 * start of a build process.
 */
async function setBuilderQueueMetrics(builderQueue: Queue): Promise<void> {
    builderQueue.getJobCounts("active").then((currentJobs) => {
        amountActiveBuildJobs.set(currentJobs.length);
    });
    builderQueue.getJobCounts("waiting").then((currentJobs) => {
        amountWaitingBuildJobs.set(currentJobs.length);
    });
}
async function setDatabaseQueueMetrics(databaseQueue: Queue): Promise<void> {
    databaseQueue.getJobCounts("active").then((currentJobs) => {
        amountActiveDatabaseJobs.set(currentJobs.length);
    });
    databaseQueue.getJobCounts("waiting").then((currentJobs) => {
        amountWaitingDatabaseJobs.set(currentJobs.length);
    });
}

/**
 * Get the current metrics from the Prometheus client.
 */
export async function getMetrics(builderQueue: Queue, databaseQueue: Queue): Promise<string> {
    await setBuilderQueueMetrics(builderQueue);
    await setDatabaseQueueMetrics(databaseQueue);
    return Prometheus.register.metrics();
}

import type { Queue } from "bullmq";
import * as Prometheus from "prom-client";

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
const amountBuildJobs = new Prometheus.Gauge({
    name: "chaotic_manager_active_build_jobs",
    help: "Shows the amount of currently active build jobs",
    labelNames: ["status"],
});

/**
 * Creates a new Prometheus metric for showing a gauge of the currently active database jobs.
 */
const amountDatabaseJobs = new Prometheus.Gauge({
    name: "chaotic_manager_active_database_jobs",
    help: "Shows the amount of currently active database jobs",
    labelNames: ["status"],
});

/**
 * Register the metrics with the Prometheus client and start the timer.
 */
export function registerMetrics(): void {
    console.log("Registering Prometheus metrics.");
    Prometheus.register.registerMetric(buildMetricsCount);
    Prometheus.register.registerMetric(buildMetricsTime);
    Prometheus.register.registerMetric(buildToDeployMetricsTime);
    Prometheus.register.registerMetric(amountBuildJobs);
    Prometheus.register.registerMetric(amountDatabaseJobs);
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
 * Set the amount of active and waiting build jobs. This function gets called whenever new metrics are scraped.
 */
async function setBuilderQueueMetrics(builderQueue: Queue): Promise<void> {
    const active = (await builderQueue.getJobCounts("active"))[0];
    const waiting: number = (await builderQueue.getJobCounts("waiting"))[0];
    amountBuildJobs.set({ status: "active" }, active ? active : 0);
    amountBuildJobs.set({ status: "waiting" }, waiting ? waiting : 0);
}

/**
 * Set the amount of active and waiting database jobs. This function gets called whenever new metrics are scraped.
 */
async function setDatabaseQueueMetrics(databaseQueue: Queue): Promise<void> {
    const active: number = (await databaseQueue.getJobCounts("active"))[0];
    const waiting: number = (await databaseQueue.getJobCounts("waiting"))[0];
    amountDatabaseJobs.set({ status: "active" }, active ? active : 0);
    amountDatabaseJobs.set({ status: "waiting" }, waiting ? waiting : 0);
}

/**
 * Get the current metrics from the Prometheus client.
 */
export async function getMetrics(builderQueue: Queue, databaseQueue: Queue): Promise<string> {
    try {
        await setBuilderQueueMetrics(builderQueue);
        await setDatabaseQueueMetrics(databaseQueue);
        return Prometheus.register.metrics();
    } catch (err) {
        console.error("Error while generating Prometheus metrics:", err);
        return "Error while generating Prometheus metrics";
    }
}

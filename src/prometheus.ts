import * as Prometheus from "prom-client";

/**
 *  Prometheus metrics, counting the number of builds and their outcome via labels
 */
export const builderMetricsCount = new Prometheus.Counter({
    name: "chaotic_manager_builder_total_count",
    help: "Count of total runs made by this builder instance",
    labelNames: ["status", "repo"],
});

/**
 * The same, but for elapsed time between start and end of builds.
 * Create 100 buckets, starting on 0 and a width of 120 (seconds)
 */
export const builderMetricsTime = new Prometheus.Histogram({
    name: "chaotic_manager_builder_elapsed_time",
    help: "Count of total runs made by this builder instance",
    labelNames: ["jobId"],
    buckets: Prometheus.linearBuckets(0, 120, 100),
});

/**
 * Register the metrics with the Prometheus client and start the timer.
 */
export function registerMetrics() {
    Prometheus.register.registerMetric(builderMetricsCount);
    Prometheus.register.registerMetric(builderMetricsTime);
}

/**
 * Increase the count of build counter. This function should be called at the
 * end of a build process.
 */
export function increaseBuildCountMetrics(repo: string, status: string) {
    builderMetricsCount.inc({ status, repo });
}

/**
 * Take the elapsed time of a build process. This function should be called at
 * the end of a build process.
 */
export function increaseBuildElapsedTimeMetrics(jobId: string, time: number) {
    builderMetricsTime.observe({ jobId }, time);
}

/**
 * Get the current metrics from the Prometheus client.
 */
export function getMetrics() {
    return Prometheus.register.metrics();
}

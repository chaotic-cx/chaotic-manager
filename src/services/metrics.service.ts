import { type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import type {
    MetricsCounterLabels,
    MetricsDatabaseLabels,
    MetricsGaugeContext,
    MetricsHistogramContext,
    MetricsRequest,
    MetricsTimerLabels,
    ValidMetrics,
} from "../types";
import { MoleculerConfigCommonService } from "./moleculer.config";

/**
 * The metrics service that provides the metrics actions for other services to call.
 */
export class MetricsService extends Service {
    private metricsLogger: LoggerInstance = this.broker.getLogger("CHAOTIC-METRICS");

    constructor(broker: ServiceBroker) {
        super(broker);

        const init = this.init.bind(this);

        this.parseServiceSchema({
            name: "metrics",

            actions: {
                addToBuildTimerHistogram: this.addToBuildTimerHistogram,
                incCounterBuildSuccess: this.incCounterSuccess,
                incCounterBuildFailure: this.incCounterBuildFailure,
                incCounterSoftwareFailure: this.incCounterSoftwareFailure,
                incCounterBuildTimeout: this.incCounterBuildTimeout,
                incCounterBuildTotal: this.incCounterBuildTotal,
                incCounterAlreadyBuilt: this.incCounterAlreadyBuilt,
                incCounterBuildCancelled: this.incCounterBuildCancelled,
                incCounterBuildSkipped: this.incCounterBuildSkipped,
                incCounterDatabaseTotal: this.incCounterDatabaseTotal,
                incCounterDatabaseSuccess: this.incCounterDatabaseSuccess,
                incCounterDatabaseFailure: this.incCounterDatabaseFailure,
                startHistogramTimer: this.startHistogramTimer,
                setGaugeActiveBuilders: this.setGaugeActiveBuilders,
                setGaugeIdleBuilders: this.setGaugeIdleBuilders,
                setGaugeCurrentQueue: this.setGaugeCurrentQueue,
                getMetrics: this.getMetrics,
            },

            created() {
                init();
            },
            ...MoleculerConfigCommonService,
        });
    }

    /**
     * Initializes the metrics service by registering the metrics.
     * @private
     */
    private init() {
        this.broker.metrics.register({
            type: "counter",
            name: "database.total",
            description: "Number of total of database processes",
            labelNames: ["pkgname", "target_repo", "arch"],
            unit: "processes",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "database.success",
            description: "Number of succeeded database processes",
            labelNames: ["pkgname", "target_repo", "arch"],
            unit: "processes",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "database.failed",
            description: "Number of database process failures",
            labelNames: ["pkgname", "target_repo", "arch"],
            unit: "processes",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.total",
            description: "Number of total of builds",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.success",
            description: "Number of failed builds",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.build",
            description: "Number of build failures",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.software",
            description: "Number of failed builds due to software issues",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.timeout",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            description: "Number of timed out builds processes",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.alreadyBuilt",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            description: "Number of builds that have been skipped due to being already done",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.cancelled",
            description: "Number of cancelled builds",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.skipped",
            description: "Number of skipped builds",
            labelNames: ["pkgname", "target_repo", "build_class", "replaced", "status", "arch"],
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "histogram",
            name: "builds.time.elapsed",
            description: "Time until build finished",
            labelNames: ["target_repo", "status", "pkgname", "replaced"],
            unit: "seconds",
            linearBuckets: {
                start: 0,
                width: 100,
                count: 10,
            },
            quantiles: [60, 120, 360, 720, 1440, 2880, 4320, 5760, 7200],
            maxAgeSeconds: 60,
            ageBuckets: 10,
        });
        this.broker.metrics.register({
            type: "gauge",
            name: "builders.active",
            labelNames: ["pkgname", "target_repo", "build_class"],
            description: "Number currently active builds",
            unit: "builders",
        });
        this.broker.metrics.register({
            type: "gauge",
            name: "builders.idle",
            labelNames: ["pkgname", "target_repo", "build_class"],
            description: "Number of currently idle builders",
            unit: "builders",
        });
        this.broker.metrics.register({
            type: "gauge",
            name: "queue.current",
            description: "Number of current jobs in the queue",
            unit: "jobs",
        });

        this.metricsLogger.info("Metrics registered and service started");
    }

    /**
     * Increments the counter for build successes.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterSuccess(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build success for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.success", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for build failures.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterBuildFailure(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build failure for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.failed.build", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for software failures.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterSoftwareFailure(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: software failure for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.failed.software", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for build timeouts.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterBuildTimeout(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build timeout for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.failed.timeout", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for total builds.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterBuildTotal(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build total for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.total", labels, 1);
    }

    /**
     * Increments the counter for builds that have been skipped because they were already built.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterAlreadyBuilt(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: already built for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.alreadyBuilt", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for canceled builds.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterBuildCancelled(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build cancelled for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.cancelled", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Increments the counter for skipped builds.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterBuildSkipped(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.debug(`Counter incremented: build skipped for ${labels.pkgname}`);
        this.broker.metrics.increment("builds.skipped", labels, 1);
        this.incCounterBuildTotal(ctx);
    }

    /**
     * Starts a histogram timer for build time.
     * @param ctx The context object containing the parameters for the timer.
     * @returns A function that stops the timer and returns the elapsed time.
     */
    startHistogramTimer(ctx: Context): () => number {
        const labels = ctx.params as MetricsTimerLabels;
        this.metricsLogger.debug(`Histogram timer for ${labels.pkgname} started`);
        return this.broker.metrics.timer("builds.time.elapsed", labels);
    }

    /**
     * Sets the gauge for active builders.
     * @param ctx The context object containing the parameters for the gauge, as well as count set to set the gauge to.
     */
    setGaugeActiveBuilders(ctx: Context): void {
        const data = ctx.params as MetricsGaugeContext;
        this.metricsLogger.debug(`Gauge set: active builders to ${data.count}`);
        this.broker.metrics.set("builders.active", data.count, data.labels);
    }

    /**
     * Sets the gauge for idle builders.
     * @param ctx The context object containing the parameters for the gauge as well as count set to set the gauge to.
     */
    setGaugeIdleBuilders(ctx: Context): void {
        const data = ctx.params as MetricsGaugeContext;
        this.metricsLogger.debug(`Gauge set: idle builders to ${data.count}`);
        this.broker.metrics.set("builders.idle", data.count, data.labels);
    }

    /**
     * Sets the gauge for the current queue.
     * @param ctx The context object containing the parameters for the gauge as well as count set to set the gauge to.
     */
    setGaugeCurrentQueue(ctx: Context): void {
        const data = ctx.params as MetricsGaugeContext;
        this.metricsLogger.debug(`Gauge set: current queue to ${data.count}`);
        this.broker.metrics.set("queue.current", data.count, data.labels);
    }

    /**
     * Gets the metrics requested by the client.
     * @param ctx The context object containing the parameters for the metrics.
     * Provided can be metrics: string[], which is an array of metric names to get.
     * @returns An object containing the requested metrics.
     */
    getMetrics(ctx: Context): MetricsRequest {
        const data = ctx.params as ValidMetrics[];
        const ret: MetricsRequest = {};
        this.metricsLogger.debug("Metrics requested");

        data.forEach((metric: string) => {
            const allMetrics = this.broker.metrics.getMetric(metric).get();
            if (allMetrics === null) {
                this.metricsLogger.warn(`Metric ${metric} does not exist`);
                return;
            }
            ret[metric as ValidMetrics] = {
                value: allMetrics?.value ? allMetrics.value : null,
                labels: allMetrics?.labels ? allMetrics.labels : null,
                timestamp: allMetrics?.timestamp ? allMetrics.timestamp : null,
            };
        });

        return ret;
    }

    /**
     * Directly add a new build duration to the build time histogram.
     * @param ctx The context object containing the parameters for the histogram.
     */
    addToBuildTimerHistogram(ctx: Context): void {
        const data = ctx.params as MetricsHistogramContext;
        this.metricsLogger.debug(`Histogram timer added for ${data.labels.pkgbase}`);
        this.broker.metrics.observe("builds.time.elapsed", data.duration, data.labels);
    }

    /**
     * Increments the counter for total database processes.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterDatabaseTotal(ctx: Context): void {
        const labels = ctx.params as MetricsDatabaseLabels;
        this.metricsLogger.debug(`Counter incremented: database total for ${labels.pkgname}`);
        this.broker.metrics.increment("database.total", labels, 1);
    }

    /**
     * Increments the counter for successful database processes.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterDatabaseSuccess(ctx: Context): void {
        const labels = ctx.params as MetricsDatabaseLabels;
        this.metricsLogger.debug(`Counter incremented: database success for ${labels.pkgname}`);
        this.broker.metrics.increment("database.success", labels, 1);
        this.incCounterDatabaseTotal(ctx);
    }

    /**
     * Increments the counter for failed database processes.
     * @param ctx The context object containing the parameters for the counter.
     */
    incCounterDatabaseFailure(ctx: Context): void {
        const labels = ctx.params as MetricsDatabaseLabels;
        this.metricsLogger.debug(`Counter incremented: database failure for ${labels.pkgname}`);
        this.broker.metrics.increment("database.failed", labels, 1);
        this.incCounterDatabaseTotal(ctx);
    }
}

import { type Context, type LoggerInstance, Service, type ServiceBroker } from "moleculer";
import type { MetricsCounterLabels, MetricsTimerLabels } from "../types";
import { MoleculerConfigCommonService } from "./moleculer.config";

export class MetricsService extends Service {
    chaoticLogger: LoggerInstance = this.broker.getLogger("CHAOTIC");
    metricsLogger: LoggerInstance = this.broker.getLogger("CHAOTIC-METRICS");

    constructor(broker: ServiceBroker) {
        super(broker);

        const init = this.init.bind(this);
        this.parseServiceSchema({
            name: "chaotic-metrics",

            actions: {
                incCounterBuildSuccess: this.incCounterSuccess,
                incCounterBuildFailure: this.incCounterBuildFailure,
                incCounterSoftwareFailure: this.incCounterSoftwareFailure,
                incCounterBuildTimeout: this.incCounterBuildTimeout,
                incCounterBuildTotal: this.incCounterBuildTotal,
                incCounterAlreadyBuilt: this.incCounterAlreadyBuilt,
                incCounterBuildCancelled: this.incCounterBuildCancelled,
                incCounterBuildSkipped: this.incCounterBuildSkipped,
                startHistogramTimer: this.startHistogramTimer,
            },

            created() {
                init();
            },
            ...MoleculerConfigCommonService,
        });
    }

    private init() {
        this.broker.metrics.register({
            type: "counter",
            name: "builds.total",
            description: "Number of total of builds",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.success",
            description: "Number of failed builds",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.build",
            description: "Number of build failures",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.software",
            description: "Number of failed builds due to software issues",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.failed.timeout",
            description: "Number of timed out builds processes",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.alreadyBuilt",
            description: "Number of builds that have been skipped due to being already done",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.cancelled",
            description: "Number of cancelled builds",
            unit: "builds",
            rate: true,
        });
        this.broker.metrics.register({
            type: "counter",
            name: "builds.skipped",
            description: "Number of skipped builds",
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
            quantiles: [60, 120, 360, 720, 1440, 2880],
            maxAgeSeconds: 60,
            ageBuckets: 10,
        });

        this.metricsLogger.info("Metrics registered and service started");
    }

    incCounterSuccess(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build success");
        this.broker.metrics.increment("build.success", labels, 1);
    }

    incCounterBuildFailure(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build failure");
        this.broker.metrics.increment("build.failed.build", labels, 1);
    }

    incCounterSoftwareFailure(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: software failure");
        this.broker.metrics.increment("build.failed.software", labels, 1);
    }

    incCounterBuildTimeout(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build timeout");
        this.broker.metrics.increment("build.failed.timeout", labels, 1);
    }

    incCounterBuildTotal(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build total");
        this.broker.metrics.increment("build.total", labels, 1);
    }

    incCounterAlreadyBuilt(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: already built");
        this.broker.metrics.increment("build.already_built", labels, 1);
    }

    incCounterBuildCancelled(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build cancelled");
        this.broker.metrics.increment("build.cancelled", labels, 1);
    }

    incCounterBuildSkipped(ctx: Context): void {
        const labels = ctx.params as MetricsCounterLabels;
        this.metricsLogger.info("Counter incremented: build skipped");
        this.broker.metrics.increment("build.skipped", labels, 1);
    }

    /**
     * Starts a histogram timer for build time.
     * @param ctx The context object containing the parameters for the timer.
     * @returns A function that stops the timer and returns the elapsed time.
     */
    startHistogramTimer(ctx: Context): () => number {
        const labels = ctx.params as MetricsTimerLabels;
        this.metricsLogger.info(`Histogram timer for ${labels.pkgname} started`);
        return this.broker.metrics.timer("build.time.elapsed", labels);
    }
}

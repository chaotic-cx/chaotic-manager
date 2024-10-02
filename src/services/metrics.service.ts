import { Context, LoggerInstance, Service, ServiceBroker } from "moleculer";
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

        this.metricsLogger.info("Metrics service started");
    }

    incCounterSuccess(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: build success");
        this.broker.metrics.increment("build.success", { id: ctx.id }, 1);
    }

    incCounterBuildFailure(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: build failure");
        this.broker.metrics.increment("build.failed.build", { id: ctx.id }, 1);
    }

    incCounterSoftwareFailure(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: software failure");
        this.broker.metrics.increment("build.failed.software", { id: ctx.id }, 1);
    }

    incCounterBuildTimeout(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: build timeout");
        this.broker.metrics.increment("build.failed.timeout", { id: ctx.id }, 1);
    }

    incCounterBuildTotal(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: build total");
        this.broker.metrics.increment("build.total", { id: ctx.id }, 1);
    }

    incCounterAlreadyBuilt(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: already built");
        this.broker.metrics.increment("build.already_built", { id: ctx.id }, 1);
    }

    incCounterBuildCancelled(ctx: Context): void {
        const context = ctx.params as { replaced: boolean };
        this.metricsLogger.info("Counter incremented: build cancelled");
        this.broker.metrics.increment("build.cancelled", { id: ctx.id, replaced: context.replaced }, 1);
    }

    incCounterBuildSkipped(ctx: Context): void {
        this.metricsLogger.info("Counter incremented: build skipped");
        this.broker.metrics.increment("build.skipped", { id: ctx.id }, 1);
    }
}

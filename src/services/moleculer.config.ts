import type { ServiceRegistry } from "moleculer";

export const MoleculerConfigCommon = {
    skipProcessEventRegistration: true,
    trackContext: true,
};

export function enableMetrics(isDatabase: boolean) {
    if (isDatabase) {
        return {
            enabled: true,
            reporter: [
                {
                    type: "Prometheus",
                    options: {
                        path: "/metrics",
                        defaultLabels: (registry: ServiceRegistry) => ({
                            namespace: registry.broker.namespace,
                            nodeID: registry.broker.nodeID,
                        }),
                        port: 3030,
                    },
                },
            ],
        };
    } else {
        return {
            enabled: false,
        };
    }
}

export function MoleculerConfigLog(NODE_ENV: string) {
    const isProd = NODE_ENV === "production";
    return {
        type: "Console",
        options: {
            autoPadding: true,
            colors: true,
            formatter: "{timestamp} {level} {mod}: {msg}",
            level: {
                "*": isProd ? "warn" : "debug",
                BROKER: isProd ? "warn" : "debug",
                BUILD: isProd ? "info" : "debug",
                CHAOTIC: isProd ? "info" : "debug",
                "CHAOTIC-METRICS": isProd ? "info" : "debug",
                METRICS: isProd ? "warn" : "info",
                NOTIFIER: isProd ? "warn" : "debug",
                REGISTRY: isProd ? "warn" : "debug",
                TRANSIT: isProd ? "warn" : "debug",
                TRANSPORTER: isProd ? "error" : "debug",
            },
            moduleColors: true,
            objectPrinter: null,
        },
    };
}

export const MoleculerConfigCommonService = {
    settings: {
        $noVersionPrefix: true,
    },
    version: 1,
};

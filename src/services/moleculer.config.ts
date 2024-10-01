import type { ServiceRegistry } from "moleculer";

export const MoleculerConfigCommon = {
    skipProcessEventRegistration: true,
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

export const MoleculerConfigLog = {
    type: "Console",
    options: {
        autoPadding: true,
        colors: true,
        formatter: "{timestamp} {level} {mod}: {msg}",
        level: {
            "*": process.env.NODE_ENV === "production" ? "warn" : "debug",
            BROKER: process.env.NODE_ENV === "production" ? "warn" : "debug",
            CHAOTIC: process.env.NODE_ENV === "production" ? "info" : "debug",
            METRICS: process.env.NODE_ENV === "production" ? "warn" : "info",
            NOTIFIER: process.env.NODE_ENV === "production" ? "warn" : "debug",
            REGISTRY: process.env.NODE_ENV === "production" ? "warn" : "debug",
            TRANSIT: process.env.NODE_ENV === "production" ? "warn" : "debug",
            TRANSPORTER: process.env.NODE_ENV === "production" ? "warn" : "debug",
        },
        moduleColors: true,
        objectPrinter: null,
    },
};

export const MoleculerConfigCommonService = {
    settings: {
        $noVersionPrefix: true,
    },
    version: 1,
};

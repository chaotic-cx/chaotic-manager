import { ServiceRegistry } from "moleculer";

export const MoleculerConfigCommon = {
    metrics: {
        enabled: false,
        reporter: [
            {
                type: "Prometheus",
                options: {
                    port: 3030,
                    path: "/metrics",
                    defaultLabels: (registry: ServiceRegistry) => ({
                        namespace: registry.broker.namespace,
                        nodeID: registry.broker.nodeID,
                    }),
                },
            },
        ],
    },
    skipProcessEventRegistration: true,
};

export const MoleculerConfigLog = {
    type: "Console",
    options: {
        level: {
            "*": process.env.NODE_ENV === "production" ? "warn" : "debug",
            BROKER: process.env.NODE_ENV === "production" ? "warn" : "debug",
            TRANSPORTER: process.env.NODE_ENV === "production" ? "warn" : "debug",
            NOTIFIER: process.env.NODE_ENV === "production" ? "warn" : "debug",
            TRANSIT: process.env.NODE_ENV === "production" ? "warn" : "debug",
            REGISTRY: process.env.NODE_ENV === "production" ? "warn" : "debug",
            CHAOTIC: process.env.NODE_ENV === "production" ? "info" : "debug",
        },
        colors: true,
        moduleColors: true,
        formatter: "{timestamp} {level} {mod}: {msg}",
        objectPrinter: null,
        autoPadding: true,
    },
};

export const MoleculerConfigCommonService = {
    version: 1,
    settings: {
        $noVersionPrefix: true,
    },
};

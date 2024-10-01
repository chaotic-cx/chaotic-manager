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

export const MoleculerConfigLogConsole = {
    type: "Console",
    options: {
        level: "debug",
        colors: true,
        moduleColors: false,
        formatter: "{timestamp} {level} {nodeID}/{mod}: {msg}",
        objectPrinter: null,
        autoPadding: true,
    },
};

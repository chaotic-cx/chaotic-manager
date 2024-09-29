import { ServiceRegistry } from "moleculer";

export const MoleculerConfigCommon = {
    metrics: {
        enabled: true,
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
};

export const MoleculerConfigLogFile = {
    type: "File",
    options: {
        level: "info",
        folder: "./logs",
        filename: "chaotic-{date}.log",
        formatter: "{timestamp} {level} {nodeID}/{mod}: {msg}",
        eol: "\n",
        interval: 1000,
    },
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

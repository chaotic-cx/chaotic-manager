/*export const options = {
    metrics: {
        enabled: true,
        reporter: [
            {
                type: "Prometheus",
                options: {
                    // HTTP port
                    port: 3030,
                    // HTTP URL path
                    path: "/metrics",
                    // Default labels which are appended to all metrics labels
                    defaultLabels: registry => ({
                        namespace: registry.broker.namespace,
                        nodeID: registry.broker.nodeID
                    })
                }
            }
        ]
    }
}*/

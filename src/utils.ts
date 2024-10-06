import type { CoordinatorJob } from "./types";
import { URL } from "url";

/**
 * Returns the current time in UTC following en-GB formatting.
 * @returns The current time in UTC.
 */
export function currentTime(): string {
    return `${new Date().toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

/**
 * Returns a URL object from the given pkgbase and timestamp, linking to the live log interface.
 *
 * @param baseLogUrl The base URL for the logs.
 * @param pkgbase The package base name.
 * @param timestamp The timestamp of the build.
 * @returns The constructed URL object.
 */
export function createLiveLogUrl(baseLogUrl: string, pkgbase: string, timestamp: number): URL {
    const url: URL = new URL(baseLogUrl);
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("id", pkgbase);
    return url;
}

/**
 * Converts high-precision timer to milliseconds.
 * @param start The object created by process.hrtime when starting the timer
 * @returns Elapsed time in milliseconds
 */
export function getDurationInMilliseconds(start: [number, number]): number {
    const NS_PER_SEC = 1e9;
    const NS_TO_MS = 1e6;
    const diff = process.hrtime(start);

    return (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;
}

/**
 * Generate a Moleculer nodeId for all nodes depending on the main command provided.
 * @param command The command derived from the main options.
 * @returns The final nodeId to use.
 */
export function generateNodeId(command: string) {
    // This prevents broker shutdowns due to double ids in case we have overlapping nodeIds.
    const randomString = Math.random().toString(36).substring(2, 7);

    if (process.env.BUILDER_HOSTNAME) return process.env.BUILDER_HOSTNAME + "-" + randomString;

    let id = "chaotic-";
    switch (command) {
        case "database":
            id += "database";
            break;
        case "builder":
            id += "builder";
            break;
        case "schedule":
            id += "scheduler";
            break;
        case "auto-repo-remove":
            id += "auto-remover";
            break;
        case "web":
            id += "web-server";
            break;
    }

    return id + "-" + randomString;
}

/**
 * Returns the URL and other information for the log of a job.
 * @param job The job to get the log for.
 * @param baseLogUrl The base URL for the logs.
 * @returns The URL and other information for the log.
 */
export function getLogUrl(job: CoordinatorJob, baseLogUrl: string) {
    const url = new URL(baseLogUrl.toString());
    url.searchParams.set("timestamp", job.timestamp.toString());
    url.searchParams.set("id", job.pkgbase);
    return url.toString();
}

/**
 * Returns the pure node name from the full node name without the random string.
 * @param nodeName The full node name.
 * @returns The pure node name.
 */
export function getPureNodeName(nodeName: string): string {
    return nodeName.match(/\b.*(?=-\w{5})\b/)![0];
}

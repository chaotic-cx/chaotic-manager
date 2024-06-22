import to from "await-to-js";
import Notifier from "./notifier";

export function splitJobId(jobId: string): {
    target_repo: string;
    pkgbase: string;
} {
    const split = jobId.split("/");
    return {
        target_repo: split[0],
        pkgbase: split[1],
    };
}

/**
 * Returns the current time in UTC following en-GB formatting.
 * @returns The current time in UTC.
 */
export function currentTime(): string {
    return `${new Date().toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

/**
 * Returns a URL object from the given pkgbase and timestamp
 *
 * @param baseLogUrl The base URL for the logs.
 * @param pkgbase The package base name.
 * @param timestamp The timestamp of the build.
 * @returns The constructed URL object.
 */
export function createLogUrl(baseLogUrl: string, pkgbase: string, timestamp: number): URL {
    const url: URL = new URL(baseLogUrl);
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("id", pkgbase);
    return url;
}

/**
 * Helper function for sending a notification containing one string for the given event and logging
 * eventual errors gracefully.
 *
 * @param event The event to notify.
 * @param notifier The notifier instance to use
 */
export async function createTrivialNotification(event: string, notifier: Notifier): Promise<void> {
    const [err]: [Error, undefined] | [null, void] = await to(notifier.notify(event));
    if (err) console.error(err);
}

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
 * @returns {string} The current time in UTC.
 */
export function currentTime(): string {
    return `${new Date().toLocaleString("en-GB", { timeZone: "UTC" })} UTC`;
}

/**
 * Returns a URL object from the given pkgbase and timestamp
 *
 * @param {string} baseLogUrl - The base URL for the logs.
 * @param {string} pkgbase - The package base name.
 * @param {number} timestamp - The timestamp of the build.
 * @returns {URL} The constructed URL object.
 */
export function createLogUrl(baseLogUrl: string, pkgbase: string, timestamp: number): URL {
    const url: URL = new URL(baseLogUrl);
    url.searchParams.set("timestamp", timestamp.toString());
    url.searchParams.set("id", pkgbase);
    return url;
}

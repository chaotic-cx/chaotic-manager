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

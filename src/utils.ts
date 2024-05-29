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

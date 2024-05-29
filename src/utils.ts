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

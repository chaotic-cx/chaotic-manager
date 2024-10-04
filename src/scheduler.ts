import type { ServiceBroker } from "moleculer";
import type {
    BuildClass,
    Coordinator_Action_AddJobsToQueue_Params,
    Coordinator_Action_AutoRepoRemove_Params,
    Coordinator_Action_PackageMetaData_List,
} from "./types";

export async function schedulePackages(
    broker: ServiceBroker,
    arch: string,
    target_repo: string,
    source_repo: string,
    packages: string[],
    commit: string | undefined,
    deptree: string | undefined,
): Promise<void> {
    const package_dependency_map: Record<
        string,
        {
            dependencies: string[];
            pkgnames: string[];
        }
    > = {};

    const chaoticLogger = broker.getLogger("CHAOTIC");

    if (deptree) {
        // Deptree format:
        // pkgbase:pkgname1[,pkgname2,...]:dep1[,dep2,...];...
        const deptree_split = deptree.split(";");

        for (const pkg of deptree_split) {
            const pkg_split = pkg.split(":");
            const pkgbase = pkg_split[0];
            const pkgname = pkg_split[1].split(",");
            const deps = pkg_split[2].split(",");

            package_dependency_map[pkgbase] = {
                dependencies: deps,
                pkgnames: pkgname,
            };
        }
    }

    const packageList: Coordinator_Action_PackageMetaData_List = [];

    for (const pkg of packages) {
        const [pkgbase, build_class] = pkg.split("/");

        const dependencies = package_dependency_map[pkgbase];
        packageList.push({
            pkgbase,
            build_class: build_class ? (Number(build_class) as BuildClass) : undefined,
            dependencies: dependencies ? dependencies.dependencies : undefined,
            pkgnames: dependencies ? dependencies.pkgnames : undefined,
        });
    }

    const params: Coordinator_Action_AddJobsToQueue_Params = {
        target_repo,
        source_repo,
        commit,
        arch,
        packages: packageList,
    };

    await broker.waitForServices(["coordinator"], 10000);
    await broker.call("coordinator.addJobsToQueue", params);

    chaoticLogger.info(`Added packages to the queue.`);
    chaoticLogger.info(packageList);

    return;
}

export async function scheduleAutoRepoRemove(
    broker: ServiceBroker,
    arch: string,
    repo: string,
    pkgbases: string[],
): Promise<void> {
    const params: Coordinator_Action_AutoRepoRemove_Params = {
        pkgbases,
        arch,
        repo,
    };
    await broker.waitForServices(["coordinator"], 10000);
    await broker.call("coordinator.autoRepoRemove", params);
    return;
}

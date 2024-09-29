import type RedisConnection from "ioredis";
import type { Coordinator_Action_PackageMetaData_List, Coordinator_Action_AddJobsToQueue_Params, Coordinator_Action_AutoRepoRemove_Params, BuildClass } from "./types";
import { ServiceBroker } from "moleculer"

export async function schedulePackages(
    broker: ServiceBroker,
    arch: string,
    target_repo: string,
    source_repo: string,
    packages: string[],
    commit: string | undefined,
    deptree: string | undefined,
): Promise<void> {
    let package_dependency_map: {
        [pkgbase: string]: {
            dependencies: string[];
            pkgnames: string[];
        };
    } = {};

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
            }
        }
    }

    const packageList: Coordinator_Action_PackageMetaData_List = [];

    for (const pkg of packages) {
        let [pkgbase, build_class] = pkg.split("/");

        console.debug(pkgbase, build_class, package_dependency_map)

        let dependencies = package_dependency_map[pkgbase];
        packageList.push({
           pkgbase,
           build_class: build_class ? Number(build_class) as BuildClass: undefined,
           dependencies: dependencies ? dependencies.dependencies : undefined,
           pkgnames: dependencies ? dependencies.pkgnames : undefined
        });
    }

    let params: Coordinator_Action_AddJobsToQueue_Params = {
        target_repo,
        source_repo,
        commit,
        arch,
        packages: packageList
    }

    await broker.waitForServices(["coordinator"], 10000);
    await broker.call("coordinator.addJobsToQueue", params)
    return 
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
        repo
    }
    await broker.waitForServices(["coordinator"], 10000);
    await broker.call("coordinator.autoRepoRemove", params);
    return;
}

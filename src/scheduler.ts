import { Queue } from 'bullmq';
import RedisConnection from 'ioredis';
import { DispatchJobData } from './types';
import { DepGraph } from 'dependency-graph';

export default function schedulePackage(connection: RedisConnection, arch: string, target_repo: string, source_repo: string, name: string, commit: string | undefined, deptree: string | undefined): Promise<void> {
    return schedulePackages(connection, arch, target_repo, source_repo, [name], commit, deptree);
}

export async function schedulePackages(connection: RedisConnection, arch: string, target_repo: string, source_repo: string, packages: string[], commit: string | undefined, deptree: string | undefined): Promise<void> {
    var graph = new DepGraph({ circular: true });
    if (deptree) {
        var mapped_deps = new Map<string, string[]>();
        var mapped_pkgbases = new Map<string, string>();

        // Deptree format:
        // pkgbase:pkgname1[,pkgname2,...]:dep1[,dep2,...];...
        const deptree_split = deptree.split(';');

        for (const pkg of deptree_split) {
            const pkg_split = pkg.split(':');
            const pkgbase = pkg_split[0];
            const pkgname = pkg_split[1].split(',');
            const deps = pkg_split[2].split(',');

            mapped_deps.set(pkgbase, deps);

            for (const name of pkgname) {
                mapped_pkgbases.set(name, pkgbase);
            }

            graph.addNode(pkgbase);
        }

        for (const [pkgbase, deps] of mapped_deps) {
            for (const dep of deps) {
                const dep_pkgbase = mapped_pkgbases.get(dep);
                // We do not know of this dependency, so we skip it
                if (!dep_pkgbase)
                    continue;
                graph.addDependency(pkgbase, dep_pkgbase);
            }
        }
    }

    const queue = new Queue("dispatch", { connection });


    const list = packages.map((pkg) => {
        var ret: any = {
            pkgbase: pkg
        };
        if (deptree)
            ret.deptree = {
                dependencies: graph.directDependenciesOf(pkg).map((dep: string) => target_repo + "/" + dep),
                dependents: graph.directDependantsOf(pkg).map((dep: string) => target_repo + "/" + dep)
            };
        return ret;
    });

    var disaptch_data: DispatchJobData = {
        type: "add-job",
        data: {
            target_repo: target_repo,
            source_repo: source_repo,
            commit: commit,
            arch: arch,
            packages: list,
        }
    }

    await queue.add("add-job", disaptch_data, {
        removeOnComplete: true,
        removeOnFail: true,
    });
    await queue.close();
}

export async function scheduleAutoRepoRemove(connection: RedisConnection, arch: string, repo: string, pkgbases: string[]): Promise<void> {
    const queue = new Queue("database", { connection });
    await queue.add("auto-repo-remove", {
        arch: arch,
        repo: repo,
        pkgbases: pkgbases
    }, {
        jobId: repo + "/repo-remove/internal",
        removeOnComplete: true,
        removeOnFail: true,
    });
    await queue.close();
}
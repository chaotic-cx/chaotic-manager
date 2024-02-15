import { Queue, Job, JobsOptions } from 'bullmq';
import RedisConnection from 'ioredis';
import { BuildJobData } from './types';
import { DepGraph, DepGraphCycleError } from 'dependency-graph';

export default function schedulePackage(connection: RedisConnection, arch: string, repo: string, name: string, commit: string | undefined, deptree: string | undefined): Promise<void> {
    return schedulePackages(connection, arch, repo, [name], commit, deptree);
}

export async function schedulePackages(connection: RedisConnection, arch: string, repo: string, packages: string[], commit: string | undefined, deptree: string | undefined): Promise<void> {
    var graph = new DepGraph();
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
                const dep_pkgbase = mapped_pkgbases.get(dep)!;
                graph.addDependency(pkgbase, dep_pkgbase);
                // Check if we added a circular dependency and remove it
                // HACKY
                try {
                    graph.dependenciesOf(pkgbase);
                } catch (e) {
                    if (e instanceof DepGraphCycleError) {
                        /*e.cyclePath.forEach((cycle_pkgbase) => {
                            graph.setNodeData(cycle_pkgbase, { circular: true });
                        });*/
                        graph.removeDependency(pkgbase, dep_pkgbase);
                    }
                }
            }
        }
    }

    const queue = new Queue("builds", { connection });
    const list: { name: string, data: any, opts?: JobsOptions }[] = [];
    const timestamp = Date.now();
    packages.forEach((pkg) => {
        // pkg is in the following format, where the repo part is optional:
        // srcrepo:pkgbase
        const pkg_split = pkg.split(':');
        const src_repo = pkg_split.length > 1 ? pkg_split[0] : undefined;
        const pkg_base = pkg_split.length > 1 ? pkg_split[1] : pkg_split[0];

        var dependencies: string[] = [];
        var dependents: string[] = [];
        if (deptree) {
            dependencies = graph.dependenciesOf(pkg_base).map((dep: string) => repo + "/" + dep);
            dependents = graph.dependantsOf(pkg_base).map((dep: string) => repo + "/" + dep);
        }

        var jobdata: BuildJobData = {
            arch: arch,
            srcrepo: src_repo,
            timestamp: timestamp,
            commit: commit,
            deptree: {
                dependencies: dependencies,
                dependents: dependents
            }
        };

        list.push({
            name: `${pkg_base}-${timestamp}`,
            data: jobdata,
            opts: {
                jobId: repo + "/" + pkg_base,
                removeOnComplete: true,
                removeOnFail: { age: 5 }
            }
        });
    });
    await queue.addBulk(list);
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
        removeOnFail: true
    });
    await queue.close();
}
/*
* This file is used to dynamically determine the build order/dependency tree of packages.
* Also handles dependency cycles and other edge cases.
*/

import { DelayedError, Job, Queue } from "bullmq";
import { BuildJobData, DatabaseJobData } from "./types";
import { BuildsRedisLogger } from "./logging";
import Redlock from "redlock";
import { DepGraph } from "dependency-graph";

type CachedData = {
    job: Job,
    state: string
}

async function getJobData(queue: Queue, jobid: string) {
    const job_promise = queue.getJob(jobid);
    const state_promise = queue.getJobState(jobid);

    const job = await job_promise;
    if (!job)
        return undefined;
    const state = await state_promise;
    if (state === "unknown")
        return undefined;
    const data: CachedData = {
        job: job,
        state: state
    }
    return data;
}

async function exclusiveLoopbreak(job: Job, buildsqueue: Queue, databasequeue: Queue): Promise<boolean> {
    const lock = new Redlock([await buildsqueue.client], {
        retryCount: -1,
        automaticExtensionThreshold: 30000
    });
    return await lock.using(["bullpromote"], 60000, async (signal) => {
        var out = await shouldExecute(job, buildsqueue, databasequeue);
        if (signal.aborted) {
            throw signal.error;
        }
        return out === DependencyState.REQUIRES_EXCLUSIVE_LOOPBREAK;
    });
}

export type BuildJobStateData = BuildJobData & {
    state: string,
};

async function populateDepGraph(job: Job, queue: Queue) {
    var graph: DepGraph<BuildJobStateData | null> = new DepGraph({circular: true});

    {
        var promises: Promise<CachedData | undefined>[] = [Promise.resolve({ job: job, state: "fulfilled" })];

        graph.addNode(job.id!, null);

        while (promises.length > 0) {
            const results = await Promise.allSettled(promises);
            promises = [];
            for (const result of results) {
                if (result.status === "fulfilled" && result.value) {
                    const data = result.value;

                    // Check if job is finished or failed (no longer pending)
                    if (["completed", "failed"].includes(data.state))
                        continue;

                    const jobdata = data.job.data as BuildJobData;
                    graph.setNodeData(data.job.id!, { ...jobdata, state: data.state });
                    if (jobdata.deptree) {
                        for (const dep of jobdata.deptree.dependencies) {
                            if (!graph.hasNode(dep)) {
                                graph.addNode(dep, null);
                                promises.push(getJobData(queue, dep));
                            }
                            graph.addDependency(data.job.id!, dep);
                        }
                    }
                }
            }
        }
    }

    // Check if reverse depdendencies match forward dependencies
    for (const node of graph.overallOrder()) {
        const data = graph.getNodeData(node);
        // Remove nodes without data (ones that have no relation to the job)
        if (!data || !data.deptree) {
            graph.removeNode(node);
            continue;
        }
        for (const dep of graph.directDependenciesOf(node)) {
            const dep_data = graph.getNodeData(dep);
            if (!dep_data || !dep_data.deptree)
                continue;
            if (!dep_data.deptree.dependents.includes(node)) {
                graph.removeDependency(node, dep);
            }
        }
    }

    return graph;
}

export enum DependencyState {
    MUST_WAIT,
    REQUIRES_EXCLUSIVE_LOOPBREAK,
    CAN_EXECUTE
}

async function shouldExecute(job: Job, buildsqueue: Queue, databasequeue: Queue | null): Promise<DependencyState> {
    const data: BuildJobData = job.data;

    if (!data.deptree)
        return DependencyState.CAN_EXECUTE;

    // Quick and dirty check of pending database jobs
    if (databasequeue != null) {
        const promises = data.deptree.dependencies.map(dep => getJobData(databasequeue, dep));
        const results = await Promise.allSettled(promises);
        for (const result of results) {
            if (result.status === "fulfilled" && result.value && !["completed", "failed"].includes(result.value.state)) {
                return DependencyState.MUST_WAIT;
            }
        }
    }

    // Populate dependency graph
    const graph = await populateDepGraph(job, buildsqueue);

    // If there are no dependencies (this only includes pending dependencies), we can proceed
    const dependencies = graph.dependenciesOf(job.id!);
    if (dependencies.length === 0) {
        return DependencyState.CAN_EXECUTE;
    }

    // If all the dependencies are also dependents, we are in a loop
    const dependents = graph.dependentsOf(job.id!);
    if (dependencies.every(dep => dependents.includes(dep))) {
        // Check if any of the dependencies are running
        const running = dependencies.some(dep => {
            const data = graph.getNodeData(dep);
            if (["active", "waiting"].includes(data?.state!)) {
                return true;
            }
        });
        if (running) {
            return DependencyState.MUST_WAIT;
        }
        return DependencyState.REQUIRES_EXCLUSIVE_LOOPBREAK;
    }

    return DependencyState.MUST_WAIT;
}

export async function handleJobOrder(job: Job, buildsqueue: Queue, databasequeue: Queue, logger: BuildsRedisLogger) {
    const state = await shouldExecute(job, buildsqueue, databasequeue);
    if (state === DependencyState.MUST_WAIT) {
        logger.log(`Job ${job.id} has pending dependencies. Delaying job until dependencies are resolved.`);
        await job.moveToDelayed(Date.now() + 24 * 60 * 60 * 1000, job.token);
        throw new DelayedError("Job delayed due to pending dependencies.");
    }
    else if (state === DependencyState.REQUIRES_EXCLUSIVE_LOOPBREAK) {
        var out = false;
        try {
            out = await exclusiveLoopbreak(job, buildsqueue, databasequeue);
        } catch (e) {
            out = false;
        }
        if (out) {
            logger.log(`Promoting job ${job.id} because dependency loop dependencies are the only ones pending.`);
            return;
        }
        else {
            // Back in the queue for 1 minute to re-assess in case this does not get called upon by the main job
            await job.moveToDelayed(Date.now() + 10 * 1000, job.token);
            logger.log(`Job ${job.id} delayed due to problem during exclusive loopbreak.`);
            throw new DelayedError("Job delayed due to problem during exclusive loopbreak.");
        }
    }
}

export async function promotePendingDependents(data: BuildJobData | DatabaseJobData, buildsqueue: Queue, logger: BuildsRedisLogger) {
    if (!data.deptree)
        return;

    var promises: Promise<CachedData | undefined>[] = [];

    for (const dep of data.deptree.dependents) {
        promises.push(getJobData(buildsqueue, dep));
    }

    const result = await Promise.allSettled(promises);

    for (const i of result) {
        if (i.status === "fulfilled" && i.value) {
            const job = i.value.job;
            const state = i.value.state;
            if (state !== "delayed")
                continue;
            if (await shouldExecute(job, buildsqueue, null) !== DependencyState.MUST_WAIT) {
                logger.log(`Promoting dependent job ${job.id} from delayed state.`);
                job.promote();
            }
        }
    }
}
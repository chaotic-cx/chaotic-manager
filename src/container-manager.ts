import Docker from "dockerode";
import Dockerode from "dockerode";
import to from "await-to-js";
import { Mutex } from "async-mutex";
import { Stream } from "stream";
import { ContainerCreateMountOption, LibPod, LibpodDockerode } from "./libpod-dockerode";

export abstract class ContainerManager {
    abstract docker: Dockerode;
    pull_schedule: NodeJS.Timeout | null = null;
    pull_mutex = new Mutex();

    destroy() {
        if (this.pull_schedule) {
            clearTimeout(this.pull_schedule);
        }
    }

    async pullImage(imagename: string, locked = false) {
        // if (process.env.NODE_ENV === "development") return;
        if (!locked) await this.pull_mutex.acquire();

        try {
            await new Promise<void>((resolve, reject) => {
                this.docker.pull(imagename, (err: any, stream: NodeJS.ReadableStream) => {
                    if (err) {
                        return reject(err);
                    }
                    this.docker.modem.followProgress(stream, (err, output) => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    });
                });
            });
            console.log("Downloaded builder image.");
        } finally {
            if (!locked) this.pull_mutex.release();
        }
    }

    async getImage(imagename: string): Promise<string> {
        if (this.pull_mutex.isLocked()) console.log("Waiting for container pull to finish...");
        await this.pull_mutex.acquire();
        try {
            try {
                const image = this.docker.getImage(imagename);
                await image.inspect();
            } catch {
                await this.pullImage(imagename, true);
            }
        } finally {
            this.pull_mutex.release();
        }

        return imagename;
    }

    abstract create(imagename: string, args: string[], binds: string[], env: string[]): Promise<Docker.Container>;

    // Manually re-implementing the dockerode run function because we need better lifecycle control
    abstract start(container: Docker.Container, logfunc: (arg: string) => void): Promise<any>;

    async run(
        imagename: string,
        args: string[],
        binds: string[] = [],
        env: string[] = [],
        logfunc: (arg: string) => void = console.log,
    ) {
        const image = await this.getImage(imagename);

        const stream = new Stream.Writable();
        stream._write = (chunk, encoding, next) => {
            logfunc(chunk.toString());
            next();
        };

        const out = await to(
            this.docker.run(image, args, stream, {
                HostConfig: {
                    AutoRemove: true,
                    Binds: binds,
                    Ulimits: [
                        {
                            Name: "nofile",
                            Soft: 1024,
                            Hard: 1048576,
                        },
                    ],
                },
                Env: env,
                AttachStderr: true,
                AttachStdout: true,
            }),
        );

        if (out[0]) console.error(out[0]);
        return out;
    }

    async kill(container: Docker.Container) {
        await this.docker.getContainer(container.id).remove({ force: true });
    }

    async scheduledPull(imagename: string) {
        await this.pull_mutex.acquire();
        if (this.pull_schedule) {
            clearTimeout(this.pull_schedule);
            this.pull_schedule = null;
        }
        try {
            await this.pullImage(imagename, true);
        } catch (err) {
            console.error(err);
        }
        this.pull_schedule = setTimeout(this.scheduledPull.bind(this, imagename), 7200000);
        this.pull_mutex.release();
    }
}

export class DockerManager extends ContainerManager {
    docker: Docker = new Docker();

    async create(imagename: string, args: string[], binds: string[] = [], env: string[] = []) {
        const image = await this.getImage(imagename);

        const [err, out] = await to(
            this.docker.createContainer({
                Image: image,
                Cmd: args,
                HostConfig: {
                    AutoRemove: true,
                    Binds: binds,
                    Ulimits: [
                        {
                            Name: "nofile",
                            Soft: 1024,
                            Hard: 1048576,
                        },
                    ],
                    // Some builds require this for setting up specific things, like unionfs for fluffychat
                    // Docker containers are much more restricted than systemd-nspawn chroots,
                    // which were used in infra 3.0.
                    // Preferred would be, of course, adding this per package as opt-in, but this suffices for now.
                    CapAdd: ["SYS_ADMIN"],
                },
                Env: env,
                AttachStderr: true,
                AttachStdout: true,
                OpenStdin: false,
                Tty: true,
                StdinOnce: false,
                AttachStdin: false,
            }),
        );

        if (err) throw err;

        return out;
    }

    // Manually re-implementing the dockerode run function because we need better lifecycle control
    async start(container: Docker.Container, logfunc: (arg: string) => void = console.log) {
        const stream = new Stream.Writable();
        stream._write = (chunk, encoding, next) => {
            logfunc(chunk.toString());
            next();
        };

        let out;
        let err;

        [err, out] = await to(
            container.attach({
                stream: true,
                stdout: true,
                stderr: true,
            }),
        );
        if (err || !out) throw err;
        out.setEncoding("utf8");
        out.pipe(stream, {
            end: true,
        });
        [err, out] = await to(container.start());
        if (err) throw err;
        [err, out] = await to(container.wait({ condition: "removed" }));
        if (err) throw err;
        return out;
    }
}

export class PodmanManager extends ContainerManager {
    docker: Docker;
    libPodApi: LibPod;

    constructor() {
        super();
        const socketPath = process.env.DOCKER_SOCKET ? process.env.DOCKER_SOCKET : "/run/podman/podman.sock";
        this.docker = new Docker({ socketPath: socketPath });
        const libPodDockerode = new LibpodDockerode();
        libPodDockerode.enhancePrototypeWithLibPod();
        this.libPodApi = this.docker as unknown as LibPod;
    }

    async create(imagename: string, args: string[], binds: string[] = [], env: string[] = []) {
        const image = await this.getImage(imagename);
        const mountsOption: ContainerCreateMountOption[] = binds.map((bind) => {
            const [host, container] = bind.split(":");
            return {
                Type: "bind",
                Source: host,
                Destination: container,
                RW: true,
                Propagation: "rshared",
            };
        });

        const envOption: Record<string, string> = {};
        env.forEach((env) => {
            const [key, value] = env.split(/=(.*)/s);
            envOption[key] = value;
        });

        const [err, out] = await to(
            this.libPodApi.createPodmanContainer({
                image: image,
                command: args,
                mounts: mountsOption,
                env: envOption,
            }),
        );

        if (err) throw err;
        return this.docker.getContainer(out.Id);
    }

    // Manually re-implementing the dockerode run function because we need better lifecycle control
    async start(container: Docker.Container, logfunc: (arg: string) => void = console.log) {
        const stream = new Stream.Writable();
        stream._write = (chunk, encoding, next) => {
            logfunc(chunk.toString());
            next();
        };

        let out;
        let err;

        [err, out] = await to(this.libPodApi.podmanAttach(container.id));

        if (err || !out) throw err;
        out.setEncoding("utf8");
        out.pipe(stream, {
            end: true,
        });
        [err, out] = await to(container.start());
        if (err) throw err;
        [err, out] = await to(this.libPodApi.podmanWait(container.id));
        if (err) throw err;
        return out;
    }
}

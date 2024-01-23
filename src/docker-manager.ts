import to from 'await-to-js';
import Docker from 'dockerode';
import {Mutex} from 'async-mutex';
import { Stream } from 'stream';

export class DockerManager {
  docker: Docker = new Docker();
  pull_schedule: NodeJS.Timeout | null = null;
  pull_mutex = new Mutex();

  constructor() {
  }
  destroy() {
    if (this.pull_schedule) {
      clearTimeout(this.pull_schedule);
    }
  }

  async pullImage(imagename: string, locked: boolean = false) {
    if (process.env.NODE_ENV === "development")
      return;
    if (!locked)
      await this.pull_mutex.acquire();
    console.log("Downloading builder image...");
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
      if (!locked)
        this.pull_mutex.release();
    }
  }

  async getImage(imagename: string): Promise<string> {
    if (this.pull_mutex.isLocked())
      console.log("Waiting for container pull to finish...");
    await this.pull_mutex.acquire();
    try {
      try {
        var image = this.docker.getImage(imagename)
        await image.get();
      }
      catch {
        await this.pullImage(imagename, true);
      }
    } finally {
      this.pull_mutex.release();
    }
  
    return imagename;
  }

  async run(imagename: string, args: string[], binds: string[] = [], env: string[] = [], logfunc: (arg: Buffer) => void = console.log) {
    const image = await this.getImage(imagename);

    const stream = new Stream.Writable();
    stream._write = (chunk, encoding, next) => {
      logfunc(chunk.toString());
      next();
    };

    const out = await to(this.docker.run(image, args, stream, {
      HostConfig: {
          AutoRemove: true,
          Binds: binds,
          Ulimits: [
              {
                  Name: "nofile",
                  Soft: 1024,
                  Hard: 1048576
              }
          ],
      },
      Env: env,
      AttachStderr: true,
      AttachStdout: true,
    }));

    if (out[0])
      console.error(out[0]);
    return out;
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
    await this.pull_mutex.release();
  }
}
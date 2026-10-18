/**
 * Docker backend: drives any reachable Docker daemon through the @moby/moby SDK
 */

import type { DockerfileSpec } from "./image.ts";
import { BackendUnavailableError, type DockerBackend, type ReadOnlyMount } from "./types.ts";
import { containerEnv, hostDirForSandbox, isPidAlive, runCliTimed, sandboxName } from "./utils.ts";

export async function newDockerSandboxAt(
	host: string,
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
	readOnlyMounts: ReadOnlyMount[] = [],
	runAsRoot: boolean = false,
	dockerfile: DockerfileSpec | null = null,
): Promise<DockerBackend | null> {
	try {
		const moby = await import("@moby/moby");
		const cli = new moby.Client({ host });

		const ping = await cli.ping();
		if (ping.statusCode !== 200) {
			throw new BackendUnavailableError(`Docker daemon at ${host} not reachable`);
		}

		// Resolve the image: a Dockerfile is built with the docker CLI (and
		// cached under its content hash tag) if the cached image is missing.
		let imageRef = image;
		if (dockerfile) {
			if (!(await dockerImageExists(dockerfile.tag))) {
				const { error } = await dockerBuildImage(dockerfile);
				if (error) {
					throw new Error(`Failed to build image from ${dockerfile.path}: ${error}`);
				}
			}
			imageRef = dockerfile.tag;
		}

		await cleanupStaleDockerContainers(cli);

		const hostDir = hostDirForSandbox();
		const containerID = await startDockerContainer(
			cli,
			imageRef,
			hostDir,
			networkIsolated,
			mounts,
			workdirMount,
			readOnlyMounts,
			runAsRoot,
		);

		return {
			type: "docker",
			cli,
			containerID,
			name: sandboxName(),
		};
	} catch (err) {
		if (err instanceof BackendUnavailableError) {
			throw err;
		}
		console.debug(`Docker backend at ${host} failed: ${err}`);
		return null;
	}
}

export async function newDockerSandbox(
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
	readOnlyMounts: ReadOnlyMount[] = [],
	runAsRoot: boolean = false,
	dockerfile: DockerfileSpec | null = null,
): Promise<DockerBackend | null> {
	const hosts = [
		process.env.DOCKER_HOST,
		"unix:///var/run/docker.sock",

		"npipe:////./pipe/docker_engine",
	];

	for (const host of hosts) {
		if (!host) continue;
		const backend = await newDockerSandboxAt(
			host,
			image,
			networkIsolated,
			mounts,
			workdirMount,
			readOnlyMounts,
			runAsRoot,
			dockerfile,
		);
		if (backend) return backend;
	}

	return null;
}

async function cleanupStaleDockerContainers(cli: any): Promise<void> {
	try {
		const containers = await cli.listContainers({ all: true });
		const prefix = sandboxName().replace(`${process.pid}`, "");

		for (const container of containers) {
			const name = container.Names?.[0]?.replace("/", "") || "";
			if (name.startsWith(prefix)) {
				const pidStr = name.slice(prefix.length);
				const pid = parseInt(pidStr, 10);
				if (Number.isNaN(pid) || !isPidAlive(pid)) {
					try {
						await cli.removeContainer(container.Id, { force: true });
					} catch {
						// Ignore removal errors
					}
				}
			}
		}
	} catch {
		// Ignore cleanup errors
	}
}

async function startDockerContainer(
	cli: any,
	image: string,
	hostDir: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
	readOnlyMounts: ReadOnlyMount[] = [],
	runAsRoot: boolean = false,
): Promise<string> {
	try {
		const pullStream = await cli.pull(image);
		await new Promise((resolve, reject) => {
			pullStream.on("end", resolve);
			pullStream.on("error", reject);
		});
	} catch (err) {
		throw new Error(`Failed to pull image ${image}: ${err}`);
	}

	const uid = process.getuid?.() || 0;
	const gid = process.getgid?.() || 0;

	// Build bind mounts: start with the default workdir mount
	const binds: string[] = [`${hostDir}:${workdirMount}`];

	// Add additional mounts from config
	for (const [hostPath, containerPath] of Object.entries(mounts)) {
		const expandedHostPath = hostPath.replace(/^~/, `${homedir()}/`);
		binds.push(`${expandedHostPath}:${containerPath}`);
	}

	// Read-only overlay mounts (e.g. protected config paths)
	for (const ro of readOnlyMounts) {
		binds.push(`${ro.host}:${ro.container}:ro`);
	}

	const createResult = await cli.createContainer({
		name: sandboxName(),
		Image: image,
		User: runAsRoot ? "0:0" : `${uid}:${gid}`,
		Cmd: ["sleep", "infinity"],
		Env: containerEnv(),
		WorkingDir: workdirMount,
		HostConfig: {
			Binds: binds,
			NetworkMode: networkIsolated ? "none" : "default",
		},
	});

	await cli.startContainer(createResult.id);

	return createResult.id;
}

export async function dockerImageExists(tag: string): Promise<boolean> {
	const res = await runCliTimed("docker", ["images", "-q", tag], 30);
	return !res.error && res.output.trim().length > 0;
}

export async function dockerBuildImage(spec: DockerfileSpec): Promise<{ error: string | null }> {
	const res = await runCliTimed("docker", ["build", "-t", spec.tag, "-f", spec.path, spec.context], 900);
	return { error: res.error };
}

export async function runDockerExec(
	backend: DockerBackend,
	command: string,
	timeout: number,
	onData: (data: Buffer) => void,
	signal?: AbortSignal,
	asRoot = false,
): Promise<{ exitCode: number | null }> {
	const cli = backend.cli;
	const containerID = backend.containerID;

	return new Promise((resolve, reject) => {
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		if (timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				reject(new Error(`timeout:${timeout}`));
			}, timeout * 1000);
		}

		const execOptions = {
			Cmd: ["/bin/sh", "-c", command],
			AttachStdout: true,
			AttachStderr: true,
			...(asRoot ? { User: "0:0" } : {}),
		};

		cli.createExec(containerID, execOptions)
			.then((exec: any) => {
				return cli.execStartAndAttach(exec.id, {});
			})
			.then((stream: any) => {
				stream.on("data", (chunk: Buffer) => {
					onData(chunk);
				});

				stream.on("error", (err: any) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (!timedOut && !signal?.aborted) {
						reject(err);
					}
				});

				stream.on("end", () => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (timedOut) return;
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					cli.execInspect(exec.id)
						.then((result: any) => {
							resolve({ exitCode: result.ExitCode });
						})
						.catch(() => {
							resolve({ exitCode: null });
						});
				});
			})
			.catch((err: any) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (!timedOut && !signal?.aborted) {
					reject(err);
				}
			});

		signal?.addEventListener(
			"abort",
			() => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

export async function backendCleanupDocker(backend: DockerBackend): Promise<void> {
	try {
		const cli = backend.cli;
		const containerID = backend.containerID;
		const timeout = 10000;

		const stopPromise = cli.stopContainer(containerID);
		const removePromise = cli.removeContainer(containerID, { force: true });

		await Promise.race([
			Promise.all([stopPromise, removePromise]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
		]);
	} catch (err) {
		console.debug(`Failed to cleanup Docker backend: ${err}`);
	}
}

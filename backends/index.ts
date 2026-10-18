/**
 * Sandbox backend selection and management
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { backendCleanupApple, newAppleSandbox, runAppleExec } from "./apple.ts";
import { backendCleanupDocker, newDockerSandbox, runDockerExec } from "./docker.ts";
import type { DockerfileSpec } from "./image.ts";
import { type AnyBackend, type BackendResult, BackendUnavailableError, type ReadOnlyMount } from "./types.ts";

export { type DockerfileSpec, dockerfileSpec } from "./image.ts";
export { BackendUnavailableError, DEFAULT_CONFIG, SandboxConfig } from "./types.ts";
export { containerEnv, hostDirForSandbox, sandboxName } from "./utils.ts";

async function tryBackend(
	type: "apple" | "docker",
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string>,
	workdirMount: string,
	readOnlyMounts: ReadOnlyMount[],
	runAsRoot: boolean,
	dockerfile: DockerfileSpec | null,
): Promise<AnyBackend | null> {
	switch (type) {
		case "apple":
			return newAppleSandbox(image, networkIsolated, mounts, workdirMount, readOnlyMounts, runAsRoot, dockerfile);
		case "docker":
			return newDockerSandbox(image, networkIsolated, mounts, workdirMount, readOnlyMounts, runAsRoot, dockerfile);
	}
}

export async function selectBackend(
	forced: string | undefined,
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
	readOnlyMounts: ReadOnlyMount[] = [],
	runAsRoot: boolean = false,
	dockerfile: DockerfileSpec | null = null,
): Promise<BackendResult | null> {
	if (forced && forced !== "auto") {
		const backend = await tryBackend(
			forced as "apple" | "docker",
			image,
			networkIsolated,
			mounts,
			workdirMount,
			readOnlyMounts,
			runAsRoot,
			dockerfile,
		);
		if (backend) {
			return { backend, cleanup: () => backendCleanup(backend), networkIsolated };
		}
		throw new BackendUnavailableError(`Forced backend ${forced} is not available`);
	}

	// Try auto selection: apple -> docker
	const backends = ["apple", "docker"] as const;
	for (const type of backends) {
		const backend = await tryBackend(
			type,
			image,
			networkIsolated,
			mounts,
			workdirMount,
			readOnlyMounts,
			runAsRoot,
			dockerfile,
		);
		if (backend) {
			return { backend, cleanup: () => backendCleanup(backend), networkIsolated };
		}
	}

	return null;
}

async function backendCleanup(backend: AnyBackend): Promise<void> {
	switch (backend.type) {
		case "docker":
			return backendCleanupDocker(backend);
		case "apple":
			return backendCleanupApple(backend);
	}
}

/**
 * Run a one-off command in the sandbox container, optionally as in-container root
 * (used for startup commands; the bash tool uses the container's default user).
 */
export async function execInBackend(
	backend: AnyBackend,
	command: string,
	timeout: number,
	onData: (data: Buffer) => void,
	asRoot = false,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
	switch (backend.type) {
		case "docker":
			return runDockerExec(backend, command, timeout, onData, signal, asRoot);
		case "apple":
			return runAppleExec(backend, command, timeout, onData, signal, asRoot);
	}
}

export function createSandboxedBashOps(backend: AnyBackend): BashOperations {
	return {
		exec: async (command, _cwd, { onData, signal, timeout, env: _env }) => {
			const effectiveTimeout = timeout ?? 30;

			switch (backend.type) {
				case "docker":
					return runDockerExec(backend, command, effectiveTimeout, onData, signal);

				case "apple":
					return runAppleExec(backend, command, effectiveTimeout, onData, signal);

				default:
					throw new Error(`Unknown backend type: ${(backend as any).type}`);
			}
		},
	};
}

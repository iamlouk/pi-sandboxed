/**
 * Sandbox backend selection and management
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { backendCleanupApple, newAppleSandbox, runAppleExec } from "./apple.ts";
import { backendCleanupDocker, newDockerSandbox, runDockerExec } from "./docker.ts";
import { backendCleanupLima, newLimaSandbox } from "./lima.ts";
import { type AnyBackend, type BackendResult, BackendUnavailableError } from "./types.ts";

export { BackendUnavailableError, DEFAULT_CONFIG, SandboxConfig } from "./types.ts";
export { containerEnv, hostDirForSandbox, sandboxName } from "./utils.ts";

async function tryBackend(
	type: "apple" | "docker" | "lima",
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string>,
	workdirMount: string,
): Promise<AnyBackend | null> {
	switch (type) {
		case "apple":
			return newAppleSandbox(image, networkIsolated, mounts, workdirMount);
		case "docker":
			return newDockerSandbox(image, networkIsolated, mounts, workdirMount);
		case "lima":
			return newLimaSandbox(image, networkIsolated, mounts, workdirMount);
		default:
			return null;
	}
}

export async function selectBackend(
	forced: string | undefined,
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
): Promise<BackendResult | null> {
	if (forced && forced !== "auto") {
		const backend = await tryBackend(
			forced as "apple" | "docker" | "lima",
			image,
			networkIsolated,
			mounts,
			workdirMount,
		);
		if (backend) {
			return { backend, cleanup: () => backendCleanup(backend), networkIsolated };
		}
		throw new BackendUnavailableError(`Forced backend ${forced} is not available`);
	}

	// Try auto selection: apple -> docker -> lima
	const backends = ["apple", "docker", "lima"] as const;
	for (const type of backends) {
		const backend = await tryBackend(type, image, networkIsolated, mounts, workdirMount);
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
		case "lima":
			return backendCleanupLima(backend);
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

				case "lima":
					if (!backend.innerBackend) {
						throw new Error("Lima backend not initialized");
					}
					return runDockerExec(backend.innerBackend, command, effectiveTimeout, onData, signal);

				default:
					throw new Error(`Unknown backend type: ${(backend as any).type}`);
			}
		},
	};
}

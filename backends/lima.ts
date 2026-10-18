/**
 * Lima backend: ensures a Lima VM (with Docker inside) exists and is running
 * macOS only - uses @lima-vm/lima SDK
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { newDockerSandboxAt } from "./docker.ts";
import { BackendUnavailableError, type LimaBackend } from "./types.ts";
import { sandboxName } from "./utils.ts";

export async function newLimaSandbox(
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
): Promise<LimaBackend | null> {
	if (platform() !== "darwin") {
		return null;
	}

	try {
		const instanceName = "pi-sandbox"; // Will be overridden by caller
		const instance = await ensureLimaInstance(instanceName);
		if (!instance) {
			throw new BackendUnavailableError(`Lima instance ${instanceName} not available`);
		}

		const dockerHost = `unix://${join(homedir(), ".lima", instanceName, "sock", "docker.sock")}`;

		if (!(await waitDockerHost(dockerHost))) {
			throw new BackendUnavailableError(`Docker inside Lima at ${dockerHost} not reachable`);
		}

		const innerBackend = await newDockerSandboxAt(dockerHost, image, networkIsolated, mounts, workdirMount);
		if (!innerBackend) {
			throw new BackendUnavailableError("Failed to create Docker backend for Lima");
		}

		return {
			type: "lima",
			name: sandboxName(),
			instanceName,
			dockerHost,
			innerBackend,
		};
	} catch (err) {
		if (err instanceof BackendUnavailableError) {
			throw err;
		}
		console.debug(`Lima backend failed: ${err}`);
		return null;
	}
}

async function waitDockerHost(host: string, timeoutMs: number = 120000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const moby = await import("@moby/moby");
			const cli = new moby.Client({ host });
			const ping = await cli.ping();
			if (ping.statusCode === 200) {
				return true;
			}
		} catch {
			// Try again
		}

		// Wait a bit before retrying
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	return false;
}

async function ensureLimaInstance(name: string): Promise<any | null> {
	try {
		const lima = await import("@lima-vm/lima");
		const store = lima.store;
		const inst = await store.inspect(name);

		if (!inst) {
			console.warn(
				`Lima instance ${name} does not exist. Create it with: limactl create --name=${name} template:docker`,
			);
			return null;
		}

		if (inst.status !== "Running") {
			console.warn(`Starting Lima instance ${name}...`);
			await lima.instance.start(name);

			let retries = 30;
			while (retries > 0) {
				const updatedInst = await store.inspect(name);
				if (updatedInst?.status === "Running") {
					return updatedInst;
				}
				retries--;
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}

			if (retries === 0) {
				throw new Error(`Failed to start Lima instance ${name} within timeout`);
			}
		}

		return inst;
	} catch (err) {
		console.debug(`Failed to ensure Lima instance: ${err}`);
		return null;
	}
}

export async function backendCleanupLima(backend: LimaBackend): Promise<void> {
	if (backend.innerBackend) {
		const { backendCleanupDocker } = await import("./docker.ts");
		await backendCleanupDocker(backend.innerBackend);
	}
}

/**
 * Apple Container backend: uses apple/container CLI (vz microVM runtime)
 * macOS only - CLI-driven because 1.x APIs are XPC-only
 */

import { platform } from "node:os";
import { type AppleBackend, BackendUnavailableError } from "./types.ts";
import {
	containerEnv,
	findExecutableSync,
	hostDirForSandbox,
	isPidAlive,
	runContainerCLI,
	sandboxName,
} from "./utils.ts";

export async function newAppleSandbox(
	image: string,
	networkIsolated: boolean,
	mounts: Record<string, string> = {},
	workdirMount: string = "/workdir",
): Promise<AppleBackend | null> {
	if (platform() !== "darwin") {
		return null;
	}

	if (!findExecutableSync("container")) {
		throw new BackendUnavailableError("apple/container CLI not found in PATH");
	}

	try {
		const startResult = await runContainerCLI(["system", "start"]);
		if (startResult.error) {
			throw new Error(`container system start failed: ${startResult.error}`);
		}

		await appleCleanupStale();

		const hostDir = hostDirForSandbox();
		const uid = process.getuid?.() || 0;
		const gid = process.getgid?.() || 0;

		const args = [
			"run",
			"--detach",
			"--name",
			sandboxName(),
			"--uid",
			uid.toString(),
			"--gid",
			gid.toString(),
			"--workdir",
			workdirMount,
			"--mount",
			`type=virtiofs,source=${hostDir},target=${workdirMount}`,
		];

		// Add additional mounts from config
		for (const [hostPath, containerPath] of Object.entries(mounts)) {
			const expandedHostPath = hostPath.replace(/^~/, `${homedir()}/`);
			args.push("--mount", `type=virtiofs,source=${expandedHostPath},target=${containerPath}`);
		}

		// Network isolation: add --network none if enabled
		if (networkIsolated) {
			args.push("--network", "none");
		}

		for (const envVar of containerEnv()) {
			args.push("--env", envVar);
		}
		args.push(image, "sleep", "infinity");

		const runResult = await runContainerCLI(args);
		if (runResult.error) {
			throw new Error(`container run failed: ${runResult.error}`);
		}

		return {
			type: "apple",
			name: sandboxName(),
		};
	} catch (err) {
		if (err instanceof BackendUnavailableError) {
			throw err;
		}
		console.debug(`Apple backend failed: ${err}`);
		return null;
	}
}

export async function runAppleExec(
	backend: AppleBackend,
	command: string,
	timeout: number,
	onData: (data: Buffer) => void,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		if (timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				reject(new Error(`timeout:${timeout}`));
			}, timeout * 1000);
		}

		const child = spawn("container", ["exec", backend.name, "/bin/sh", "-c", command], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (!timedOut && !signal?.aborted) {
				reject(err);
			}
		});

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (timedOut) return;
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			resolve({ exitCode: code });
		});

		signal?.addEventListener(
			"abort",
			() => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				child.kill("SIGKILL");
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

async function appleCleanupStale(): Promise<void> {
	try {
		const result = await runContainerCLI(["list", "--all", "--format", "json"]);
		if (result.error) {
			console.debug(`Failed to list apple containers: ${result.error}`);
			return;
		}

		const containers = JSON.parse(result.output) as Array<{ id: string }>;
		const prefix = sandboxName().replace(`${process.pid}`, "");

		for (const container of containers) {
			const name = container.id;
			if (name.startsWith(prefix)) {
				const pidStr = name.slice(prefix.length);
				const pid = parseInt(pidStr, 10);
				if (Number.isNaN(pid) || !isPidAlive(pid)) {
					try {
						await runContainerCLI(["rm", "--force", name]);
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

// Need to import spawn for runAppleExec
import { spawn } from "node:child_process";

export async function backendCleanupApple(backend: AppleBackend): Promise<void> {
	try {
		const timeout = 10000;
		const result = await Promise.race([
			runContainerCLI(["rm", "--force", backend.name]),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
		]);
		void result;
	} catch (err) {
		console.debug(`Failed to cleanup Apple backend: ${err}`);
	}
}

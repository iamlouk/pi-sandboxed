/**
 * Utility functions for sandbox backends
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";

export function sandboxName(): string {
	return `pi-sandboxed-${process.pid}`;
}

export function hostDirForSandbox(): string {
	return process.cwd();
}

export function containerEnv(): string[] {
	const env: string[] = [];
	const passThrough = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM"];
	for (const key of passThrough) {
		if (process.env[key]) {
			env.push(`${key}=${process.env[key]}`);
		}
	}
	if (process.env.PI_SESSION_ID) {
		env.push(`PI_SESSION_ID=${process.env.PI_SESSION_ID}`);
	}
	if (process.env.PI_WORKSPACE_ROOT) {
		env.push(`PI_WORKSPACE_ROOT=${process.env.PI_WORKSPACE_ROOT}`);
	}
	return env;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse mount configuration into container mount arguments
 * @param mounts Record of hostPath -> containerPath
 * @returns Array of mount strings for container creation
 */
export function parseMounts(mounts: Record<string, string>): string[] {
	const mountArgs: string[] = [];
	for (const [hostPath, containerPath] of Object.entries(mounts)) {
		// Expand ~ in host paths
		const expandedHostPath = hostPath.replace(/^~/, `${homedir()}/`);
		mountArgs.push(`type=virtiofs,source=${expandedHostPath},target=${containerPath}`);
	}
	return mountArgs;
}

export function findExecutableSync(name: string): string | null {
	try {
		const child = spawn(name, ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		child.unref();
		return name;
	} catch {
		return null;
	}
}

export async function runContainerCLI(args: string[]): Promise<{ output: string; error: string | null }> {
	return new Promise((resolve) => {
		const child = spawn("container", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code !== 0) {
				resolve({ output: stdout, error: stderr || `exit code ${code}` });
			} else {
				resolve({ output: stdout, error: null });
			}
		});

		child.on("error", (err) => {
			resolve({ output: "", error: err.message });
		});
	});
}

/** Run a CLI command with a timeout, capturing stdout/stderr. */
export function runCliTimed(
	cli: string,
	args: string[],
	timeoutSeconds: number,
): Promise<{ output: string; error: string | null }> {
	return new Promise((resolve) => {
		let timedOut = false;
		const child = spawn(cli, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutSeconds * 1000);

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ output: stdout, error: `failed to run ${cli}: ${err}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ output: stdout, error: `timed out after ${timeoutSeconds}s` });
			} else if (code !== 0) {
				resolve({ output: stdout, error: stderr || `exit code ${code}` });
			} else {
				resolve({ output: stdout, error: null });
			}
		});
	});
}

/**
 * Host tools - user-configured custom tools exposed to the LLM
 *
 * The sandbox config can declare an explicit allowlist of shell commands that
 * the LLM may run on the HOST (e.g. "ninja test"). Each entry becomes a
 * registered tool. The agent cannot invent new host tools at runtime: the
 * list comes solely from the user's pi-sandboxed.json.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostTool } from "../backends/types.ts";

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_TIMEOUT_SECONDS = 120;

const hostToolParams = Type.Object({});

interface HostToolResult {
	exitCode: number | null;
	durationMs: number;
}

function runHostCommand(
	command: string,
	cwd: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; aborted: boolean }> {
	return new Promise((resolvePromise) => {
		const child = spawn("/bin/sh", ["-c", command], { cwd });

		let stdout = "";
		let stderr = "";
		let aborted = false;

		const timer = setTimeout(() => {
			aborted = true;
			child.kill("SIGKILL");
		}, timeoutSeconds * 1000);

		const onAbort = () => {
			aborted = true;
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr, exitCode, aborted });
		};

		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (err) => {
			stderr += `\nspawn error: ${err}`;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

function truncateOutput(s: string): string {
	const MAX = 50_000;
	return s.length > MAX ? `${s.slice(0, MAX)}\n... (output truncated)` : s;
}

function createHostToolDefinition(tool: HostTool, defaultCwd: string): ToolDefinition<any> {
	const description = tool.description?.trim() || `Run \`${tool.command}\` on the host.`;
	const timeout = tool.timeout ?? DEFAULT_TIMEOUT_SECONDS;

	return {
		name: tool.name,
		label: tool.name,
		description: `${description} Runs on the host, outside the sandbox (user-configured).`,
		promptSnippet: `Run ${tool.command} on the host`,
		promptGuidelines: [`Use ${tool.name} to run ${tool.command} on the host.`],
		parameters: hostToolParams,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, _params, signal) {
			const cwd = tool.cwd ? tool.cwd.replace(/^~(?=\/|$)/, `${process.env.HOME ?? ""}`) : defaultCwd;
			const started = Date.now();
			const { stdout, stderr, exitCode, aborted } = await runHostCommand(tool.command, cwd, timeout, signal);

			const details: HostToolResult = { exitCode, durationMs: Date.now() - started };
			const parts: string[] = [];
			if (aborted) parts.push(`Command ${signal?.aborted ? "aborted" : "timed out"} after ${details.durationMs}ms.`);
			else if (exitCode !== null) parts.push(`Exit code: ${exitCode} (${details.durationMs}ms).`);
			else parts.push(`Command failed to start (${details.durationMs}ms).`);
			if (stdout.trim()) parts.push(`stdout:\n${truncateOutput(stdout)}`);
			if (stderr.trim()) parts.push(`stderr:\n${truncateOutput(stderr)}`);

			const text = parts.join("\n\n");
			return {
				content: [
					{ type: "text", text: aborted || (exitCode !== null && exitCode !== 0) ? text : text || "Done." },
				],
				details,
			};
		},
	};
}

/**
 * Register all host tools from the config. Invalid names/commands are skipped
 * with a warning. Returns the list of registered tool names.
 */
export function registerHostTools(pi: ExtensionAPI, tools: HostTool[] | undefined, cwd: string): string[] {
	const registered: string[] = [];
	for (const tool of tools ?? []) {
		if (!tool.name || !NAME_RE.test(tool.name)) {
			console.warn(`pi-sandboxed: skipping host tool with invalid name: ${JSON.stringify(tool.name)}`);
			continue;
		}
		if (!tool.command || typeof tool.command !== "string") {
			console.warn(`pi-sandboxed: skipping host tool '${tool.name}': no command`);
			continue;
		}
		pi.registerTool(createHostToolDefinition(tool, cwd));
		registered.push(tool.name);
	}
	return registered;
}

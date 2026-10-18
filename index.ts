/**
 * pi-sandboxed - Container-based sandbox extension for pi
 *
 * Runs all commands in isolated containers. When enabled:
 * - bash commands run in sandboxed container (apple/docker/lima backend)
 * - read/write/edit tools are restricted to mounted directories:
 *   container paths are rewritten to their host equivalents (the tools
 *   operate on the host filesystem, but the mounted dirs are the same
 *   data as inside the container, so both views stay consistent)
 * - Network access is DISABLED by default (configurable)
 * - Additional host directories can be mounted into container
 *
 * This mirrors the sandbox implementation from lllm (~/dev/projects/047-llm-harness).
 */

import { homedir } from "node:os";
import { posix, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

import { createSandboxedBashOps, DEFAULT_CONFIG, sandboxName, selectBackend } from "./backends/index";
import type { AnyBackend } from "./backends/types";
import { loadConfig } from "./config";

/** A container path -> host path mapping for a mounted directory */
interface MountMapping {
	container: string; // absolute container path, normalized
	host: string; // absolute host path
}

/** Active sandbox state. Non-null only while the sandbox is fully initialized. */
interface SandboxState {
	backend: AnyBackend;
	cleanup: () => Promise<void>;
	backendType: string;
	image: string;
	netInfo: string;
	networkIsolated: boolean;
	/** In-container mount point of the host cwd (configurable, default /workdir) */
	workdirMount: string;
	/** All mounted directories, including the workdir */
	mounts: MountMapping[];
}

/** True if `candidate` is `root` or inside it. Both must be absolute, normalized paths. */
function isWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

/** Expand a leading ~ and resolve against the given base dir. */
function toAbsoluteHostPath(p: string, base: string): string {
	const expanded = p.startsWith("~/") ? homedir() + p.slice(1) : p;
	return resolvePath(base, expanded);
}

/**
 * Map a container path to a host path, or null if the path is outside all mounts.
 * Returns the rewritten host path; falls back to `resolvedElsewhere` when the
 * mapping succeeded without changing the path.
 */
function containerToHostPath(
	p: string,
	mounts: MountMapping[],
	relativeBase: string,
): { hostPath: string } | { block: string } {
	// Normalize separators and resolve . / .. lexically. We cannot use
	// fs.realpath here: container paths (e.g. /workdir/...) do not exist
	// on the host, so canonicalization must stay purely lexical.
	const normalized = posix.normalize(p.replace(/\\/g, "/"));

	if (!posix.isAbsolute(normalized)) {
		// Relative path: resolve against the host cwd (== the mounted workdir).
		const hostPath = resolvePath(relativeBase, p);
		// Must still land inside one of the mounted host dirs (blocks ../ escapes).
		for (const m of mounts) {
			if (isWithin(m.host, hostPath)) return { hostPath };
		}
		return {
			block: `Path '${p}' escapes the sandbox mounts. Use the bash tool to access files outside the mounted directories.`,
		};
	}

	// Absolute path: match against known container mount points (longest prefix wins).
	let best: MountMapping | null = null;
	for (const m of mounts) {
		if (isWithin(m.container, normalized) && (!best || m.container.length > best.container.length)) {
			best = m;
		}
	}
	if (best) {
		const hostPath = resolvePath(best.host, normalized.slice(best.container.length));
		return { hostPath };
	}

	return {
		block: `Path '${p}' is outside the sandbox. Use bash to access it inside the container, e.g. bash "cat ${p}"`,
	};
}

export default function (pi: ExtensionAPI) {
	// CLI flags
	pi.registerFlag("no-sandbox", {
		description: "Disable container-based sandboxing",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("sandbox-backend", {
		description: "Force backend: apple, docker, lima, or auto",
		type: "string",
		default: "auto",
	});

	pi.registerFlag("sandbox-network", {
		description: "Allow network access in sandbox",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("sandbox-mount", {
		description: "Additional mount: hostPath:containerPath (can repeat)",
		type: "string",
		default: "",
		multiple: true,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	// Single source of truth: sandbox != null only after the backend is fully
	// initialized (backend, cleanup and config are set atomically together).
	let sandbox: SandboxState | null = null;

	// Override bash tool with sandboxed version
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (!sandbox) return localBash.execute(id, params, signal, onUpdate, ctx);
			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(sandbox.backend),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	// Intercept user_bash event
	pi.on("user_bash", () => {
		if (!sandbox) return;
		return { operations: createSandboxedBashOps(sandbox.backend) };
	});

	// Modify system prompt to hide host paths and indicate sandbox
	pi.on("before_agent_start", (event: any) => {
		if (!sandbox) return;

		const workdirMount = sandbox.workdirMount;
		// Replace host paths with the container mount point in system prompt.
		// The agent should not know about host paths.
		const hostCwd = process.cwd();
		const sandboxPrompt = event.systemPrompt.replace(
			new RegExp(hostCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$"), "g"),
			workdirMount,
		);

		const netAllowed = sandbox.networkIsolated;
		return {
			systemPrompt:
				`${sandboxPrompt}\n\n` +
				`You are running in a sandboxed ${sandbox.backendType} container (image: ${sandbox.image}, ` +
				`${netAllowed ? "network access allowed" : "NO network access"}).\n` +
				`The current host directory is mounted at ${workdirMount} in the container.\n` +
				`Use relative paths or ${workdirMount}/... for file operations.\n` +
				(sandbox.mounts.length > 1
					? `Additional mounted directories: ${sandbox.mounts
							.filter((m) => m.container !== workdirMount)
							.map((m) => `${m.container} (host: hidden)`)
							.join(", ")}.\n`
					: "") +
				`Use the bash tool to access files outside the mounted directories.`,
		};
	});

	// Restrict read/write/edit to the mounted directories.
	//
	// Important: these tools run on the HOST filesystem (pi resolves the path
	// against the host cwd and calls host fs operations). The mounted dirs are
	// bind mounts of host dirs, so writing through the host and through the
	// container is the same data. To keep the sandbox airtight we:
	//  1. rewrite container paths (e.g. /workdir/foo) to their host equivalents,
	//  2. resolve relative paths against the host cwd and require them to stay
	//     inside a mounted host dir (blocks ../../ escapes),
	//  3. block absolute paths that map to no mount.
	// Without the rewrite, /workdir would either fail (no such host path) or,
	// worse, hit an unrelated real host /workdir — an escape hatch.
	pi.on("tool_call", (event: any) => {
		if (!sandbox) return;
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;

		const path = event.input?.path;
		if (typeof path !== "string" || !path) return;

		const result = containerToHostPath(path, sandbox.mounts, localCwd);
		if ("block" in result) return { block: true, reason: result.block };

		// Mutate input in place: the tool then resolves/executes the host path.
		event.input.path = result.hostPath;
		return;
	});

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		const forcedBackend = pi.getFlag("sandbox-backend") as string | undefined;
		const networkAllowed = pi.getFlag("sandbox-network") as boolean;
		const mountFlags = pi.getFlag("sandbox-mount") as string | string[] | undefined;

		if (noSandbox) {
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);
		if (!config.enabled!) {
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		// Parse mounts from CLI
		const cliMounts: Record<string, string> = {};
		if (mountFlags) {
			const mountsArray = Array.isArray(mountFlags) ? mountFlags : [mountFlags];
			for (const mount of mountsArray) {
				if (mount?.includes(":")) {
					const [hostPath, containerPath] = mount.split(":", 2);
					cliMounts[hostPath] = containerPath;
				}
			}
		}

		const mounts = { ...(config.mounts || {}), ...cliMounts };
		const networkIsolated = !networkAllowed && (config.networkIsolated ?? DEFAULT_CONFIG.networkIsolated!);
		const netInfo = networkIsolated ? "NO network" : "network allowed";
		const workdirMount = posix.normalize(config.workdirMount || DEFAULT_CONFIG.workdirMount!);

		try {
			const result = await selectBackend(
				forcedBackend,
				config.image || DEFAULT_CONFIG.image!,
				networkIsolated,
				mounts,
				workdirMount,
			);
			if (!result) {
				throw new Error("No sandbox backend available (tried apple, docker, lima)");
			}

			// Build the container -> host mount map (workdir first, then extra mounts)
			const mountMappings: MountMapping[] = [
				{ container: workdirMount, host: localCwd },
				...Object.entries(mounts).map(([host, container]) => ({
					container: posix.normalize(container),
					host: toAbsoluteHostPath(host, localCwd),
				})),
			];

			const state: SandboxState = {
				backend: result.backend,
				cleanup: result.cleanup,
				backendType: result.backend.type,
				image: config.image || DEFAULT_CONFIG.image!,
				netInfo,
				networkIsolated,
				workdirMount,
				mounts: mountMappings,
			};
			sandbox = state;

			// Update bash tool description
			const allTools = pi.getAllTools();
			const bashTool = allTools.find((t: any) => t.name === "bash");
			if (bashTool) {
				bashTool.description =
					`Execute commands in sandboxed ${state.backendType} container (${state.image}, ${netInfo}). ` +
					`Host CWD at ${workdirMount}. Relative paths work with read/write/edit; ` +
					`use bash for absolute paths outside ${workdirMount}.`;
			}

			// Build mount list including the workdir
			const allMounts = mountMappings.map(
				(m) => `${m.container} (host: ${m.host === localCwd ? localCwd : m.host})`,
			);
			ctx.ui.notify(
				`Sandbox: ${state.backendType} backend, ${netInfo}, image: ${state.image}, mounts: ${allMounts.join(", ")}`,
				"info",
			);
		} catch (err) {
			// Hard failure - exit pi if sandbox cannot be initialized
			ctx.ui.notify(`Sandbox initialization failed: ${err}`, "error");
			ctx.ui.notify("FATAL: Sandbox required but cannot be initialized. Exiting.", "error");
			process.exit(1);
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandbox?.cleanup) {
			try {
				await sandbox.cleanup();
			} catch {
				// Ignore cleanup errors
			}
		}
		sandbox = null;
	});

	// Status command
	pi.registerCommand("pi-sandbox", {
		description: "Show sandbox status",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const forcedBackend = pi.getFlag("sandbox-backend") as string | undefined;
			const networkAllowed = pi.getFlag("sandbox-network") as boolean;
			const networkIsolated = !networkAllowed && (config.networkIsolated ?? DEFAULT_CONFIG.networkIsolated!);

			const mountLines =
				sandbox && sandbox.mounts.length > 1
					? ["", "Mounts:", ...sandbox.mounts.map((m) => `  ${m.container} (host: ${m.host})`)]
					: [];

			ctx.ui.notify(
				[
					`Sandbox: ${sandbox ? "ENABLED" : "DISABLED"} (${sandbox?.backendType || "none"})`,
					`Image: ${config.image || DEFAULT_CONFIG.image}`,
					`Network: ${networkIsolated ? "ISOLATED" : "ALLOWED"}`,
					`Backend: ${config.backend} (forced: ${forcedBackend || "none"})`,
					...mountLines,
					`Container: ${sandbox ? sandboxName() : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

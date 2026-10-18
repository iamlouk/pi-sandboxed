/**
 * pi-sandboxed - Container-based sandbox extension for pi
 *
 * Runs all commands in isolated containers. When enabled:
 * - bash commands run in sandboxed container (apple/docker backend)
 * - read/write/edit tools are restricted to mounted directories:
 *   container paths are rewritten to their host equivalents (the tools
 *   operate on the host filesystem, but the mounted dirs are the same
 *   data as inside the container, so both views stay consistent)
 * - Network access is DISABLED by default (configurable)
 * - Additional host directories can be mounted into container
 *
 * Independently of the sandbox:
 * - `choices` tool: ask the user multiple-choice questions
 * - `hostTools` config: user-authored allowlist of shell commands exposed to
 *   the LLM as custom tools that run on the HOST (e.g. "ninja test")
 * - the pi-sandboxed config files are protected: write/edit tools are blocked
 *   from modifying them, and the project `.pi` dir is mounted read-only into
 *   the container so sandboxed bash cannot touch it either
 *
 * This mirrors the sandbox implementation from lllm (~/dev/projects/047-llm-harness).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";

import { createSandboxedBashOps, DEFAULT_CONFIG, sandboxName, selectBackend } from "./backends/index";
import type { AnyBackend, ReadOnlyMount } from "./backends/types";
import { configFilePaths, loadConfig } from "./config";
import { registerChoicesTool } from "./extras/choices";
import { registerHostTools } from "./extras/host-tools";

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
	/** Read-only overlay mounts applied to the container (protected paths) */
	readOnlyMounts: ReadOnlyMount[];
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
 * Map a container path to a host path, or block if the path is outside all mounts.
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
		// posix.relative strips the container prefix without leaving a leading
		// slash (a plain slice would make the remainder absolute and drop the
		// host base when passed to resolvePath).
		const hostPath = resolvePath(best.host, posix.relative(best.container, normalized));
		return { hostPath };
	}

	return {
		block: `Path '${p}' is outside the sandbox. Use bash to access it inside the container, e.g. bash "cat ${p}"`,
	};
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const configPaths = configFilePaths(localCwd);
	// Project pi config dir: protected from agent modification in every mode
	const projectPiDir = join(localCwd, ".pi");

	/** Host paths the agent must never modify (reading is fine) */
	function isProtectedHostPath(hostPath: string): boolean {
		return isWithin(projectPiDir, hostPath) || hostPath === configPaths.global;
	}

	// Extras: choices tool for asking the user multiple-choice questions
	registerChoicesTool(pi);

	// Extras: user-configured host tools (from pi-sandboxed.json). These are an
	// explicit user-authored allowlist - the agent cannot register new ones.
	const hostToolNames = registerHostTools(pi, loadConfig(localCwd).hostTools, localCwd);

	// CLI flags
	pi.registerFlag("no-sandbox", {
		description: "Disable container-based sandboxing",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("sandbox-backend", {
		description: "Force backend: apple, docker, or auto",
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

	const localBash = createBashTool(localCwd);

	// Single source of truth: sandbox != null only after the backend is fully
	// initialized (backend, cleanup and config are set atomically together).
	let sandbox: SandboxState | null = null;

	/** Warn if the project pi-sandboxed.json exists but is not protected (ro-mounted). */
	function warnIfConfigUnprotected(ctx: { ui: { notify: (msg: string, kind: string) => void } }, reason: string) {
		if (existsSync(configPaths.project)) {
			ctx.ui.notify(
				`pi-sandboxed.json is present but NOT protected (${reason}). ` +
					"The agent can modify it (e.g. to disable the sandbox or add host tools for the next session). " +
					"Start the sandbox or move the config to a protected location.",
				"warning",
			);
		}
	}

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
				(sandbox.readOnlyMounts.length > 0
					? `Read-only (do not attempt to modify): ${sandbox.readOnlyMounts.map((m) => m.container).join(", ")}.\n`
					: "") +
				`Use the bash tool to access files outside the mounted directories.`,
		};
	});

	// Restrict read/write/edit to the mounted directories, and protect the config.
	//
	// Important: these tools run on the HOST filesystem (pi resolves the path
	// against the host cwd and calls host fs operations). The mounted dirs are
	// bind mounts of host dirs, so writing through the host and through the
	// container is the same data. To keep the sandbox airtight we:
	//  1. rewrite container paths (e.g. /workdir/foo) to their host equivalents,
	//  2. resolve relative paths against the host cwd and require them to stay
	//     inside a mounted host dir (blocks ../../ escapes),
	//  3. block absolute paths that map to no mount,
	//  4. block write/edit to protected config paths in every mode - without
	//     this, an agent could edit pi-sandboxed.json to grant itself host
	//     tools or disable the sandbox for the next session.
	// Without the rewrite, /workdir would either fail (no such host path) or,
	// worse, hit an unrelated real host /workdir — an escape hatch.
	pi.on("tool_call", (event: any) => {
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;

		const path = event.input?.path;
		if (typeof path !== "string" || !path) return;

		// Resolve to a host path. Sandboxed: map through the mounts (may block).
		// Unsandboxed: resolve relative paths against the host cwd as pi would.
		let hostPath: string;
		if (process.env.PI_SANDBOXED_DEBUG)
			console.error(
				`[pi-sandboxed] tool_call ${event.toolName} path=${path} sandbox=${!!sandbox} mounts=${sandbox ? JSON.stringify(sandbox.mounts) : null} localCwd=${localCwd}`,
			);
		if (sandbox) {
			const result = containerToHostPath(path, sandbox.mounts, localCwd);
			if ("block" in result) return { block: true, reason: result.block };
			hostPath = result.hostPath;
		} else {
			hostPath = toAbsoluteHostPath(path, localCwd);
		}

		// Protected config paths: read-only for the agent, in every mode.
		if (event.toolName !== "read" && isProtectedHostPath(hostPath)) {
			return {
				block: true,
				reason:
					`Refusing to modify protected config path '${path}'. ` +
					"The pi-sandboxed configuration is managed by the user; ask the user to change it.",
			};
		}

		if (process.env.PI_SANDBOXED_DEBUG) console.error(`[pi-sandboxed] -> hostPath=${hostPath}`);
		// Mutate input in place: the tool then resolves/executes the host path.
		if (sandbox) event.input.path = hostPath;
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
			warnIfConfigUnprotected(ctx, "sandbox disabled via --no-sandbox");
			return;
		}

		const config = loadConfig(ctx.cwd);
		if (!config.enabled!) {
			ctx.ui.notify("Sandbox disabled via config", "info");
			warnIfConfigUnprotected(ctx, "sandbox disabled via config");
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

		// Read-only protection for the project pi config dir: if the sandbox
		// config lives inside the mounted workdir, sandboxed bash could edit it
		// through the bind mount. Overlay-mount .pi read-only to prevent that.
		const readOnlyMounts: ReadOnlyMount[] = existsSync(projectPiDir)
			? [{ host: projectPiDir, container: posix.join(workdirMount, ".pi") }]
			: [];

		try {
			const result = await selectBackend(
				forcedBackend,
				config.image || DEFAULT_CONFIG.image!,
				networkIsolated,
				mounts,
				workdirMount,
				readOnlyMounts,
			);
			if (!result) {
				throw new Error("No sandbox backend available (tried apple, docker)");
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
				readOnlyMounts,
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
			const allMounts = mountMappings.map((m) => `${m.container} (host: ${m.host})`);
			const roList = readOnlyMounts.map((m) => m.container).join(", ");
			ctx.ui.notify(
				`Sandbox: ${state.backendType} backend, ${netInfo}, image: ${state.image}, mounts: ${allMounts.join(", ")}` +
					(roList ? `, read-only: ${roList}` : ""),
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
			const roLines =
				sandbox && sandbox.readOnlyMounts.length > 0
					? ["", "Read-only (protected):", ...sandbox.readOnlyMounts.map((m) => `  ${m.container}`)]
					: [];

			ctx.ui.notify(
				[
					`Sandbox: ${sandbox ? "ENABLED" : "DISABLED"} (${sandbox?.backendType || "none"})`,
					`Image: ${config.image || DEFAULT_CONFIG.image}`,
					`Network: ${networkIsolated ? "ISOLATED" : "ALLOWED"}`,
					`Backend: ${config.backend} (forced: ${forcedBackend || "none"})`,
					...mountLines,
					...roLines,
					`Host tools: ${hostToolNames.length > 0 ? hostToolNames.join(", ") : "none"}`,
					`Config protected: ${existsSync(projectPiDir) ? (sandbox ? "yes (.pi read-only)" : "write/edit only") : "no .pi dir"}`,
					`Container: ${sandbox ? sandboxName() : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

/**
 * Shared types for sandbox backends
 */

export interface SandboxConfig {
	enabled?: boolean;
	backend?: "auto" | "apple" | "docker";
	image?: string;
	dockerHost?: string;
	timeout?: number;
	/** Network isolation: if true, container has no internet access (default: true) */
	networkIsolated?: boolean;
	/** Additional host directories to mount in container. Format: {"hostPath": "/container/path"} */
	mounts?: Record<string, string>;
	/** In-container mount point for the host cwd. Default: "/workdir" */
	workdirMount?: string;
	/** Custom LLM-facing tools that run shell commands on the host (user-authored allowlist) */
	hostTools?: HostTool[];
}

/** A user-configured custom tool exposed to the LLM that runs a shell command on the host */
export interface HostTool {
	/** Tool name exposed to the LLM (alphanumeric, dashes, underscores) */
	name: string;
	/** Shell command to run on the host */
	command: string;
	/** Tool description shown to the LLM. Default: "Run `<command>` on the host." */
	description?: string;
	/** Working directory for the command. Default: the pi host cwd */
	cwd?: string;
	/** Timeout in seconds. Default: 120 */
	timeout?: number;
}

export const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	backend: "auto",
	image: "alpine:latest",
	timeout: 30,
	networkIsolated: true, // No internet access by default
	mounts: {}, // Additional host directories to mount
	workdirMount: "/workdir", // In-container mount point for the host cwd
	hostTools: [], // Custom LLM-facing tools running shell commands on the host
};

export class BackendUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackendUnavailableError";
	}
}

export interface Backend {
	type: "apple" | "docker";
	name: string;
}

export interface DockerBackend extends Backend {
	type: "docker";
	cli: any;
	containerID: string;
}

export interface AppleBackend extends Backend {
	type: "apple";
}

export type AnyBackend = DockerBackend | AppleBackend;

/** An extra read-only overlay mount: `host` is mounted at `container` read-only */
export interface ReadOnlyMount {
	host: string;
	container: string;
}

export interface BackendResult {
	backend: AnyBackend;
	cleanup: () => Promise<void>;
	networkIsolated: boolean;
}

/**
 * Shared types for sandbox backends
 */

export interface SandboxConfig {
	enabled?: boolean;
	backend?: "auto" | "apple" | "docker" | "lima";
	image?: string;
	limaInstance?: string;
	dockerHost?: string;
	timeout?: number;
	/** Network isolation: if true, container has no internet access (default: true) */
	networkIsolated?: boolean;
	/** Additional host directories to mount in container. Format: {"hostPath": "/container/path"} */
	mounts?: Record<string, string>;
	/** In-container mount point for the host cwd. Default: "/workdir" */
	workdirMount?: string;
}

export const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	backend: "auto",
	image: "alpine:latest",
	limaInstance: "pi-sandbox",
	timeout: 30,
	networkIsolated: true, // No internet access by default
	mounts: {}, // Additional host directories to mount
	workdirMount: "/workdir", // In-container mount point for the host cwd
};

export class BackendUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackendUnavailableError";
	}
}

export interface Backend {
	type: "apple" | "docker" | "lima";
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

export interface LimaBackend extends Backend {
	type: "lima";
	instanceName: string;
	dockerHost: string;
	innerBackend: DockerBackend | null;
}

export type AnyBackend = DockerBackend | AppleBackend | LimaBackend;

export interface BackendResult {
	backend: AnyBackend;
	cleanup: () => Promise<void>;
	networkIsolated: boolean;
}

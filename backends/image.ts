/**
 * Dockerfile-based image building and caching
 *
 * Instead of a prebuilt image name, the config can point at a Dockerfile.
 * The image is built once (by the selected backend) and cached under
 * `pi-sandboxed-image:<sha>` where <sha> is derived from the Dockerfile
 * contents - an unchanged Dockerfile reuses the cached image on the next
 * session. The backend-specific build/lookup functions live in apple.ts and
 * docker.ts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

/** A resolved Dockerfile to build and cache */
export interface DockerfileSpec {
	/** Absolute path to the Dockerfile */
	path: string;
	/** Build context directory (parent of the Dockerfile) */
	context: string;
	/** Cache tag: `pi-sandboxed-image:<sha>` keyed on the Dockerfile contents */
	tag: string;
}

/** Build a DockerfileSpec from a Dockerfile path. Throws if unreadable. */
export function dockerfileSpec(dockerfilePath: string): DockerfileSpec {
	const content = readFileSync(dockerfilePath);
	const sha = createHash("sha256").update(content).digest("hex").slice(0, 12);
	return {
		path: dockerfilePath,
		context: dirname(dockerfilePath),
		tag: `pi-sandboxed-image:${sha}`,
	};
}

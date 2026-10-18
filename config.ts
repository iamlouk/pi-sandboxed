/**
 * Configuration loading for pi-sandboxed
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type SandboxConfig } from "./backends/types";

export function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "pi-sandboxed.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "pi-sandboxed.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}

export { BackendUnavailableError, DEFAULT_CONFIG, SandboxConfig } from "./backends/types";

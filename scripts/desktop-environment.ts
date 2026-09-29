import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";

/** Keep Bun's Windows AF_UNIX endpoint out of deeply nested project paths.
 * The project hash preserves per-workspace host isolation and restart identity.
 */
export function desktopAgentHostSocket(
	projectRoot: string,
	platform = process.platform,
	tempRoot = tmpdir(),
	userHome = homedir(),
): string {
	if (platform !== "win32") {
		const local = join(projectRoot, ".forgeax", "runtime", "agent-host.sock");
		if (Buffer.byteLength(local) <= 100) return local;
		const id = createHash("sha256")
			.update(projectRoot)
			.digest("hex")
			.slice(0, 20);
		const compact = join(userHome, ".forgeax", "ipc", `host-${id}.sock`);
		if (Buffer.byteLength(compact) > 100)
			throw new Error(
				"Desktop agent-host socket exceeds the Unix path limit even under the user data directory",
			);
		return compact;
	}
	const identity = win32
		.normalize(normalizeWindowsDevicePath(projectRoot, platform))
		.toLowerCase();
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
	const endpoint = win32.join(tempRoot, `fxhost-${hash}.sock`);
	if (Buffer.byteLength(endpoint) >= 108) {
		throw new Error(
			"Windows TEMP path is too long for the agent-host socket; configure a shorter TEMP directory",
		);
	}
	return endpoint;
}

function nvmNodeBinPaths(userHome: string): string[] {
	const versionsRoot = join(userHome, ".nvm", "versions", "node");
	try {
		return readdirSync(versionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((left, right) =>
				right.localeCompare(left, undefined, { numeric: true }),
			)
			.map((version) => join(versionsRoot, version, "bin"));
	} catch {
		return [];
	}
}

export function normalizeWindowsDevicePath(
	value: string,
	platform = process.platform,
): string {
	if (platform !== "win32") return value;
	if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
	if (value.startsWith("\\\\?\\")) return value.slice(4);
	return value;
}

/**
 * macOS GUI applications inherit launchd's minimal PATH instead of the user's
 * interactive-shell PATH. Keep the inherited entries, then admit the standard
 * Homebrew, per-user, and installed NVM Node bin locations used by the reference agent CLI,
 * Codex, and other local agent drivers. Provider-specific *_CLI_PATH overrides
 * still take precedence.
 */
export function desktopExecutablePath(
	inherited = process.env.PATH ?? "",
	platform = process.platform,
	userHome = homedir(),
): string {
	if (platform !== "darwin") return inherited;

	const entries = [
		...inherited.split(delimiter),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(userHome, ".local", "bin"),
		join(userHome, ".bun", "bin"),
		...nvmNodeBinPaths(userHome),
	].filter((entry) => entry.length > 0);

	return [...new Set(entries)].join(delimiter);
}

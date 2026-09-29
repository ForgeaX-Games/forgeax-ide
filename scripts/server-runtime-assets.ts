import { join } from "node:path";

export const SERVER_RUNTIME_ASSET_NAMES = [
	"game-charter.md",
	"ui-bridge-contract.json",
	"watcher-worker.mjs",
] as const;

const SERVER_RUNTIME_ASSET_NAME_SET = new Set<string>(
	SERVER_RUNTIME_ASSET_NAMES,
);
const POSIX_BUN_ROOT = "/$bunfs/root/";
const WINDOWS_BUN_ROOT = "B:/~BUN/root/";
const NativeURL = URL;

function bunVirtualPath(value: string | URL): string | null {
	let rendered = value instanceof NativeURL ? value.href : value;
	if (rendered.startsWith("file:")) {
		let url: URL;
		try {
			url = new NativeURL(rendered);
		} catch {
			return null;
		}
		if (
			url.protocol !== "file:" ||
			(url.hostname !== "" && url.hostname !== "localhost")
		)
			return null;
		try {
			rendered = decodeURIComponent(url.pathname);
		} catch {
			return null;
		}
	}

	const normalized = rendered.replaceAll("\\", "/");
	if (normalized.startsWith(POSIX_BUN_ROOT)) return normalized;
	if (normalized.startsWith(`/${WINDOWS_BUN_ROOT}`)) return normalized.slice(1);
	if (normalized.startsWith(WINDOWS_BUN_ROOT)) return normalized;
	return null;
}

/**
 * Resolve a direct, allowlisted file below a confirmed Bun compiled virtual
 * root. Ordinary disk paths, nested paths, and traversal never remap.
 */
export function resolveServerRuntimeAsset(
	value: string | URL,
	assetRoot: string,
): string | null {
	const virtualPath = bunVirtualPath(value);
	if (!virtualPath) return null;
	const prefix = virtualPath.startsWith(POSIX_BUN_ROOT)
		? POSIX_BUN_ROOT
		: WINDOWS_BUN_ROOT;
	const name = virtualPath.slice(prefix.length);
	if (!name || name.includes("/") || !SERVER_RUNTIME_ASSET_NAME_SET.has(name))
		return null;
	return join(assetRoot, name);
}

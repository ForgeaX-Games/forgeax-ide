import { existsSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export interface WorkspaceEntries {
	name?: string;
	main?: string;
	types?: string;
	typings?: string;
	exports?: unknown;
}

export function missingWorkspaceEntries(
	root: string,
	manifest: WorkspaceEntries,
): string[] {
	const entries = new Set<string>();
	if (manifest.main?.startsWith("./dist/")) entries.add(manifest.main);
	if (manifest.types) entries.add(manifest.types);
	if (manifest.typings) entries.add(manifest.typings);
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "types" && typeof child === "string") {
				entries.add(child);
				if (child.includes("*")) {
					const runtimeTargets = (target: unknown): string[] => {
						if (typeof target === "string") return [target];
						if (!target || typeof target !== "object") return [];
						return Object.entries(target).flatMap(([condition, nested]) =>
							condition === "types" ? [] : runtimeTargets(nested),
						);
					};
					for (const runtime of runtimeTargets(value)) {
						if (!runtime.includes("*")) continue;
						const pattern = runtime.replace(/^\.\//, "");
						const [prefix = "", suffix] = pattern.split("*");
						for (const file of new Glob(pattern).scanSync({
							cwd: root,
							onlyFiles: true,
						})) {
							const path = file.replaceAll("\\", "/").replace(/^\.\//, "");
							const capture = path.slice(
								prefix.length,
								suffix ? -suffix.length : undefined,
							);
							entries.add(child.replaceAll("*", capture));
						}
					}
				}
			} else visit(child);
		}
	};
	visit(manifest.exports);
	return [...entries].filter((entry) =>
		entry.includes("*")
			? [...new Glob(entry).scanSync({ cwd: root, onlyFiles: true })].length ===
				0
			: !existsSync(join(root, entry)),
	);
}

/** Existing JS output is insufficient when package.json declares missing types. */
export function ensureWorkspaceEntries(
	root: string,
	manifest: WorkspaceEntries,
	build: () => void,
): void {
	if (!missingWorkspaceEntries(root, manifest).length) return;
	build();
	const missing = missingWorkspaceEntries(root, manifest);
	if (missing.length)
		throw new Error(
			`workspace build entries missing for ${manifest.name ?? root}: ${missing.join(", ")}`,
		);
}

/** Use the selected workspace compiler, never an ancestor or bunx download. */
export function workspaceTypeScriptBuildArgs(
	workspaceRoot: string,
	args: string[],
): string[] {
	const compiler = join(
		workspaceRoot,
		"node_modules",
		"typescript",
		"bin",
		"tsc",
	);
	if (!existsSync(compiler))
		throw new Error(`workspace TypeScript compiler is missing: ${compiler}`);
	return [compiler, ...args];
}

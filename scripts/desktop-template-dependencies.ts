import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** External template requirements are build inputs, not optional Play dependencies. */
export function templateExternalDependencies(
	templates: string,
): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const entry of readdirSync(templates, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			!existsSync(join(templates, entry.name, "forge.json"))
		)
			continue;
		const manifest = JSON.parse(
			readFileSync(join(templates, entry.name, "package.json"), "utf8"),
		);
		for (const section of ["dependencies", "devDependencies"]) {
			for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
				if (name.startsWith("@forgeax/")) continue;
				if (typeof spec !== "string")
					throw new Error(`Invalid template dependency: ${entry.name}/${name}`);
				result.set(name, [...new Set([...(result.get(name) ?? []), spec])]);
			}
		}
	}
	return result;
}

export function verifyTemplateExternalDependencies(
	templates: string,
	modules: string,
): string[] {
	const required: string[] = [];
	for (const [name, specs] of templateExternalDependencies(templates)) {
		const path = join(modules, name, "package.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		if (
			manifest.name !== name ||
			typeof manifest.version !== "string" ||
			!specs.every((spec) => Bun.semver.satisfies(manifest.version, spec))
		) {
			throw new Error(
				`Template dependency ${name} requires ${specs.join(" and ")}, but ${path} provides ${String(manifest.version)}`,
			);
		}
		const bins =
			typeof manifest.bin === "string"
				? [manifest.bin]
				: Object.values(manifest.bin ?? {});
		for (const bin of bins) {
			if (typeof bin !== "string" || !existsSync(join(modules, name, bin))) {
				throw new Error(
					`Template dependency ${name} has a missing executable: ${String(bin)}`,
				);
			}
		}
		const types = manifest.types ?? manifest.typings;
		if (typeof types === "string" && !existsSync(join(modules, name, types))) {
			throw new Error(
				`Template dependency ${name} has a missing type entry: ${types}`,
			);
		}
		required.push(name);
	}
	return required;
}

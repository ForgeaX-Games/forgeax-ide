import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { verifyTemplateExternalDependencies } from "./desktop-template-dependencies";

// Server derives project dependencies from the packaged template root. The
// Play workspace is the source of the already assembled dependency closure.
const ENGINE_ROOT = "editor/packages/engine";
const SOURCE = "engine/node_modules";
const DESTINATION = `${ENGINE_ROOT}/node_modules`;

function inventory(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	function walk(relativePath: string): void {
		const path = join(root, relativePath);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink())
			throw new Error(
				`desktop Engine dependencies must be self-contained: ${path}`,
			);
		if (stat.isDirectory()) {
			for (const name of readdirSync(path).sort())
				walk(relativePath ? `${relativePath}/${name}` : name);
		} else if (stat.isFile() && relativePath) {
			files[relativePath] = createHash("sha256")
				.update(readFileSync(path))
				.digest("hex");
		} else
			throw new Error(`unsupported desktop Engine dependency entry: ${path}`);
	}
	if (!lstatSync(root).isDirectory())
		throw new Error(`desktop Engine dependency directory is missing: ${root}`);
	walk("");
	return files;
}

function requiredPackages(resources: string): string[] {
	const templates = join(resources, ENGINE_ROOT, "templates");
	const packages = new Set<string>();
	let count = 0;
	for (const entry of readdirSync(templates, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			!existsSync(join(templates, entry.name, "forge.json"))
		)
			continue;
		const manifest = JSON.parse(
			readFileSync(join(templates, entry.name, "package.json"), "utf8"),
		);
		count += 1;
		for (const section of ["dependencies", "devDependencies"]) {
			for (const name of Object.keys(manifest[section] ?? {})) {
				if (!name.startsWith("@forgeax/")) continue;
				if (!/^@forgeax\/[a-z0-9][a-z0-9._-]*$/.test(name))
					throw new Error(`invalid Engine package name: ${name}`);
				packages.add(name);
			}
		}
	}
	if (!count || !packages.size)
		throw new Error(`no Engine template dependency contracts: ${templates}`);
	return [...packages].sort();
}

function sourceInputs(resources: string) {
	const packages = [
		...requiredPackages(resources),
		...verifyTemplateExternalDependencies(
			join(resources, ENGINE_ROOT, "templates"),
			join(resources, SOURCE),
		),
	];
	const files = inventory(join(resources, SOURCE));
	for (const name of packages) {
		const manifest = JSON.parse(
			readFileSync(join(resources, SOURCE, name, "package.json"), "utf8"),
		);
		if (manifest.name !== name)
			throw new Error(`desktop Engine package identity mismatch: ${name}`);
	}
	return { packages, files };
}

export function verifyDesktopEngineDependencies(resources: string): string[] {
	const { packages, files } = sourceInputs(resources);
	if (
		JSON.stringify(inventory(join(resources, DESTINATION))) !==
		JSON.stringify(files)
	) {
		throw new Error(
			"desktop project Engine dependencies differ from the assembled Play dependency closure",
		);
	}
	return packages.map((name) => `${DESTINATION}/${name}/package.json`);
}

export function stageDesktopEngineDependencies(resources: string): string[] {
	const { files } = sourceInputs(resources);
	const destination = join(resources, DESTINATION);
	// Never overwrite an existing foreign/stale closure. Assembly clears its
	// owned resource tree before staging; repeated calls must verify equality.
	if (lstatSync(destination, { throwIfNoEntry: false }))
		return verifyDesktopEngineDependencies(resources);
	const temporary = mkdtempSync(
		join(resources, ENGINE_ROOT, ".dependency-stage-"),
	);
	try {
		const staged = join(temporary, "node_modules");
		cpSync(join(resources, SOURCE), staged, {
			recursive: true,
			dereference: false,
		});
		if (
			JSON.stringify(inventory(staged)) !== JSON.stringify(files) ||
			JSON.stringify(inventory(join(resources, SOURCE))) !==
				JSON.stringify(files)
		) {
			throw new Error("desktop Engine dependencies changed during assembly");
		}
		renameSync(staged, destination);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	return verifyDesktopEngineDependencies(resources);
}

if (import.meta.main) {
	const index = Bun.argv.indexOf("--resources");
	if (index < 0 || !Bun.argv[index + 1])
		throw new Error("--resources is required");
	const resources = resolve(Bun.argv[index + 1]!);
	const required = Bun.argv.includes("--stage")
		? stageDesktopEngineDependencies(resources)
		: verifyDesktopEngineDependencies(resources);
	console.log(
		JSON.stringify({
			code: "IDE_DESKTOP_ENGINE_DEPENDENCIES_VALID",
			resources,
			required,
		}),
	);
}

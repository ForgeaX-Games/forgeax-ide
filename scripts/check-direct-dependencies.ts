#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import inventory from "../product/direct-dependencies.json";

export function forgeaxImports(fileName: string, source: string): string[] {
	const imports = new Set<string>();
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	function visit(node: ts.Node): void {
		let value: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			value = node.moduleSpecifier;
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			value = node.argument.literal;
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		)
			value = node.arguments[0];
		if (
			value &&
			ts.isStringLiteralLike(value) &&
			value.text.startsWith("@forgeax/")
		)
			imports.add(value.text);
		ts.forEachChild(node, visit);
	}
	visit(file);
	return [...imports].sort();
}

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.[cm]?[jt]sx?$/.test(entry.name) &&
			!/\.(?:d\.ts|test\.[jt]sx?)$/.test(entry.name)
			? [path]
			: [];
	});
}

export function checkInstalledOptionalDependencies(ide: string): string[] {
	const manifest = JSON.parse(readFileSync(join(ide, "package.json"), "utf8"));
	const errors: string[] = [];
	for (const [name, version] of Object.entries(
		manifest.optionalDependencies ?? {},
	)) {
		if (
			typeof version !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
		)
			continue;
		const path = join(ide, "node_modules", name, "package.json");
		// Optional packages may be absent on unsupported platforms. An installed
		// copy must still match the selected release instead of masking the lock.
		if (!existsSync(path)) continue;
		const installed = JSON.parse(readFileSync(path, "utf8"));
		if (installed.name !== name || installed.version !== version)
			errors.push(
				`${name}: expected ${version}, installed ${installed.name}@${installed.version}`,
			);
	}
	return errors;
}

export function checkDirectDependencies(ide: string): string[] {
	const errors: string[] = checkInstalledOptionalDependencies(ide);
	const manifest = JSON.parse(readFileSync(join(ide, "package.json"), "utf8"));
	const declared: Record<string, string> = manifest.dependencies;
	const names = Object.keys(declared)
		.filter((name) => name.startsWith("@forgeax/"))
		.sort();
	if (
		JSON.stringify(names) !==
		JSON.stringify(Object.keys(inventory.packages).sort())
	) {
		errors.push(
			"Every direct @forgeax dependency must have an IDE Web CI repository mapping.",
		);
	}
	const studio = resolve(ide, "../..");
	for (const [name, contract] of Object.entries(inventory.packages)) {
		const installed = join(ide, "node_modules", name);
		if (!existsSync(join(installed, "package.json"))) {
			errors.push(`${name}: not installed`);
			continue;
		}
		const pkg = JSON.parse(
			readFileSync(join(installed, "package.json"), "utf8"),
		);
		if (pkg.name !== name)
			errors.push(`${name}: installed package has a different name`);
		if (contract.mode === "workspace" && "path" in contract) {
			if (declared[name] !== "workspace:*")
				errors.push(`${name}: declare workspace:*`);
			if (realpathSync(installed) !== realpathSync(join(studio, contract.path)))
				errors.push(`${name}: points outside this integration checkout`);
		} else if (/^(workspace|file|link):/.test(declared[name] ?? "")) {
			errors.push(`${name}: published dependency must use a registry version`);
		}
	}
	for (const file of sources(join(ide, "src"))) {
		for (const specifier of forgeaxImports(file, readFileSync(file, "utf8"))) {
			const name = specifier.split("/").slice(0, 2).join("/");
			if (!declared[name]) {
				errors.push(`${relative(ide, file)}: undeclared ${name}`);
				continue;
			}
			// Interface retains a source bridge until its build/watch lifecycle moves
			// to compiled exports. The Web bundle verifies those source entry points.
			if (name === "@forgeax/interface") continue;
			try {
				Bun.resolveSync(specifier, ide);
			} catch {
				errors.push(
					`${relative(ide, file)}: unavailable public export ${specifier}`,
				);
			}
		}
	}
	return errors;
}

if (import.meta.main) {
	const errors = checkDirectDependencies(resolve(import.meta.dirname, ".."));
	if (errors.length) throw new Error(errors.join("\n"));
	console.log(
		"IDE direct dependencies: declarations, workspace locations and public exports verified.",
	);
}

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const PACKAGED_ENGINE_CONFIG = "vite.config.ts";
const REQUIRED_PACKAGED_ENGINE_ROOT_FILES = [
	"index.html",
	"vite.config.ts",
	"package.json",
	"tsconfig.json",
] as const;

export const DESKTOP_ENGINE_REQUIRED_ROOT_RESOURCE_PATHS =
	REQUIRED_PACKAGED_ENGINE_ROOT_FILES.map((entry) => `engine/${entry}`);

/** Return missing or escaping relative imports from the packaged Engine Vite config. */
export function desktopEngineConfigImportErrors(engineRoot: string): string[] {
	const configPath = join(engineRoot, PACKAGED_ENGINE_CONFIG);
	if (!existsSync(configPath)) return [];

	let imports: ReturnType<Bun.Transpiler["scanImports"]>;
	try {
		imports = new Bun.Transpiler({ loader: "ts" }).scanImports(
			readFileSync(configPath, "utf8"),
		);
	} catch (error) {
		return [
			`${PACKAGED_ENGINE_CONFIG} (${error instanceof Error ? error.message : String(error)})`,
		];
	}

	return imports
		.filter(({ path }) => path.startsWith("."))
		.flatMap(({ path }) => {
			const target = resolve(engineRoot, path);
			const targetRelative = relative(engineRoot, target);
			if (
				isAbsolute(targetRelative) ||
				targetRelative === ".." ||
				targetRelative.startsWith("../") ||
				targetRelative.startsWith("..\\")
			) {
				return [`${PACKAGED_ENGINE_CONFIG} -> ${path} (outside Engine root)`];
			}
			if (!existsSync(target) || !statSync(target).isFile())
				return [`${PACKAGED_ENGINE_CONFIG} -> ${path}`];
			return [];
		});
}

export function assertDesktopEngineConfigImportClosure(
	engineRoot: string,
): void {
	const errors = desktopEngineConfigImportErrors(engineRoot);
	if (errors.length > 0)
		throw new Error(
			`packaged Engine config relative imports are not closed: ${errors.join(", ")}`,
		);
}

/** Materialize the packaged Engine root files into one isolated launch workspace. */
export function materializeDesktopEngineRootFiles(
	source: string,
	destination: string,
): void {
	if (!existsSync(source) || !statSync(source).isDirectory())
		throw new Error(`packaged Engine source is missing: ${source}`);
	for (const entry of REQUIRED_PACKAGED_ENGINE_ROOT_FILES) {
		const path = join(source, entry);
		if (!existsSync(path) || !statSync(path).isFile())
			throw new Error(`packaged Engine resource is missing: engine/${entry}`);
	}
	assertDesktopEngineConfigImportClosure(source);
	mkdirSync(destination, { recursive: true });
	const sourceFiles = readdirSync(source, { withFileTypes: true }).filter(
		(entry) => entry.isFile(),
	);
	const sourceFileNames = new Set(sourceFiles.map((entry) => entry.name));
	for (const entry of readdirSync(destination, { withFileTypes: true })) {
		if (
			(entry.isFile() || entry.isSymbolicLink()) &&
			!sourceFileNames.has(entry.name)
		)
			rmSync(join(destination, entry.name), { force: true });
	}
	for (const entry of sourceFiles) {
		const input = join(source, entry.name);
		const output = join(destination, entry.name);
		rmSync(output, { recursive: true, force: true });
		copyFileSync(input, output);
	}
}

export function desktopStableAgentHostDirectory(
	projectRoot: string,
	portOffset: number,
): string {
	if (!Number.isSafeInteger(portOffset) || portOffset < 0) {
		throw new Error(
			`desktop runtime port offset must be a non-negative integer: ${portOffset}`,
		);
	}
	return join(
		projectRoot,
		".forgeax",
		"runtime",
		`desktop-prod-offset-${portOffset}`,
	);
}

export function desktopStableAgentHostSocket(
	projectRoot: string,
	portOffset: number,
): string {
	return join(
		desktopStableAgentHostDirectory(projectRoot, portOffset),
		"agent-host.sock",
	);
}

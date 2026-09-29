import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Manifest = {
	workspaces?: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
	patchedDependencies?: Record<string, string>;
	[key: string]: unknown;
};

// Studio's developer workspace can consume published packages. IDE CI must
// install the complete source graph selected by its own inputs and lockfiles.
export function completeSourceWorkspace(
	manifest: Manifest,
	rootManifest: Manifest,
	root: string,
	prefix: "" | "../../",
): Manifest {
	const readManifest = (path: string): Manifest =>
		JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
	const ide = readManifest("packages/ide");
	const server = readManifest("packages/server");
	const sourceWorkspaces = [
		"packages/app-shell",
		"packages/server",
		"packages/orchestrator",
		"packages/agent-host",
		"packages/recursive-input-contract",
		...(ide.workspaces ?? []).map((workspace) => {
			if (
				typeof workspace !== "string" ||
				workspace.startsWith("/") ||
				workspace.includes("..") ||
				workspace.includes("\\")
			)
				throw new Error("IDE workspace must stay inside its owning repository");
			return `packages/ide/${workspace}`;
		}),
		...readdirSync(join(root, "packages/editor/packages"), {
			withFileTypes: true,
		})
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!["interface", "platform-io"].includes(entry.name),
			)
			.map((entry) => `packages/editor/packages/${entry.name}`)
			.filter((path) => existsSync(join(root, path, "package.json")))
			.sort(),
	];
	const types = Object.fromEntries(
		["@types/node", "@types/react", "@types/react-dom"]
			.filter((name) => typeof ide.devDependencies?.[name] === "string")
			.map((name) => [name, ide.devDependencies![name]!]),
	);
	const patches = {
		...manifest.patchedDependencies,
		...Object.fromEntries(
			Object.entries(server.patchedDependencies ?? {}).map(([name, path]) => [
				name,
				`${prefix}packages/server/${path}`,
			]),
		),
	};
	return {
		...manifest,
		dependencies: { ...rootManifest.dependencies, ...manifest.dependencies },
		devDependencies: {
			...rootManifest.devDependencies,
			...manifest.devDependencies,
			...types,
		},
		workspaces: [
			...new Set([
				...(manifest.workspaces ?? []),
				...sourceWorkspaces.map((path) => `${prefix}${path}`),
			]),
		],
		overrides: {
			...rootManifest.overrides,
			...manifest.overrides,
			"@forgeax/app-shell": "workspace:*",
		},
		...(Object.keys(patches).length ? { patchedDependencies: patches } : {}),
	};
}

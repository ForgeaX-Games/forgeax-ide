import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

type ProductManifest = {
	extensions?: Array<{ id?: string }>;
};

type PackageJson = {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

type AgentContribution = {
	id?: string;
	card?: { avatarSet?: { rulesFile?: string } };
};

type ExtensionManifest = {
	id?: string;
	version?: string;
	contributes?: { agents?: AgentContribution[] };
	provides?: { agent?: AgentContribution; agents?: AgentContribution[] };
};

export type ProductAgentAvatarResource = {
	packageId: string;
	agentId: string;
	rulesFile: string;
	mediaFiles: string[];
};

export type ProductAgentRoster = {
	packageIds: string[];
	extensionAgentIds: string[];
	agentIds: string[];
	animatedAgentIds: string[];
	avatarResources: ProductAgentAvatarResource[];
};

const exactVersion = /^\d+\.\d+\.\d+$/u;
const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function extensionAgents(manifest: ExtensionManifest): AgentContribution[] {
	return [
		...(manifest.contributes?.agents ?? []),
		...(manifest.provides?.agents ?? []),
		...(manifest.provides?.agent === undefined
			? []
			: [manifest.provides.agent]),
	];
}

function avatarResource(
	packageRoot: string,
	packageId: string,
	agent: AgentContribution,
): ProductAgentAvatarResource | undefined {
	const explicitRules = agent.card?.avatarSet?.rulesFile;
	const rulesPath =
		explicitRules === undefined
			? join(packageRoot, "avatar/AVATAR.md")
			: resolve(packageRoot, explicitRules);
	if (explicitRules === undefined && !existsSync(rulesPath)) return undefined;
	if (!existsSync(rulesPath))
		throw new Error(
			`${packageId}:${agent.id} avatar rules are missing: ${explicitRules}`,
		);
	const rulesFile = relative(packageRoot, rulesPath).replaceAll("\\", "/");
	if (rulesFile.startsWith("../"))
		throw new Error(
			`${packageId}:${agent.id} avatar rules escape the package root`,
		);
	const rules = readFileSync(rulesPath, "utf8");
	const defaultState = /^default:\s*(\S.*)$/mu.exec(rules)?.[1]?.trim();
	const fallbackState = /^fallback:\s*(\S.*)$/mu.exec(rules)?.[1]?.trim();
	const states = new Map(
		[...rules.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+\.webm)\s*\|/gmu)].map(
			(match) => [match[1].trim(), match[2].trim()] as const,
		),
	);
	if (states.size === 0)
		throw new Error(
			`${packageId}:${agent.id} avatar rules declare no WEBM states`,
		);
	for (const [label, state] of [
		["default", defaultState],
		["fallback", fallbackState],
	] as const) {
		if (state === undefined || !states.has(state)) {
			throw new Error(
				`${packageId}:${agent.id} avatar ${label} state is not declared: ${state ?? "<missing>"}`,
			);
		}
	}
	const mediaFiles = [...new Set(states.values())].map((file) => {
		const mediaPath = resolve(dirname(rulesPath), file);
		const mediaFile = relative(packageRoot, mediaPath).replaceAll("\\", "/");
		if (mediaFile.startsWith("../"))
			throw new Error(
				`${packageId}:${agent.id} avatar media escapes the package root`,
			);
		if (!existsSync(mediaPath))
			throw new Error(
				`${packageId}:${agent.id} avatar media is missing: ${mediaFile}`,
			);
		const descriptor = openSync(mediaPath, "r");
		try {
			// The container check needs only the magic bytes and one payload byte.
			const prefix = Buffer.alloc(webmHeader.length + 1);
			const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
			if (
				bytesRead !== prefix.length ||
				!prefix.subarray(0, webmHeader.length).equals(webmHeader)
			) {
				throw new Error(
					`${packageId}:${agent.id} avatar media is not a non-empty WEBM container: ${mediaFile}`,
				);
			}
		} finally {
			closeSync(descriptor);
		}
		return mediaFile;
	});
	return { packageId, agentId: agent.id!, rulesFile, mediaFiles };
}

export function inspectProductAgentRoster(
	productRoot: string,
	brandAgentIds: readonly string[] = ["forge"],
): ProductAgentRoster {
	const product = readJson<ProductManifest>(
		join(productRoot, "product/forgeax-product.json"),
	);
	const productPackage = readJson<PackageJson>(
		join(productRoot, "package.json"),
	);
	if (!Array.isArray(product.extensions))
		throw new Error("product manifest must declare extensions");
	const packageIds: string[] = [];
	const extensionAgentIds: string[] = [];
	const avatarResources: ProductAgentAvatarResource[] = [];
	const owners = new Map<string, string>(
		brandAgentIds.map((id) => [id, "brand"]),
	);
	for (const declaration of product.extensions) {
		const packageId = declaration.id;
		if (typeof packageId !== "string" || packageId.length === 0)
			throw new Error("product extension id is invalid");
		const selectedVersion =
			productPackage.optionalDependencies?.[packageId] ??
			productPackage.dependencies?.[packageId];
		if (selectedVersion === undefined || !exactVersion.test(selectedVersion)) {
			throw new Error(`${packageId} does not have an exact product dependency`);
		}
		const packageRoot = dirname(
			createRequire(join(productRoot, "package.json")).resolve(
				`${packageId}/package.json`,
			),
		);
		const installedPackage = readJson<PackageJson>(
			join(packageRoot, "package.json"),
		);
		const manifest = readJson<ExtensionManifest>(
			join(packageRoot, "forgeax-extension.json"),
		);
		if (installedPackage.name !== packageId || manifest.id !== packageId) {
			throw new Error(
				`${packageId} packaged identity does not match the product selection`,
			);
		}
		if (
			installedPackage.version !== selectedVersion ||
			manifest.version !== selectedVersion
		) {
			throw new Error(
				`${packageId} packaged version does not match ${selectedVersion}`,
			);
		}
		packageIds.push(packageId);
		for (const agent of extensionAgents(manifest)) {
			if (typeof agent.id !== "string" || agent.id.length === 0)
				throw new Error(`${packageId} contributes an invalid agent id`);
			const previousOwner = owners.get(agent.id);
			if (previousOwner !== undefined) {
				throw new Error(
					`duplicate product agent ${agent.id}: ${previousOwner}, ${packageId}`,
				);
			}
			owners.set(agent.id, packageId);
			extensionAgentIds.push(agent.id);
			const resource = avatarResource(packageRoot, packageId, agent);
			if (resource !== undefined) avatarResources.push(resource);
		}
	}
	return {
		packageIds,
		extensionAgentIds,
		agentIds: [...brandAgentIds, ...extensionAgentIds],
		animatedAgentIds: avatarResources.map(({ agentId }) => agentId),
		avatarResources,
	};
}

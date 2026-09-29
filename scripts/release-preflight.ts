import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	readReleaseSourceInputs,
	scanReleaseSources,
} from "./check-release-sources";

type ProductManifest = {
	schemaVersion: number;
	id: string;
	package: string;
	runtime: { platform: string; providerModes: string[] };
	extensions: Array<{ id: string; required: boolean }>;
	services: Array<{
		id: string;
		version: string;
		source: string;
		required: boolean;
	}>;
};

type PackageManifest = {
	name: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

type TauriConfig = {
	app?: { windows?: Array<{ label?: string; visible?: boolean }> };
	bundle?: {
		macOS?: { signingIdentity?: string | null; entitlements?: string | null };
	};
};

type ReleaseContract = {
	schemaVersion: number;
	productId: string;
	sourceRepository: string;
	releaseRepository: string;
	integrationRepository: string;
	tagPrefix: string;
	requiredPlatforms: string[];
	secretNames: Record<string, string[]>;
	optionalNotificationSecret: string;
};

const exactVersion = /^\d+\.\d+\.\d+$/;

export function validateReleaseOwnerContract(
	contract: ReleaseContract,
): string[] {
	const errors: string[] = [];
	if (contract.schemaVersion !== 1) errors.push("release-contract-schema");
	if (contract.productId !== "forgeax-ide")
		errors.push("release-contract-product");
	if (contract.sourceRepository !== "ForgeaX-Games/forgeax-ide")
		errors.push("release-source-owner");
	if (contract.releaseRepository !== "ForgeaX-Games/forgeax-studio")
		errors.push("release-target-owner");
	if (contract.integrationRepository !== "ForgeaX-Games/forgeax-studio")
		errors.push("integration-target-owner");
	if (contract.tagPrefix !== "v") errors.push("release-tag-prefix");
	if (
		JSON.stringify([...contract.requiredPlatforms].sort()) !==
		JSON.stringify(["macos-arm64", "macos-x64", "windows-x64"])
	)
		errors.push("release-platform-roster");
	const authoritativeSecrets = Object.values(contract.secretNames).flat();
	if (
		JSON.stringify(contract.secretNames) !==
		JSON.stringify({ integration: ["INTERNAL_TOKEN"] })
	)
		errors.push("integration-secret-contract");
	if (authoritativeSecrets.includes(contract.optionalNotificationSecret))
		errors.push("notification-secret-authoritative");
	if (new Set(authoritativeSecrets).size !== authoritativeSecrets.length)
		errors.push("duplicate-secret-contract");
	return errors;
}

type TransportContract = {
	schema: string;
	sourceRepository: string;
	releaseRepository: string;
	integrationRepository: string;
	publisherWorkflowPath: string;
	candidateDigest: { algorithm: string; canonicalization: string };
	nativeTrustPolicy: string;
	artifacts: { candidate: string; assets: string };
	platforms: Array<{
		logicalId: string;
		targetTriple: string;
		installerRoster: unknown[];
	}>;
};

export function validateTransportContract(
	transport: TransportContract,
): string[] {
	const errors: string[] = [];
	if (transport.schema !== "forgeax-ide-release-transport/v1")
		errors.push("transport-schema");
	if (
		transport.sourceRepository !== "ForgeaX-Games/forgeax-ide" ||
		transport.releaseRepository !== "ForgeaX-Games/forgeax-studio" ||
		transport.integrationRepository !== "ForgeaX-Games/forgeax-studio"
	)
		errors.push("transport-owner");
	if (transport.publisherWorkflowPath !== ".github/workflows/release.yml")
		errors.push("publisher-workflow");
	if (
		transport.candidateDigest.algorithm !== "SHA-256" ||
		transport.candidateDigest.canonicalization !== "RFC8785"
	)
		errors.push("candidate-digest-contract");
	if (transport.nativeTrustPolicy !== "unsigned-user-authorized")
		errors.push("native-trust-policy");
	if (
		transport.artifacts.candidate !==
			"ide-release-candidate-{orchestrationId}" ||
		transport.artifacts.assets !== "ide-release-assets-{orchestrationId}"
	)
		errors.push("transport-artifact-name");
	const ids = transport.platforms.map((platform) => platform.logicalId);
	if (
		JSON.stringify([...ids].sort()) !==
			JSON.stringify(["macos-arm64", "macos-x64", "windows-x64"]) ||
		new Set(ids).size !== ids.length ||
		transport.platforms.some(
			(platform) =>
				!platform.targetTriple || platform.installerRoster.length === 0,
		)
	)
		errors.push("transport-platform-roster");
	return errors;
}

export function validateNativeBundleConfig(config: TauriConfig): string[] {
	const errors: string[] = [];
	const mainWindow = config.app?.windows?.find(
		(window) => window.label === "main",
	);
	if (mainWindow?.visible !== true)
		errors.push("desktop-startup-window-hidden");
	if (config.bundle?.macOS?.signingIdentity !== "-")
		errors.push("macos-adhoc-signing-identity");
	if (config.bundle?.macOS?.entitlements !== "Entitlements.plist")
		errors.push("macos-entitlements-file");
	return errors;
}

export function validateProductRelease(
	product: ProductManifest,
	packageJson: PackageManifest,
): string[] {
	const errors: string[] = [];
	if (product.schemaVersion !== 2) errors.push("product-schema-version");
	if (product.id !== "forgeax-ide") errors.push("product-id");
	if (product.package !== packageJson.name) errors.push("product-package");
	const platformMatch = /^(@forgeax\/extension-platform)@(\d+\.\d+\.\d+)$/.exec(
		product.runtime.platform,
	);
	if (platformMatch === null) errors.push("platform-version");
	else if (packageJson.dependencies?.[platformMatch[1]] !== platformMatch[2])
		errors.push("platform-dependency-mismatch");
	if (
		!["web-dev", "desktop-dev", "desktop-prod"].every((mode) =>
			product.runtime.providerModes.includes(mode),
		)
	)
		errors.push("provider-modes");

	const seen = new Set<string>();
	for (const extension of product.extensions) {
		if (
			typeof extension?.id !== "string" ||
			typeof extension.required !== "boolean"
		) {
			errors.push("extension-declaration-invalid");
			continue;
		}
		const extensionId = extension.id;
		if (seen.has(extensionId))
			errors.push(`duplicate-extension:${extensionId}`);
		seen.add(extensionId);
		if (!extensionId.startsWith("@forgeax-extension/"))
			errors.push(`extension-package-invalid:${extensionId}`);
		const selectedDependencies = extension.required
			? packageJson.dependencies
			: packageJson.optionalDependencies;
		const otherDependencies = extension.required
			? packageJson.optionalDependencies
			: packageJson.dependencies;
		const version = selectedDependencies?.[extensionId];
		if (version === undefined)
			errors.push(`extension-dependency-missing:${extensionId}`);
		else if (!exactVersion.test(version))
			errors.push(`extension-version-not-exact:${extensionId}`);
		if (otherDependencies?.[extensionId] !== undefined) {
			errors.push(`extension-dependency-class-mismatch:${extensionId}`);
		}
	}

	const seenServices = new Set<string>();
	for (const service of product.services) {
		if (seenServices.has(service.id))
			errors.push(`duplicate-service:${service.id}`);
		seenServices.add(service.id);
		if (!exactVersion.test(service.version))
			errors.push(`service-version-not-exact:${service.id}`);
		if (service.source !== "released-service")
			errors.push(`service-source-invalid:${service.id}`);
	}
	if (
		!product.services.some(
			(service) => service.id === "forgeax-server" && service.required,
		)
	)
		errors.push("required-service-missing:forgeax-server");
	return errors;
}

if (import.meta.main) {
	const root = join(import.meta.dirname, "..");
	const product = JSON.parse(
		readFileSync(join(root, "product/forgeax-product.json"), "utf8"),
	) as ProductManifest;
	const packageJson = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as PackageManifest;
	const tauriConfig = JSON.parse(
		readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
	) as TauriConfig;
	const contract = JSON.parse(
		readFileSync(join(root, "release/contract.json"), "utf8"),
	) as ReleaseContract;
	const transport = JSON.parse(
		readFileSync(join(root, "release/transport-contract.v1.json"), "utf8"),
	) as TransportContract;
	const errors = [
		...validateProductRelease(product, packageJson),
		...validateReleaseOwnerContract(contract),
		...validateTransportContract(transport),
		...validateNativeBundleConfig(tauriConfig),
	];
	const sourceScan = scanReleaseSources(readReleaseSourceInputs(root));
	for (const violation of sourceScan.violations)
		errors.push(`forbidden-source:${violation.field}:${violation.token}`);
	if (errors.length > 0) {
		console.error(
			JSON.stringify({ code: "IDE_RELEASE_PREFLIGHT_FAILED", errors }),
		);
		process.exit(1);
	}
	console.log(
		JSON.stringify({
			code: "IDE_RELEASE_PREFLIGHT_OK",
			extensions: product.extensions,
			services: product.services,
		}),
	);
}

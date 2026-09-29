import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import transport from "../release/transport-contract.v1.json";
import { assertTargetExecutable } from "./executable-identity";
import { validateTrustedReleaseUrl } from "./release-source-contract";
import type { ReleaseContext } from "./resolve-release-context";

export { validateTrustedReleaseUrl } from "./release-source-contract";

export const platformTargets = Object.fromEntries(
	transport.platforms.map((platform) => [
		platform.logicalId,
		{
			triple: platform.targetTriple,
			extension: platform.logicalId === "windows-x64" ? ".exe" : "",
		},
	]),
) as Record<
	"macos-arm64" | "macos-x64" | "windows-x64",
	{ triple: string; extension: string }
>;
export type ReleasePlatform = keyof typeof platformTargets;

type SidecarArtifact = {
	platform: ReleasePlatform;
	targetTriple: string;
	url: string;
	sha256: string;
	size: number;
};
export type SidecarManifest = {
	schema: "forgeax-server-release-candidate/v1";
	service: "forgeax-server";
	version: string;
	artifacts: SidecarArtifact[];
};

const exactKeys = (value: object, keys: string[]): boolean =>
	JSON.stringify(Object.keys(value).sort()) ===
	JSON.stringify([...keys].sort());

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function validateSidecar(
	manifest: SidecarManifest,
	platform: ReleasePlatform,
	bytes: Uint8Array,
	expectedVersion: string,
): SidecarArtifact {
	if (
		!manifest ||
		!exactKeys(manifest, ["schema", "service", "version", "artifacts"]) ||
		manifest.schema !== "forgeax-server-release-candidate/v1" ||
		manifest.service !== "forgeax-server"
	)
		throw new Error("invalid sidecar candidate schema");
	if (
		manifest.version !== expectedVersion ||
		!/^\d+\.\d+\.\d+$/.test(manifest.version)
	)
		throw new Error("sidecar service version mismatch");
	if (
		!Array.isArray(manifest.artifacts) ||
		manifest.artifacts.length !== transport.platforms.length
	)
		throw new Error("sidecar platform roster mismatch");
	const seen = new Set<string>();
	for (const item of manifest.artifacts) {
		if (
			!item ||
			!exactKeys(item, ["platform", "targetTriple", "url", "sha256", "size"]) ||
			seen.has(item.platform)
		)
			throw new Error("sidecar artifact shape or uniqueness is invalid");
		seen.add(item.platform);
		const expected = transport.platforms.find(
			(entry) => entry.logicalId === item.platform,
		);
		if (
			!expected ||
			expected.targetTriple !== item.targetTriple ||
			!/^[0-9a-f]{64}$/.test(item.sha256) ||
			!Number.isSafeInteger(item.size)
		)
			throw new Error(`invalid sidecar artifact for ${item.platform}`);
		validateTrustedReleaseUrl(item.url, "binary", manifest.version);
	}
	const artifact = manifest.artifacts.find(
		(item) => item.platform === platform,
	);
	if (!artifact) throw new Error(`missing sidecar artifact for ${platform}`);
	if (
		bytes.byteLength !== artifact.size ||
		artifact.size < 1_048_576 ||
		artifact.size > transport.trustedSidecarSource.binaryMaxBytes
	)
		throw new Error(`sidecar size mismatch for ${platform}`);
	if (sha256(bytes) !== artifact.sha256)
		throw new Error(`sidecar digest mismatch for ${platform}`);
	assertTargetExecutable(bytes, platform);
	if (
		new TextDecoder()
			.decode(bytes.slice(0, 512))
			.includes("IDE_SIDECAR_PLACEHOLDER")
	)
		throw new Error("placeholder sidecar is forbidden");
	return artifact;
}

export async function fetchBounded(
	url: string,
	expectedSha256: string,
	maxBytes: number,
	fetcher: typeof fetch = fetch,
	token?: string,
): Promise<Uint8Array> {
	if (!/^[0-9a-f]{64}$/.test(expectedSha256))
		throw new Error("SHA-256 is required");
	let response = await fetcher(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(transport.trustedSidecarSource.timeoutMs),
		headers: token ? { Authorization: `Bearer ${token}` } : undefined,
	});
	if (response.status === 404 && token) {
		const path = new URL(url).pathname.slice(
			transport.trustedSidecarSource.repositoryPath.length,
		);
		const [tag, name] = path.split("/");
		const release = await fetcher(
			`https://api.github.com/repos/ForgeaX-Games/forgeax-server/releases/tags/${encodeURIComponent(tag)}`,
			{
				redirect: "error",
				signal: AbortSignal.timeout(transport.trustedSidecarSource.timeoutMs),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!release.ok)
			throw new Error(
				`private release metadata failed with HTTP ${release.status}`,
			);
		const metadata = (await release.json()) as {
			assets?: Array<{
				name?: string;
				url?: string;
				browser_download_url?: string;
			}>;
		};
		const asset = metadata.assets?.find(
			(item) => item.name === name && item.browser_download_url === url,
		);
		if (!asset?.url) throw new Error("private release asset is missing");
		response = await fetcher(asset.url, {
			redirect: "follow",
			signal: AbortSignal.timeout(transport.trustedSidecarSource.timeoutMs),
			headers: {
				Accept: "application/octet-stream",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	}
	const finalOrigin = new URL(response.url || url).origin;
	if (
		!response.ok ||
		!transport.trustedSidecarSource.downloadOrigins.includes(finalOrigin)
	) {
		throw new Error(
			`release download failed or redirected to an untrusted origin (HTTP ${response.status})`,
		);
	}
	const declared = response.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
		throw new Error("release download exceeds byte limit");
	if (!response.body) throw new Error("release download body is missing");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > maxBytes) {
			await reader.cancel();
			throw new Error("release download exceeds byte limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (sha256(bytes) !== expectedSha256)
		throw new Error("release download digest mismatch");
	return bytes;
}

if (import.meta.main) {
	const value = (name: string): string | undefined => {
		const index = Bun.argv.indexOf(name);
		return index >= 0 ? Bun.argv[index + 1] : undefined;
	};
	const platform = value("--platform") as ReleasePlatform | undefined;
	const contextPath = value("--context");
	const context = contextPath
		? (JSON.parse(await Bun.file(contextPath).text()) as ReleaseContext)
		: undefined;
	const manifestUrlValue =
		context?.sidecarManifestUrl ?? value("--manifest-url");
	const manifestSha256 =
		context?.sidecarManifestSha256 ?? value("--manifest-sha256");
	const serviceVersion = context?.serviceVersion ?? value("--service-version");
	const outputRoot = value("--output");
	if (
		!platform ||
		!(platform in platformTargets) ||
		!manifestUrlValue ||
		!manifestSha256 ||
		!serviceVersion ||
		!outputRoot
	)
		throw new Error(
			"complete sidecar staging arguments and --output are required",
		);
	const token = process.env.INTERNAL_TOKEN;
	if (!token)
		throw new Error(
			"INTERNAL_TOKEN is required to download the private server Release candidate",
		);
	const manifestUrl = validateTrustedReleaseUrl(
		manifestUrlValue,
		"manifest",
		serviceVersion,
	);
	const manifestBytes = await fetchBounded(
		manifestUrl,
		manifestSha256,
		transport.trustedSidecarSource.manifestMaxBytes,
		fetch,
		token,
	);
	const manifest = JSON.parse(
		new TextDecoder().decode(manifestBytes),
	) as SidecarManifest;
	const artifact = manifest.artifacts?.find(
		(item) => item.platform === platform,
	);
	if (!artifact)
		throw new Error(`sidecar candidate has no ${platform} artifact`);
	const binary = await fetchBounded(
		validateTrustedReleaseUrl(artifact.url, "binary", serviceVersion),
		artifact.sha256,
		transport.trustedSidecarSource.binaryMaxBytes,
		fetch,
		token,
	);
	validateSidecar(manifest, platform, binary, serviceVersion);
	const target = platformTargets[platform];
	const resources = join(resolve(outputRoot), "sidecars");
	mkdirSync(resources, { recursive: true });
	const output = join(
		resources,
		`forgeax-server-${target.triple}${target.extension}`,
	);
	writeFileSync(output, binary);
	if (target.extension === "") chmodSync(output, 0o755);
	console.log(
		JSON.stringify({
			code: "IDE_RELEASE_SIDECAR_STAGED",
			platform,
			file: basename(output),
			sha256: artifact.sha256,
			size: binary.byteLength,
		}),
	);
}

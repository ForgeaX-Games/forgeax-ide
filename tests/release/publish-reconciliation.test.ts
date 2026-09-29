import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import transport from "../../release/transport-contract.v1.json";
import {
	type ReleaseApi,
	reconcileDraftRelease,
	UNSIGNED_RELEASE_NOTICE,
} from "../../scripts/publish-release";
import {
	aggregateCandidate,
	hashFile,
	type PlatformRecord,
} from "../../scripts/release-candidate";
import type { ReleaseContext } from "../../scripts/resolve-release-context";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "publish-reconcile-"));
	process.env.GITHUB_RUN_ID = "55";
	process.env.GITHUB_RUN_ATTEMPT = "1";
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture(mode: "dry-run" | "publish", version = "1.2.3") {
	const assets = join(root, "assets");
	const evidence = join(root, "evidence");
	mkdirSync(assets);
	mkdirSync(evidence);
	const records: PlatformRecord[] = transport.platforms.map((platform) => {
		const artifacts = platform.installerRoster.map((item) => {
			const fileName = `${item.logicalId}.bin`;
			const path = join(assets, fileName);
			writeFileSync(path, item.logicalId);
			const record = hashFile(path, item.logicalId, item.mediaType);
			return {
				logicalId: record.logicalId,
				fileName,
				mediaType: record.mediaType,
				sha256: record.sha256,
				size: record.size,
			};
		});
		const fileName = `${platform.logicalId}.json`;
		const path = join(evidence, fileName);
		writeFileSync(path, "{}");
		const record = hashFile(
			path,
			`${platform.logicalId}-evidence`,
			"application/json",
		);
		return {
			logicalId: platform.logicalId,
			targetTriple: platform.targetTriple,
			trust: (mode === "publish"
				? transport.nativeTrustPolicy
				: "suppressed-not-applicable") as PlatformRecord["trust"],
			artifacts,
			evidence: [
				{
					logicalId: record.logicalId,
					fileName,
					mediaType: record.mediaType,
					sha256: record.sha256,
					size: record.size,
				},
			],
		};
	});
	const context: ReleaseContext = {
		orchestrationId: "studio-run",
		version,
		ideRevision: "a".repeat(40),
		integrationRevision: "b".repeat(40),
		revisionBranch: "main",
		sidecarManifestUrl:
			"https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json",
		sidecarManifestSha256: "c".repeat(64),
		mode,
		targetTag: `v${version}`,
		serviceVersion: "0.1.0",
		candidateArtifactName: "ide-release-candidate-studio-run",
		assetsArtifactName: "ide-release-assets-studio-run",
		workflowDefinitionRevision: "d".repeat(40),
	};
	const candidate = aggregateCandidate(context, records);
	const candidatePath = join(root, "candidate.json");
	const recoveryPath = join(root, "recovery.jsonl");
	writeFileSync(candidatePath, JSON.stringify(candidate));
	writeFileSync(
		recoveryPath,
		`${JSON.stringify({ schema: "forgeax-ide-release-recovery/v1", orchestrationId: candidate.orchestrationId, candidateDigest: candidate.digest, mode, state: "candidate-verified", mutation: "suppressed", verified: true, releaseId: null, releaseUrl: null })}\n`,
	);
	return {
		candidate,
		candidatePath,
		recoveryPath,
		assetsRoot: assets,
		evidenceRoot: evidence,
	};
}

describe("recoverable draft Release reconciliation", () => {
	test("publishes the supported unsigned macOS opening notice", () => {
		expect(UNSIGNED_RELEASE_NOTICE).toContain("Unsigned");
		expect(UNSIGNED_RELEASE_NOTICE).toContain(
			"System Settings → Privacy & Security",
		);
		expect(UNSIGNED_RELEASE_NOTICE).toContain("Open Anyway");
		expect(UNSIGNED_RELEASE_NOTICE).toContain("ForgeaX Studio.app");
	});

	test("rejects dry-run candidates before any GitHub API mutation", async () => {
		let calls = 0;
		const api: ReleaseApi = {
			request: async <T>() => {
				calls++;
				return [] as T;
			},
		};
		await expect(
			reconcileDraftRelease({ ...fixture("dry-run"), api }),
		).rejects.toThrow("candidate mode must be publish");
		expect(calls).toBe(0);
	});

	test("rejects an existing draft whose target commit differs before asset upload", async () => {
		const release = {
			id: 1,
			tag_name: "v1.2.3",
			target_commitish: "f".repeat(40),
			draft: true,
			prerelease: false,
			html_url:
				"https://github.com/ForgeaX-Games/forgeax-studio/releases/tag/v1.2.3",
			upload_url: "https://uploads.github.com/x{?name,label}",
			assets: [],
		};
		let calls = 0;
		const api: ReleaseApi = {
			request: async <T>() => {
				calls++;
				return [release] as T;
			},
		};
		await expect(
			reconcileDraftRelease({ ...fixture("publish"), api }),
		).rejects.toThrow("target commit mismatch");
		expect(calls).toBe(1);
	});

	for (const [version, expected] of [
		["1.2.3", false],
		["1.2.4-alpha.1", true],
	] as const) {
		test(`creates ${expected ? "prerelease" : "stable"} metadata for ${version}`, async () => {
			let payload: Record<string, unknown> | undefined;
			const api: ReleaseApi = {
				request: async <T>(_url: string, init?: RequestInit): Promise<T> => {
					if (init?.method !== "POST") return [] as T;
					payload = JSON.parse(String(init.body)) as Record<string, unknown>;
					throw new Error("stop after release creation");
				},
			};
			await expect(
				reconcileDraftRelease({ ...fixture("publish", version), api }),
			).rejects.toThrow("stop after release creation");
			expect(payload?.prerelease).toBe(expected);
		});
	}
});

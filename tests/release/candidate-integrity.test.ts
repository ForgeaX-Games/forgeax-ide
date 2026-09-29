import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import transport from "../../release/transport-contract.v1.json";
import {
	type AggregateCandidate,
	aggregateCandidate,
	buildPlatformEvidence,
	computeCandidateDigest,
	hashFile,
	type PlatformRecord,
	validateCandidate,
	validatePlatformEvidence,
	verifyTransportFiles,
} from "../../scripts/release-candidate";
import type { ReleaseContext } from "../../scripts/resolve-release-context";

let root = "";
const context: ReleaseContext = {
	orchestrationId: "studio-20260901",
	version: "1.2.3",
	ideRevision: "a".repeat(40),
	integrationRevision: "b".repeat(40),
	revisionBranch: "main",
	sidecarManifestUrl:
		"https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json",
	sidecarManifestSha256: "c".repeat(64),
	mode: "dry-run",
	targetTag: "v1.2.3",
	serviceVersion: "0.1.0",
	candidateArtifactName: "ide-release-candidate-studio-20260901",
	assetsArtifactName: "ide-release-assets-studio-20260901",
	workflowDefinitionRevision: "d".repeat(40),
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "candidate-"));
	process.env.GITHUB_RUN_ID = "1234";
	process.env.GITHUB_RUN_ATTEMPT = "2";
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function records(): PlatformRecord[] {
	const assets = join(root, "assets");
	const evidence = join(root, "evidence");
	mkdirSync(assets);
	mkdirSync(evidence);
	return transport.platforms.map((platform) => {
		const artifactRecords = platform.installerRoster.map((item) => {
			const fileName = `${item.logicalId}.bin`;
			const path = join(assets, fileName);
			writeFileSync(path, `${item.logicalId}-bytes`);
			const file = hashFile(path, item.logicalId, item.mediaType);
			return {
				logicalId: file.logicalId,
				fileName,
				mediaType: file.mediaType,
				sha256: file.sha256,
				size: file.size,
			};
		});
		const evidenceName = `${platform.logicalId}.json`;
		const evidencePath = join(evidence, evidenceName);
		writeFileSync(
			evidencePath,
			JSON.stringify({ platform: platform.logicalId }),
		);
		const file = hashFile(
			evidencePath,
			`${platform.logicalId}-evidence`,
			"application/json",
		);
		return {
			logicalId: platform.logicalId,
			targetTriple: platform.targetTriple,
			trust: "suppressed-not-applicable" as const,
			artifacts: artifactRecords,
			evidence: [
				{
					logicalId: file.logicalId,
					fileName: evidenceName,
					mediaType: file.mediaType,
					sha256: file.sha256,
					size: file.size,
				},
			],
		};
	});
}

describe("candidate-bound release integrity", () => {
	test("binds mode, sources, target, sidecar, publisher, exact platform records, and canonical digest", () => {
		const candidate = aggregateCandidate(context, records());
		expect(() => validateCandidate(candidate, "dry-run")).not.toThrow();
		expect(candidate.digest).toBe(
			computeCandidateDigest(
				(({ digest: _, ...material }) => material)(candidate),
			),
		);
		expect(candidate.target).toEqual({
			repository: "ForgeaX-Games/forgeax-studio",
			tag: "v1.2.3",
			commit: "b".repeat(40),
		});
		expect(candidate.publisher).toMatchObject({
			workflowPath: ".github/workflows/release.yml",
			workflowRunId: "1234",
			workflowRunAttempt: "2",
			workflowDefinitionRevision: "d".repeat(40),
		});
		expect(candidate.sidecarManifest.sha256).toBe("c".repeat(64));
	});

	test("rejects mode drift, target drift, sidecar drift, publisher drift, and unknown fields", () => {
		const original = aggregateCandidate(context, records());
		for (const mutate of [
			(value: any) => {
				value.mode = "publish";
			},
			(value: any) => {
				value.target.commit = "e".repeat(40);
			},
			(value: any) => {
				value.sidecarManifest.sha256 = "f".repeat(64);
			},
			(value: any) => {
				value.publisher.workflowRunId = "0";
			},
			(value: any) => {
				value.ambientTrust = true;
			},
		]) {
			const changed = structuredClone(original) as AggregateCandidate & {
				ambientTrust?: boolean;
			};
			mutate(changed);
			expect(() => validateCandidate(changed)).toThrow();
		}
	});

	test("rejects undeclared extra installer bytes and digest changes", () => {
		const candidate = aggregateCandidate(context, records());
		const assets = join(root, "assets");
		const evidence = join(root, "evidence");
		expect(() =>
			verifyTransportFiles(candidate, assets, evidence),
		).not.toThrow();
		writeFileSync(join(assets, "undeclared.exe"), "extra");
		expect(() => verifyTransportFiles(candidate, assets, evidence)).toThrow(
			"undeclared",
		);
		rmSync(join(assets, "undeclared.exe"));
		writeFileSync(
			join(assets, candidate.platforms[0].artifacts[0].fileName),
			"changed",
		);
		expect(() => verifyTransportFiles(candidate, assets, evidence)).toThrow(
			"digest mismatch",
		);
	});

	test("creates structured hash-bindable dry-run evidence and rejects extra installers", () => {
		const bundle = join(root, "bundle");
		const app = join(bundle, "ForgeaX.app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(bundle, "ForgeaX Studio.dmg"), "installer");
		const evidenceOutput = join(root, "structured", "macos-arm64.json");
		const result = buildPlatformEvidence({
			context,
			logicalId: "macos-arm64",
			bundleRoot: bundle,
			assetsOutput: join(root, "transport-assets"),
			evidenceOutput,
		});
		expect(() =>
			validatePlatformEvidence(result.evidence, context),
		).not.toThrow();
		expect(result.evidence).toMatchObject({
			trust: "suppressed-not-applicable",
			signer: null,
		});
		expect(result.evidence.artifacts[0]?.fileName).toBe(
			"macos-arm64-dmg-ForgeaX.Studio.dmg",
		);
		expect(
			result.evidence.checks.every(
				(check) => check.status === "suppressed-not-applicable",
			),
		).toBe(true);
		const invalidName = structuredClone(result.evidence);
		invalidName.artifacts[0]!.fileName = "macos-arm64-dmg-ForgeaX Studio.dmg";
		expect(() => validatePlatformEvidence(invalidName, context)).toThrow(
			"file record shape is invalid",
		);
		writeFileSync(join(bundle, "undeclared.exe"), "extra");
		expect(() =>
			buildPlatformEvidence({
				context,
				logicalId: "macos-arm64",
				bundleRoot: bundle,
				assetsOutput: join(root, "other-assets"),
				evidenceOutput: join(root, "other-evidence.json"),
			}),
		).toThrow("undeclared");
	});

	test("creates explicit unsigned publish evidence without claiming a signer", () => {
		const publishContext = { ...context, mode: "publish" as const };
		const bundle = join(root, "publish-bundle");
		mkdirSync(join(bundle, "ForgeaX.app"), { recursive: true });
		writeFileSync(join(bundle, "ForgeaX.dmg"), "unsigned-installer");
		const result = buildPlatformEvidence({
			context: publishContext,
			logicalId: "macos-arm64",
			bundleRoot: bundle,
			assetsOutput: join(root, "publish-assets"),
			evidenceOutput: join(root, "publish-evidence.json"),
		});
		expect(() =>
			validatePlatformEvidence(result.evidence, publishContext),
		).not.toThrow();
		expect(result.evidence).toMatchObject({
			trust: "unsigned-user-authorized",
			signer: null,
		});
		expect(
			result.evidence.checks.every(
				(check) => check.status === "unsigned-user-authorized",
			),
		).toBe(true);
	});

	test("accepts the exact Windows NSIS-only installer roster", () => {
		const bundle = join(root, "windows-bundle");
		mkdirSync(join(bundle, "nsis"), { recursive: true });
		writeFileSync(
			join(bundle, "nsis", "ForgeaX Studio_1.2.3_x64-setup.exe"),
			"nsis-installer",
		);
		const result = buildPlatformEvidence({
			context,
			logicalId: "windows-x64",
			bundleRoot: bundle,
			assetsOutput: join(root, "windows-assets"),
			evidenceOutput: join(root, "windows-evidence.json"),
		});

		expect(() =>
			validatePlatformEvidence(result.evidence, context),
		).not.toThrow();
		expect(result.evidence.artifacts).toHaveLength(1);
		expect(result.evidence.artifacts[0]).toMatchObject({
			logicalId: "windows-x64-nsis",
			mediaType: "application/vnd.microsoft.portable-executable",
		});
	});

	test("publish verification rejects a dry-run candidate", () => {
		expect(() =>
			validateCandidate(aggregateCandidate(context, records()), "publish"),
		).toThrow("candidate mode must be publish");
	});
});

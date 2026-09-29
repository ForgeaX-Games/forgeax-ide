import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import transport from "../release/transport-contract.v1.json";
import {
	type AggregateCandidate,
	hashFile,
	type RecoveryRecord,
	readRecovery,
	validateCandidate,
	verifyTransportFiles,
} from "./release-candidate";

type ReleaseAsset = {
	id: number;
	name: string;
	digest?: string | null;
	size: number;
};
type Release = {
	id: number;
	tag_name: string;
	target_commitish: string;
	name: string | null;
	draft: boolean;
	prerelease: boolean;
	html_url: string;
	upload_url: string;
	body: string | null;
	assets: ReleaseAsset[];
};

export const UNSIGNED_RELEASE_NOTICE = `## Unsigned installer notice

These macOS and Windows installers are intentionally published without native code signing or Apple notarization. Their bytes are SHA-256-bound by the attached candidate and recovery records.

On macOS, first drag **ForgeaX Studio.app** to Applications, then Control-click it in Finder and choose **Open**. If macOS still blocks it, open **System Settings → Privacy & Security**, find the blocked ForgeaX Studio notice, choose **Open Anyway**, and confirm.`;

function withUnsignedReleaseNotice(body: string | null | undefined): string {
	if (body?.includes("## Unsigned installer notice")) return body;
	return `${UNSIGNED_RELEASE_NOTICE}${body?.trim() ? `\n\n${body.trim()}` : ""}`;
}

function requireUnsignedReleaseNotice(release: Release): void {
	if (!release.body?.includes("## Unsigned installer notice"))
		throw new Error("GitHub Release does not disclose unsigned installers");
}

function legacyArm64AssetNames(candidate: AggregateCandidate): Set<string> {
	const version = candidate.target.tag.replace(/^v/, "");
	const dmg = `ForgeaX.Studio_${version}_aarch64.dmg`;
	return new Set([dmg, `${dmg}.sha256`, "provenance.json"]);
}

function hasLegacyArm64Metadata(
	release: Release,
	candidate: AggregateCandidate,
): boolean {
	return (
		release.name === `ForgeaX Studio ${candidate.target.tag} (macOS arm64)` &&
		release.body?.includes("## macOS arm64 early prerelease") === true
	);
}

type ExpectedAsset = {
	path: string;
	name: string;
	sha256: string;
	size: number;
	mediaType: string;
};

export interface ReleaseApi {
	request<T>(url: string, init?: RequestInit): Promise<T>;
}

export class GitHubApi implements ReleaseApi {
	constructor(
		private readonly token: string,
		private readonly fetcher: typeof fetch = fetch,
	) {}
	async request<T>(url: string, init: RequestInit = {}): Promise<T> {
		const response = await this.fetcher(
			url.startsWith("https://") ? url : `https://api.github.com${url}`,
			{
				...init,
				signal: AbortSignal.timeout(120_000),
				redirect: "error",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					...init.headers,
				},
			},
		);
		if (!response.ok)
			throw new Error(
				`GitHub API ${init.method ?? "GET"} ${url} failed with HTTP ${response.status}`,
			);
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}
}

function expectedAssets(
	candidate: AggregateCandidate,
	candidatePath: string,
	recoveryPath: string,
	assetsRoot: string,
	evidenceRoot: string,
): ExpectedAsset[] {
	const files: ExpectedAsset[] = [];
	for (const platform of candidate.platforms) {
		for (const record of platform.artifacts)
			files.push({
				path: join(assetsRoot, record.fileName),
				name: record.fileName,
				sha256: record.sha256,
				size: record.size,
				mediaType: record.mediaType,
			});
		for (const record of platform.evidence)
			files.push({
				path: join(evidenceRoot, record.fileName),
				name: record.fileName,
				sha256: record.sha256,
				size: record.size,
				mediaType: record.mediaType,
			});
	}
	for (const [path, name] of [
		[candidatePath, "candidate.json"],
		[recoveryPath, "recovery.jsonl"],
	] as const) {
		const record = hashFile(
			path,
			name.replace(/\..+$/, ""),
			name.endsWith(".json") ? "application/json" : "application/x-ndjson",
		);
		files.push({
			path,
			name,
			sha256: record.sha256,
			size: record.size,
			mediaType: record.mediaType,
		});
	}
	if (new Set(files.map((file) => file.name)).size !== files.length)
		throw new Error("release asset names are not unique");
	return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveTagCommit(api: ReleaseApi, tag: string): Promise<string> {
	const ref = await api.request<{ object: { type: string; sha: string } }>(
		`/repos/${transport.releaseRepository}/git/ref/tags/${encodeURIComponent(tag)}`,
	);
	if (ref.object.type === "commit") return ref.object.sha;
	if (ref.object.type !== "tag")
		throw new Error("release tag does not resolve to a commit");
	const annotated = await api.request<{
		object: { type: string; sha: string };
	}>(`/repos/${transport.releaseRepository}/git/tags/${ref.object.sha}`);
	if (annotated.object.type !== "commit")
		throw new Error("nested/non-commit release tag is forbidden");
	return annotated.object.sha;
}

export async function reconcileDraftRelease(input: {
	candidate: AggregateCandidate;
	candidatePath: string;
	recoveryPath: string;
	assetsRoot: string;
	evidenceRoot: string;
	api: ReleaseApi;
}): Promise<{ release: Release; records: RecoveryRecord[] }> {
	validateCandidate(input.candidate, "publish");
	readRecovery(input.recoveryPath, input.candidate);
	verifyTransportFiles(input.candidate, input.assetsRoot, input.evidenceRoot);
	const expected = expectedAssets(
		input.candidate,
		input.candidatePath,
		input.recoveryPath,
		input.assetsRoot,
		input.evidenceRoot,
	);
	const prerelease = input.candidate.target.tag.includes("-");
	const releases = await input.api.request<Release[]>(
		`/repos/${transport.releaseRepository}/releases?per_page=100`,
	);
	let release = releases.find(
		(item) => item.tag_name === input.candidate.target.tag,
	);
	if (!release) {
		release = await input.api.request<Release>(
			`/repos/${transport.releaseRepository}/releases`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tag_name: input.candidate.target.tag,
					target_commitish: input.candidate.target.commit,
					name: `ForgeaX Studio ${input.candidate.target.tag}`,
					body: UNSIGNED_RELEASE_NOTICE,
					draft: true,
					prerelease,
					generate_release_notes: true,
				}),
			},
		);
	}
	if (release.target_commitish !== input.candidate.target.commit)
		throw new Error("release target commit mismatch");
	if (!release.draft) {
		const tagCommit = await resolveTagCommit(
			input.api,
			input.candidate.target.tag,
		);
		if (tagCommit !== input.candidate.target.commit)
			throw new Error("release tag commit mismatch");
	}
	const expectedNames = new Set(expected.map((asset) => asset.name));
	const undeclared = release.assets.filter(
		(asset) => !expectedNames.has(asset.name),
	);
	const legacyNames = legacyArm64AssetNames(input.candidate);
	const unknown = undeclared.filter((asset) => !legacyNames.has(asset.name));
	const migrateLegacyRelease = hasLegacyArm64Metadata(release, input.candidate);
	if (unknown.length || (undeclared.length > 0 && !migrateLegacyRelease)) {
		throw new Error(
			`release contains undeclared assets: ${undeclared.map((item) => item.name).join(",")}`,
		);
	}
	if (!release.draft && release.prerelease !== prerelease)
		throw new Error("release prerelease status mismatch");
	for (const legacy of undeclared) {
		await input.api.request<void>(
			`/repos/${transport.releaseRepository}/releases/assets/${legacy.id}`,
			{ method: "DELETE" },
		);
	}
	for (const expectedAsset of expected) {
		const existing = release.assets.find(
			(asset) => asset.name === expectedAsset.name,
		);
		if (
			existing &&
			existing.digest === `sha256:${expectedAsset.sha256}` &&
			existing.size === expectedAsset.size
		)
			continue;
		if (existing)
			await input.api.request<void>(
				`/repos/${transport.releaseRepository}/releases/assets/${existing.id}`,
				{ method: "DELETE" },
			);
		const uploadUrl = release.upload_url.replace(
			"{?name,label}",
			`?name=${encodeURIComponent(expectedAsset.name)}`,
		);
		await input.api.request<ReleaseAsset>(uploadUrl, {
			method: "POST",
			headers: {
				"Content-Type": expectedAsset.mediaType,
				"Content-Length": String(expectedAsset.size),
			},
			body: readFileSync(expectedAsset.path),
		});
	}
	release = await input.api.request<Release>(
		`/repos/${transport.releaseRepository}/releases/${release.id}`,
	);
	verifyReleaseAssets(release, expected);
	if (!release.draft) {
		if (migrateLegacyRelease) {
			release = await input.api.request<Release>(
				`/repos/${transport.releaseRepository}/releases/${release.id}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: `ForgeaX Studio ${input.candidate.target.tag}`,
						prerelease,
						body: UNSIGNED_RELEASE_NOTICE,
					}),
				},
			);
		}
		requireUnsignedReleaseNotice(release);
		const completed = completedRecord(input.candidate, release);
		appendFileSync(input.recoveryPath, `${JSON.stringify(completed)}\n`);
		return { release, records: [completed] };
	}
	const draftRecord: RecoveryRecord = {
		schema: "forgeax-ide-release-recovery/v1",
		orchestrationId: input.candidate.orchestrationId,
		candidateDigest: input.candidate.digest,
		mode: "publish",
		state: "draft-reconciled",
		mutation: "draft",
		verified: true,
		releaseId: release.id,
		releaseUrl: release.html_url,
	};
	appendFileSync(input.recoveryPath, `${JSON.stringify(draftRecord)}\n`);
	release = await input.api.request<Release>(
		`/repos/${transport.releaseRepository}/releases/${release.id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				draft: false,
				prerelease,
				body: withUnsignedReleaseNotice(release.body),
			}),
		},
	);
	if (release.draft) throw new Error("GitHub Release remained a draft");
	if (release.prerelease !== prerelease)
		throw new Error("release prerelease status mismatch");
	const tagCommit = await resolveTagCommit(
		input.api,
		input.candidate.target.tag,
	);
	if (tagCommit !== input.candidate.target.commit)
		throw new Error("release tag commit mismatch");
	requireUnsignedReleaseNotice(release);
	const completed = completedRecord(input.candidate, release);
	appendFileSync(input.recoveryPath, `${JSON.stringify(completed)}\n`);
	return { release, records: [draftRecord, completed] };
}

function verifyReleaseAssets(
	release: Release,
	expected: ExpectedAsset[],
): void {
	if (release.assets.length !== expected.length)
		throw new Error("release asset roster mismatch");
	for (const item of expected) {
		const actual = release.assets.find((asset) => asset.name === item.name);
		if (
			!actual ||
			actual.digest !== `sha256:${item.sha256}` ||
			actual.size !== item.size
		)
			throw new Error(`release asset digest mismatch: ${item.name}`);
	}
}
function completedRecord(
	candidate: AggregateCandidate,
	release: Release,
): RecoveryRecord {
	return {
		schema: "forgeax-ide-release-recovery/v1",
		orchestrationId: candidate.orchestrationId,
		candidateDigest: candidate.digest,
		mode: "publish",
		state: "completed",
		mutation: "published",
		verified: true,
		releaseId: release.id,
		releaseUrl: release.html_url,
	};
}

if (import.meta.main) {
	const arg = (name: string): string => {
		const index = Bun.argv.indexOf(name);
		const value = index >= 0 ? Bun.argv[index + 1] : undefined;
		if (!value) throw new Error(`${name} is required`);
		return value;
	};
	const candidatePath = arg("--candidate");
	const recoveryPath = arg("--recovery");
	const assetsRoot = arg("--assets-root");
	const evidenceRoot = arg("--evidence-root");
	const candidate = JSON.parse(
		readFileSync(candidatePath, "utf8"),
	) as AggregateCandidate;
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is required");
	const result = await reconcileDraftRelease({
		candidate,
		candidatePath,
		recoveryPath,
		assetsRoot,
		evidenceRoot,
		api: new GitHubApi(token),
	});
	console.log(
		JSON.stringify({
			code: "IDE_RELEASE_PUBLISHED",
			releaseId: result.release.id,
			releaseUrl: result.release.html_url,
			candidateDigest: candidate.digest,
		}),
	);
}

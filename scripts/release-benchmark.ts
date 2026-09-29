#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import contract from "../release/contract.json";
import {
	type AggregateCandidate,
	validateCandidate,
} from "./release-candidate";
import type { ReleaseContext } from "./resolve-release-context";

const DEFAULT_REPOSITORY = "ForgeaX-Games/forgeax-ide";
type GhRun = {
	id: number;
	run_attempt: number;
	html_url: string;
	head_sha: string;
	event: string;
	conclusion: string | null;
};
type GhStep = {
	name: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
};
type GhJob = {
	name: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
	labels?: string[];
	steps?: GhStep[];
};
type GhArtifact = {
	id: number;
	name: string;
	size_in_bytes: number;
	expired: boolean;
};
type StageOutput = {
	label: string;
	path: string;
	exists: boolean;
	files: number;
	symlinks: number;
	bytes: number;
};
export type ReleaseStageRecord = {
	schema: "forgeax-ide-release-stage/v1";
	stage: string;
	platform: string;
	targetTriple: string | null;
	durationMs: number;
	exitCode: number;
	outputs: StageOutput[];
};
export type BenchmarkIdentity = Pick<
	ReleaseContext,
	| "version"
	| "ideRevision"
	| "integrationRevision"
	| "revisionBranch"
	| "sidecarManifestUrl"
	| "sidecarManifestSha256"
	| "mode"
	| "workflowDefinitionRevision"
>;
export type BenchmarkRunRecord = {
	schema: "forgeax-ide-release-benchmark-run/v1";
	source: {
		repository: string;
		runId: number;
		runAttempt: number;
		url: string;
		headSha: string;
	};
	identity: BenchmarkIdentity;
	wallClockMs: number;
	runnerTotalMs: number;
	jobs: Array<{
		name: string;
		runnerLabels: string[];
		durationMs: number;
		steps: Array<{ name: string; conclusion: "success"; durationMs: number }>;
	}>;
	stages: Array<{
		stage: string;
		platform: string;
		targetTriple: string | null;
		durationMs: number;
		outputs: StageOutput[];
	}>;
	artifacts: Array<{ name: string; sizeBytes: number }>;
	installerBytes: number;
};
export type Distribution = {
	values: number[];
	min: number;
	median: number;
	max: number;
	rangePercent: number;
};
export type BenchmarkSummary = {
	schema: "forgeax-ide-release-benchmark-summary/v1";
	kind: "baseline" | "candidate";
	identity: BenchmarkIdentity;
	runnerLabels: Array<{ job: string; labels: string[] }>;
	sampleSize: number;
	runs: BenchmarkRunRecord["source"][];
	metrics: {
		wallClockMs: Distribution;
		runnerTotalMs: Distribution;
		artifactTransferBytes: Distribution;
		installerBytes: Distribution;
		stages: Record<string, Distribution>;
	};
	interpretation: {
		estimator: "median";
		hostedRunnerVariance: "Report min/max/rangePercent for every metric; do not infer deterministic gains from a single run.";
	};
};

function fail(message: string): never {
	throw new Error(`[release-benchmark] ${message}`);
}
function duration(
	start: string | null,
	end: string | null,
	label: string,
): number {
	if (!start || !end) fail(`${label} is missing timestamps`);
	const value = Date.parse(end) - Date.parse(start);
	if (!Number.isFinite(value) || value < 0)
		fail(`${label} has invalid timestamps`);
	return value;
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function identity(context: ReleaseContext): BenchmarkIdentity {
	const {
		version,
		ideRevision,
		integrationRevision,
		revisionBranch,
		sidecarManifestUrl,
		sidecarManifestSha256,
		mode,
		workflowDefinitionRevision,
	} = context;
	return {
		version,
		ideRevision,
		integrationRevision,
		revisionBranch,
		sidecarManifestUrl,
		sidecarManifestSha256,
		mode,
		workflowDefinitionRevision,
	};
}

export function buildRunRecord(input: {
	repository: string;
	run: GhRun;
	jobs: GhJob[];
	artifacts: GhArtifact[];
	context: ReleaseContext;
	candidate: AggregateCandidate;
	stages: ReleaseStageRecord[];
}): BenchmarkRunRecord {
	if (input.repository !== DEFAULT_REPOSITORY)
		fail(`repository must be ${DEFAULT_REPOSITORY}`);
	if (
		input.run.conclusion !== "success" ||
		input.run.event !== "workflow_dispatch"
	)
		fail("run must be a successful workflow_dispatch");
	if (input.context.mode !== "dry-run")
		fail("benchmark collection requires intent=dry-run");
	if (input.run.id !== Number(input.candidate.publisher.workflowRunId))
		fail("candidate publisher run does not match collected run");
	if (
		input.run.run_attempt !==
		Number(input.candidate.publisher.workflowRunAttempt)
	)
		fail("candidate publisher attempt does not match collected run");
	if (
		input.run.head_sha !== input.context.workflowDefinitionRevision ||
		input.candidate.publisher.workflowDefinitionRevision !==
			input.context.workflowDefinitionRevision
	)
		fail("workflow definition revision drift");
	if (
		input.candidate.source.ide.revision !== input.context.ideRevision ||
		input.candidate.source.integration.revision !==
			input.context.integrationRevision
	)
		fail("candidate source revision drift");
	validateCandidate(input.candidate, "dry-run");

	const jobs = input.jobs
		.filter((job) => job.conclusion === "success")
		.map((job) => ({
			name: job.name,
			runnerLabels: [...(job.labels ?? [])].sort(),
			durationMs: duration(job.started_at, job.completed_at, `job ${job.name}`),
			steps: (job.steps ?? [])
				.filter((step) => step.conclusion === "success")
				.map((step) => ({
					name: step.name,
					conclusion: "success" as const,
					durationMs: duration(
						step.started_at,
						step.completed_at,
						`step ${job.name}/${step.name}`,
					),
				})),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (jobs.length === 0) fail("run has no successful jobs");
	const starts = input.jobs
		.filter((job) => job.conclusion === "success")
		.map((job) => Date.parse(job.started_at ?? ""));
	const ends = input.jobs
		.filter((job) => job.conclusion === "success")
		.map((job) => Date.parse(job.completed_at ?? ""));
	if ([...starts, ...ends].some((value) => !Number.isFinite(value)))
		fail("run jobs have invalid timestamps");

	const seenStages = new Set<string>();
	const stages = input.stages
		.map((stage) => {
			if (
				stage.schema !== "forgeax-ide-release-stage/v1" ||
				stage.exitCode !== 0 ||
				stage.durationMs <= 0
			)
				fail("stage report is invalid or unsuccessful");
			const key = `${stage.platform}/${stage.stage}`;
			if (seenStages.has(key)) fail(`duplicate stage report: ${key}`);
			seenStages.add(key);
			return {
				stage: stage.stage,
				platform: stage.platform,
				targetTriple: stage.targetTriple,
				durationMs: stage.durationMs,
				outputs: stage.outputs,
			};
		})
		.sort((a, b) =>
			`${a.platform}/${a.stage}`.localeCompare(`${b.platform}/${b.stage}`),
		);
	if (stages.length === 0) fail("run has no stage metrics");
	const artifacts = input.artifacts
		.map((artifact) => {
			if (
				artifact.expired ||
				!Number.isSafeInteger(artifact.size_in_bytes) ||
				artifact.size_in_bytes <= 0
			)
				fail(`artifact is unavailable: ${artifact.name}`);
			return { name: artifact.name, sizeBytes: artifact.size_in_bytes };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const installerBytes = input.candidate.platforms
		.flatMap((platform) => platform.artifacts)
		.reduce((sum, artifact) => sum + artifact.size, 0);
	return {
		schema: contract.benchmarkRunSchema as BenchmarkRunRecord["schema"],
		source: {
			repository: input.repository,
			runId: input.run.id,
			runAttempt: input.run.run_attempt,
			url: input.run.html_url,
			headSha: input.run.head_sha,
		},
		identity: identity(input.context),
		wallClockMs: Math.max(...ends) - Math.min(...starts),
		runnerTotalMs: jobs.reduce((sum, job) => sum + job.durationMs, 0),
		jobs,
		stages,
		artifacts,
		installerBytes,
	};
}

export function distribution(input: number[]): Distribution {
	if (
		input.length < 3 ||
		input.some((value) => !Number.isFinite(value) || value < 0)
	)
		fail("distribution requires at least three finite non-negative samples");
	const values = [...input].sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	const median =
		values.length % 2
			? values[middle]
			: (values[middle - 1] + values[middle]) / 2;
	const min = values[0];
	const max = values[values.length - 1];
	return {
		values,
		min,
		median,
		max,
		rangePercent:
			median === 0 ? 0 : Math.round(((max - min) / median) * 100_000) / 1000,
	};
}

function runnerLabels(
	run: BenchmarkRunRecord,
): Array<{ job: string; labels: string[] }> {
	return run.jobs.map((job) => ({ job: job.name, labels: job.runnerLabels }));
}
export function summarizeRuns(
	kind: "baseline" | "candidate",
	runs: BenchmarkRunRecord[],
): BenchmarkSummary {
	if (runs.length < 3) fail("summary requires at least three runs");
	if (new Set(runs.map((run) => run.source.runId)).size !== runs.length)
		fail("run IDs must be unique");
	const expectedIdentity = canonical(runs[0].identity);
	const expectedRunners = canonical(runnerLabels(runs[0]));
	const expectedStages = runs[0].stages.map(
		(stage) => `${stage.platform}/${stage.stage}`,
	);
	for (const run of runs) {
		if (
			run.schema !== contract.benchmarkRunSchema ||
			run.identity.mode !== "dry-run"
		)
			fail("run record schema or intent is invalid");
		if (canonical(run.identity) !== expectedIdentity)
			fail("benchmark inputs differ between runs");
		if (canonical(runnerLabels(run)) !== expectedRunners)
			fail("runner labels differ between runs");
		if (
			canonical(
				run.stages.map((stage) => `${stage.platform}/${stage.stage}`),
			) !== canonical(expectedStages)
		)
			fail("stage roster differs between runs");
	}
	const stageMetrics = Object.fromEntries(
		expectedStages.map((key, index) => [
			key,
			distribution(runs.map((run) => run.stages[index].durationMs)),
		]),
	);
	return {
		schema: contract.benchmarkSummarySchema as BenchmarkSummary["schema"],
		kind,
		identity: runs[0].identity,
		runnerLabels: runnerLabels(runs[0]),
		sampleSize: runs.length,
		runs: runs.map((run) => run.source),
		metrics: {
			wallClockMs: distribution(runs.map((run) => run.wallClockMs)),
			runnerTotalMs: distribution(runs.map((run) => run.runnerTotalMs)),
			artifactTransferBytes: distribution(
				runs.map((run) =>
					run.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
				),
			),
			installerBytes: distribution(runs.map((run) => run.installerBytes)),
			stages: stageMetrics,
		},
		interpretation: {
			estimator: "median",
			hostedRunnerVariance:
				"Report min/max/rangePercent for every metric; do not infer deterministic gains from a single run.",
		},
	};
}

function ghJson<T>(args: string[]): T {
	const result = spawnSync("gh", ["api", ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) fail(`gh api failed: ${result.stderr.trim()}`);
	return JSON.parse(result.stdout) as T;
}
function downloadArtifact(
	repository: string,
	runId: number,
	name: string,
	root: string,
): string {
	if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`unsafe artifact name: ${name}`);
	const destination = join(root, name);
	mkdirSync(destination, { recursive: true });
	const result = spawnSync(
		"gh",
		[
			"run",
			"download",
			String(runId),
			"-R",
			repository,
			"-n",
			name,
			"--dir",
			destination,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0)
		fail(`failed to download artifact ${name}: ${result.stderr.trim()}`);
	return destination;
}
function jsonFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory()
			? jsonFiles(path)
			: entry.name.endsWith(".json")
				? [path]
				: [];
	});
}
function readFirst<T>(
	root: string,
	predicate: (value: unknown) => boolean,
	label: string,
): T {
	const matches = jsonFiles(root)
		.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown)
		.filter(predicate);
	if (matches.length !== 1)
		fail(`expected exactly one ${label}, found ${matches.length}`);
	return matches[0] as T;
}
export function collectRun(
	repository: string,
	runId: number,
): BenchmarkRunRecord {
	const apiRoot = `repos/${repository}/actions/runs/${runId}`;
	const run = ghJson<GhRun>([apiRoot]);
	const jobsResponse = ghJson<{ total_count: number; jobs: GhJob[] }>([
		`${apiRoot}/jobs?per_page=100`,
	]);
	const artifactsResponse = ghJson<{
		total_count: number;
		artifacts: GhArtifact[];
	}>([`${apiRoot}/artifacts?per_page=100`]);
	if (
		jobsResponse.total_count !== jobsResponse.jobs.length ||
		artifactsResponse.total_count !== artifactsResponse.artifacts.length
	)
		fail("GitHub API pagination would make the benchmark incomplete");
	const contextArtifacts = artifactsResponse.artifacts.filter((artifact) =>
		artifact.name.startsWith("ide-release-context-"),
	);
	const metricsArtifacts = artifactsResponse.artifacts.filter((artifact) =>
		artifact.name.startsWith("ide-release-metrics-"),
	);
	const candidateArtifacts = artifactsResponse.artifacts.filter((artifact) =>
		artifact.name.startsWith("ide-release-candidate-"),
	);
	if (
		contextArtifacts.length !== 1 ||
		metricsArtifacts.length !== 4 ||
		candidateArtifacts.length !== 1
	)
		fail("release benchmark artifact roster is incomplete or ambiguous");
	const temporary = mkdtempSync(
		join(tmpdir(), `forgeax-release-benchmark-${runId}-`),
	);
	try {
		const contextRoot = downloadArtifact(
			repository,
			runId,
			contextArtifacts[0].name,
			temporary,
		);
		const candidateRoot = downloadArtifact(
			repository,
			runId,
			candidateArtifacts[0].name,
			temporary,
		);
		const metricsRoots = metricsArtifacts.map((artifact) =>
			downloadArtifact(repository, runId, artifact.name, temporary),
		);
		const context = readFirst<ReleaseContext>(
			contextRoot,
			(value) =>
				Boolean(
					value &&
						typeof value === "object" &&
						"ideRevision" in value &&
						"workflowDefinitionRevision" in value,
				),
			"release context",
		);
		const candidate = readFirst<AggregateCandidate>(
			candidateRoot,
			(value) =>
				Boolean(
					value &&
						typeof value === "object" &&
						(value as { schema?: string }).schema ===
							"forgeax-ide-release-candidate/v1",
				),
			"release candidate",
		);
		const stages = metricsRoots.flatMap((root) =>
			jsonFiles(root)
				.map(
					(path) =>
						JSON.parse(readFileSync(path, "utf8")) as ReleaseStageRecord,
				)
				.filter((value) => value.schema === "forgeax-ide-release-stage/v1"),
		);
		return buildRunRecord({
			repository,
			run,
			jobs: jobsResponse.jobs,
			artifacts: artifactsResponse.artifacts,
			context,
			candidate,
			stages,
		});
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}
function argumentsFor(name: string): string[] {
	return Bun.argv
		.flatMap((value, index) =>
			value === name ? [Bun.argv[index + 1] ?? ""] : [],
		)
		.filter(Boolean);
}
function writeJson(path: string, value: unknown): void {
	const output = resolve(path);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
	const command = Bun.argv[2];
	if (command === "collect") {
		const runId = Number(argument("--run-id"));
		const output = argument("--output");
		if (!Number.isSafeInteger(runId) || runId <= 0 || !output)
			fail("collect requires --run-id and --output");
		const record = collectRun(argument("--repo") ?? DEFAULT_REPOSITORY, runId);
		writeJson(output, record);
		console.log(
			JSON.stringify({
				code: "IDE_RELEASE_BENCHMARK_RUN_COLLECTED",
				runId,
				output: resolve(output),
			}),
		);
	} else if (command === "summarize") {
		const kind = argument("--kind") as "baseline" | "candidate";
		const inputs = argumentsFor("--input");
		const output = argument("--output");
		if (
			!["baseline", "candidate"].includes(kind) ||
			inputs.length < 3 ||
			!output
		)
			fail(
				"summarize requires --kind, at least three --input files, and --output",
			);
		const summary = summarizeRuns(
			kind,
			inputs.map(
				(path) => JSON.parse(readFileSync(path, "utf8")) as BenchmarkRunRecord,
			),
		);
		writeJson(output, summary);
		console.log(
			JSON.stringify({
				code: "IDE_RELEASE_BENCHMARK_SUMMARIZED",
				kind,
				sampleSize: summary.sampleSize,
				output: resolve(output),
			}),
		);
	} else fail("usage: release-benchmark <collect|summarize>");
}

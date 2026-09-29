#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import transport from "../release/transport-contract.v1.json";
import tauriConfig from "../src-tauri/tauri.conf.json";
import {
	buildPlatformEvidence,
	type PlatformRecord,
} from "./release-candidate";
import type { ReleaseContext } from "./resolve-release-context";

type CommandRunner = (command: string, args: string[]) => void;
type VerifyReleaseBundleInput = {
	context: ReleaseContext;
	logicalId: string;
	targetTriple: string;
	bundleRoot: string;
	assetsOutput: string;
	evidenceOutput: string;
	recordOutput: string;
};

function fail(message: string): never {
	throw new Error(`[verify-release-bundle] ${message}`);
}
function runCommand(command: string, args: string[]): void {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0)
		fail(
			`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
		);
}

export function verifyReleaseBundle(
	input: VerifyReleaseBundleInput,
	run: CommandRunner = runCommand,
): PlatformRecord {
	const platform = transport.platforms.find(
		(entry) => entry.logicalId === input.logicalId,
	);
	if (!platform || platform.targetTriple !== input.targetTriple)
		fail("platform and target triple do not match the transport contract");
	if (input.context.mode !== "dry-run")
		fail("instrumented bundle verification requires intent=dry-run");
	run("bun", ["run", "smoke:production-bundle"]);
	if (input.logicalId.startsWith("macos-")) {
		const app = join(
			resolve(input.bundleRoot),
			"macos",
			`${tauriConfig.productName}.app`,
		);
		run("bun", ["run", "verify:macos-bundle", "--app", app]);
	}
	const { record } = buildPlatformEvidence({
		context: input.context,
		logicalId: input.logicalId,
		bundleRoot: input.bundleRoot,
		assetsOutput: input.assetsOutput,
		evidenceOutput: input.evidenceOutput,
	});
	mkdirSync(resolve(input.recordOutput, ".."), { recursive: true });
	writeFileSync(input.recordOutput, `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}
function required(name: string): string {
	const value = argument(name);
	if (!value) fail(`${name} is required`);
	return value;
}

if (import.meta.main) {
	const context = JSON.parse(
		readFileSync(required("--context"), "utf8"),
	) as ReleaseContext;
	const record = verifyReleaseBundle({
		context,
		logicalId: required("--logical-id"),
		targetTriple: required("--target-triple"),
		bundleRoot: required("--bundle-root"),
		assetsOutput: required("--assets-output"),
		evidenceOutput: required("--evidence-output"),
		recordOutput: required("--record-output"),
	});
	console.log(
		JSON.stringify({
			code: "IDE_RELEASE_BUNDLE_VERIFIED",
			logicalId: record.logicalId,
			artifacts: record.artifacts.length,
		}),
	);
}

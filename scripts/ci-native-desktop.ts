#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
/** CI wrapper deliberately delegates to the same product command used locally. */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function required(name: string): string {
	const index = Bun.argv.indexOf(name);
	const value = index < 0 ? undefined : Bun.argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`ci:native-desktop requires ${name}`);
	return resolve(value);
}

const app = required("--app");
const permitted = new Set(["--app", "--fault", "--appium-port", "--revision"]);
const forwarded: string[] = ["--app", app];
for (let index = 2; index < Bun.argv.length; index += 1) {
	const name = Bun.argv[index];
	if (!name.startsWith("--"))
		throw new Error(
			`ci:native-desktop does not accept positional argument: ${name}`,
		);
	if (!permitted.has(name))
		throw new Error(`ci:native-desktop does not accept ${name}`);
	const value = Bun.argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`ci:native-desktop requires a value for ${name}`);
	if (name === "--revision" && !/^[0-9a-f]{40}$/i.test(value))
		throw new Error(
			"ci:native-desktop --revision must be a 40-character git SHA",
		);
	if (name !== "--app") forwarded.push(name, value);
	index += 1;
}
const output = process.env.IDE_NATIVE_SMOKE_ARTIFACT_DIR
	? resolve(process.env.IDE_NATIVE_SMOKE_ARTIFACT_DIR)
	: undefined;
if (output) mkdirSync(output, { recursive: true });
const diagnosticRoot = output
	? join(output, `native-smoke-${process.pid}-${Date.now()}`)
	: undefined;
if (diagnosticRoot) mkdirSync(diagnosticRoot, { recursive: true });
// Runner budget is 330s plus bounded 55s cleanup. Leave a final 65s archive
// margin so this outer process never pre-empts the runner's own cleanup.
const result = spawnSync(
	process.execPath,
	["run", "smoke:native-desktop", ...forwarded, "--keep-artifacts"],
	{
		stdio: "inherit",
		timeout: 450_000,
		env: {
			...process.env,
			...(diagnosticRoot
				? { IDE_NATIVE_SMOKE_DIAGNOSTIC_DIR: diagnosticRoot }
				: {}),
		},
	},
);
const errors: string[] = [];
if (result.error || result.status !== 0)
	errors.push(
		`native desktop smoke failed: ${result.error?.message ?? result.signal ?? result.status}`,
	);
try {
	if (diagnosticRoot && readdirSync(diagnosticRoot).length === 0)
		errors.push("native desktop smoke wrote no diagnostic evidence");
	if (output)
		writeFileSync(
			join(output, "native-smoke-context.json"),
			`${JSON.stringify({ app, forwarded, platform: process.platform, arch: process.arch, status: result.status, signal: result.signal, diagnosticRoot }, null, 2)}\n`,
		);
} catch (error) {
	errors.push(
		`native smoke archive failed: ${error instanceof Error ? error.message : String(error)}`,
	);
}
if (errors.length)
	throw new AggregateError(
		errors.map((message) => new Error(message)),
		"native desktop smoke or archive failed",
	);

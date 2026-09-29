#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SourceSidecarContext } from "./build-source-sidecar";
import type { DesktopRuntimeManifest } from "./desktop-runtime-manifest";
import { localBuildSource } from "./local-build-source";

export const NATIVE_PRODUCT_RECEIPT_SCHEMA =
	"forgeax-native-product-receipt/v1" as const;
export const DESKTOP_BUILD_SOURCE_PATH =
	"release-work/desktop-build-source.json";
export const NATIVE_PRODUCT_RECEIPT_NAME = "native-product-receipt.json";
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;

type NativeProductPlatform = "macos" | "windows";
type LocalBuildSource = {
	schema: "forgeax-local-build-source/v1";
	bun: string;
	repositories: Record<
		string,
		{
			revision: string;
			dirty: boolean;
			diffSha256: string;
			untracked: unknown[];
		}
	>;
};
type SourceBaseline = {
	revision: string;
	dirty: boolean;
	diffSha256: string;
	untrackedSha256: string;
};
export type NativeProductReceipt = {
	schema: typeof NATIVE_PRODUCT_RECEIPT_SCHEMA;
	platform: NativeProductPlatform;
	revision: string;
	executable: string;
	sha256: string;
	runtimeManifest: { path: string; sha256: string; digest: string };
	sourceContext: { sha256: string; sourceRevisions: Record<string, string> };
	source: {
		kind: "committed" | "dirty-working-tree";
		buildSourceSha256: string;
		baselines: Record<string, SourceBaseline>;
	};
};

function fail(message: string): never {
	throw new Error(`[native-product-receipt] ${message}`);
}
function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function portablePath(root: string, path: string): string {
	const value = relative(root, path);
	if (
		!value ||
		value === ".." ||
		value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(value)
	)
		fail(`path is outside portable product root: ${path}`);
	return value.split("\\").join("/");
}
function sourceKind(
	source: LocalBuildSource,
): "committed" | "dirty-working-tree" {
	if (
		source.schema !== "forgeax-local-build-source/v1" ||
		!source.repositories ||
		Object.values(source.repositories).some(
			(value) =>
				!REVISION.test(value.revision) || typeof value.dirty !== "boolean",
		)
	)
		fail("invalid local build source snapshot");
	return Object.values(source.repositories).some((value) => value.dirty)
		? "dirty-working-tree"
		: "committed";
}
function baselines(source: LocalBuildSource): Record<string, SourceBaseline> {
	return Object.fromEntries(
		Object.entries(source.repositories).map(([path, value]) => [
			path,
			{
				revision: value.revision,
				dirty: value.dirty,
				diffSha256: value.diffSha256,
				untrackedSha256: createHash("sha256")
					.update(JSON.stringify(value.untracked))
					.digest("hex"),
			},
		]),
	);
}
function resolveReceiptPath(
	root: string,
	value: string,
	label: string,
): string {
	if (typeof value !== "string" || !value || isAbsolute(value))
		fail(`invalid ${label} receipt path`);
	const path = resolve(root, value);
	if (path === root || relative(root, path).startsWith(".."))
		fail(`invalid ${label} receipt path`);
	return path;
}
function parseReceipt(path: string): NativeProductReceipt {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(
			`could not read receipt: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const receipt = value as Partial<NativeProductReceipt>;
	if (
		!receipt ||
		receipt.schema !== NATIVE_PRODUCT_RECEIPT_SCHEMA ||
		!["macos", "windows"].includes(receipt.platform ?? "") ||
		!REVISION.test(receipt.revision ?? "") ||
		!SHA256.test(receipt.sha256 ?? "") ||
		!receipt.runtimeManifest ||
		!SHA256.test(receipt.runtimeManifest.sha256) ||
		!SHA256.test(receipt.runtimeManifest.digest) ||
		!receipt.sourceContext ||
		!SHA256.test(receipt.sourceContext.sha256) ||
		!receipt.source ||
		!["committed", "dirty-working-tree"].includes(receipt.source.kind ?? "") ||
		!SHA256.test(receipt.source.buildSourceSha256) ||
		!receipt.source.baselines ||
		!Object.values(receipt.source.baselines).every(
			(value) =>
				!!value &&
				REVISION.test(value.revision) &&
				typeof value.dirty === "boolean" &&
				SHA256.test(value.diffSha256) &&
				SHA256.test(value.untrackedSha256),
		)
	)
		fail("invalid receipt schema");
	const ide = receipt.source.baselines["packages/ide"];
	const studio = receipt.source.baselines["."];
	if (
		!ide ||
		ide.revision !== receipt.revision ||
		!studio ||
		receipt.sourceContext.sourceRevisions?.studio !== studio.revision
	)
		fail("receipt source baselines do not match context");
	return receipt as NativeProductReceipt;
}

export function readNativeProductReceipt(path: string): NativeProductReceipt {
	return parseReceipt(resolve(path));
}
export function nativeProductSourceRoot(
	scriptDirectory = import.meta.dirname,
): string {
	return resolve(scriptDirectory, "../../..");
}
export function assertNativeProductSourceStable(
	buildSource: string,
	current: unknown = localBuildSource(nativeProductSourceRoot()),
): void {
	const recorded = JSON.parse(
		readFileSync(resolve(buildSource), "utf8"),
	) as LocalBuildSource;
	if (JSON.stringify(recorded) !== JSON.stringify(current))
		fail(
			"source changed after desktop preparation; refusing to bind final product to an earlier source snapshot",
		);
}
export function verifyNativeProductReceipt(options: {
	receipt: string;
	platform: NativeProductPlatform;
	executable: string;
	revision?: string;
	sourceContext?: string;
	buildSource?: string;
}): NativeProductReceipt {
	const receiptPath = resolve(options.receipt);
	const receipt = parseReceipt(receiptPath);
	const root = resolve(receiptPath, "..");
	const executable = resolveReceiptPath(root, receipt.executable, "executable");
	const manifestPath = resolveReceiptPath(
		root,
		receipt.runtimeManifest.path,
		"runtime manifest",
	);
	if (
		receipt.platform !== options.platform ||
		executable !== resolve(options.executable) ||
		!existsSync(executable) ||
		sha256(executable) !== receipt.sha256
	)
		fail("receipt does not bind the expected executable");
	if (options.revision && receipt.revision !== options.revision)
		fail("receipt source baseline does not match expected revision");
	if (
		!existsSync(manifestPath) ||
		sha256(manifestPath) !== receipt.runtimeManifest.sha256
	)
		fail("receipt runtime manifest hash mismatch");
	const manifest = JSON.parse(
		readFileSync(manifestPath, "utf8"),
	) as DesktopRuntimeManifest;
	if (manifest.digest !== receipt.runtimeManifest.digest)
		fail("receipt runtime manifest digest mismatch");
	if (
		options.sourceContext &&
		sha256(resolve(options.sourceContext)) !== receipt.sourceContext.sha256
	)
		fail("receipt source context hash mismatch");
	if (
		options.buildSource &&
		sha256(resolve(options.buildSource)) !== receipt.source.buildSourceSha256
	)
		fail("receipt build source hash mismatch");
	return receipt;
}
export function invalidateNativeProductReceipt(productRoot: string): void {
	rmSync(join(productRoot, NATIVE_PRODUCT_RECEIPT_NAME), { force: true });
}

export function createNativeProductReceipt(options: {
	platform: NativeProductPlatform;
	productRoot: string;
	executable: string;
	runtimeManifest: string;
	sourceContext: string;
	buildSource: string;
	output: string;
	currentSource?: unknown;
}): NativeProductReceipt {
	const productRoot = resolve(options.productRoot);
	const executable = resolve(options.executable);
	const runtimeManifest = resolve(options.runtimeManifest);
	const sourceContextPath = resolve(options.sourceContext);
	const buildSourcePath = resolve(options.buildSource);
	const output = resolve(options.output);
	for (const path of [
		executable,
		runtimeManifest,
		sourceContextPath,
		buildSourcePath,
	])
		if (!existsSync(path)) fail(`required input is missing: ${path}`);
	// This is deliberately here, rather than only in platform finalizers: the
	// Windows CLI is a final-product producer too.
	assertNativeProductSourceStable(buildSourcePath, options.currentSource);
	const sourceContext = JSON.parse(
		readFileSync(sourceContextPath, "utf8"),
	) as SourceSidecarContext;
	const source = JSON.parse(
		readFileSync(buildSourcePath, "utf8"),
	) as LocalBuildSource;
	const manifest = JSON.parse(
		readFileSync(runtimeManifest, "utf8"),
	) as DesktopRuntimeManifest;
	const ide = source.repositories["packages/ide"];
	const studio = source.repositories["."];
	if (!ide || !REVISION.test(ide.revision))
		fail("local build source has no immutable IDE baseline");
	if (!studio || !REVISION.test(studio.revision))
		fail("local build source has no immutable Studio baseline");
	if (
		sourceContext.schema !== "forgeax-server-source-build/v1" ||
		!REVISION.test(sourceContext.sourceRevisions?.studio ?? "")
	)
		fail("invalid source sidecar context");
	if (sourceContext.sourceRevisions.studio !== studio.revision)
		fail("source sidecar and build source Studio baselines differ");
	if (!SHA256.test(manifest.digest ?? ""))
		fail("invalid desktop runtime manifest");
	if (
		(options.platform === "macos" &&
			manifest.platform !== "macos-arm64" &&
			manifest.platform !== "macos-x64") ||
		(options.platform === "windows" && manifest.platform !== "windows-x64")
	)
		fail("runtime manifest platform does not match product");
	const receipt: NativeProductReceipt = {
		schema: NATIVE_PRODUCT_RECEIPT_SCHEMA,
		platform: options.platform,
		revision: ide.revision,
		executable: portablePath(productRoot, executable),
		sha256: sha256(executable),
		runtimeManifest: {
			path: portablePath(productRoot, runtimeManifest),
			sha256: sha256(runtimeManifest),
			digest: manifest.digest,
		},
		sourceContext: {
			sha256: sha256(sourceContextPath),
			sourceRevisions: sourceContext.sourceRevisions,
		},
		source: {
			kind: sourceKind(source),
			buildSourceSha256: sha256(buildSourcePath),
			baselines: baselines(source),
		},
	};
	mkdirSync(resolve(output, ".."), { recursive: true });
	const temporary = `${output}.write-${process.pid}`;
	rmSync(temporary, { force: true });
	try {
		writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
		});
		renameSync(temporary, output);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	return receipt;
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index < 0 ? undefined : Bun.argv[index + 1];
}
if (import.meta.main) {
	const platform = argument("--platform") as NativeProductPlatform;
	const productRoot = argument("--product-root");
	const executable = argument("--executable");
	const runtimeManifest = argument("--runtime-manifest");
	const sourceContext = argument("--source-context");
	const buildSource = argument("--build-source");
	const output = argument("--output");
	if (
		!["macos", "windows"].includes(platform) ||
		!productRoot ||
		!executable ||
		!runtimeManifest ||
		!sourceContext ||
		!buildSource ||
		!output
	)
		fail(
			"required: --platform macos|windows --product-root --executable --runtime-manifest --source-context --build-source --output",
		);
	console.log(
		JSON.stringify(
			createNativeProductReceipt({
				platform,
				productRoot,
				executable,
				runtimeManifest,
				sourceContext,
				buildSource,
				output,
			}),
		),
	);
}

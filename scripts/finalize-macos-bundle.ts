import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DESKTOP_SOURCE_CONTEXT_PATH } from "./build-source-sidecar";
import {
	assertNativeProductSourceStable,
	createNativeProductReceipt,
	DESKTOP_BUILD_SOURCE_PATH,
	invalidateNativeProductReceipt,
	NATIVE_PRODUCT_RECEIPT_NAME,
} from "./native-product-receipt";
import { hasRequiredBunVendorSignature } from "./verify-macos-bundle";

const IDE_ROOT = resolve(import.meta.dirname, "..");
export const MACOS_DMG_CREATE_RETRY_DELAYS_MS = [2_000, 5_000] as const;
export const MACOS_HDIUTIL_TIMEOUT_MS = 120_000;

interface CapturedCommandResult {
	status: number | null;
	stdout?: string | null;
	stderr?: string | null;
	error?: { message: string; code?: string } | null;
}

interface MacosDmgDependencies {
	execute?: (
		command: string,
		args: string[],
		options: { timeoutMs: number },
	) => CapturedCommandResult;
	wait?: (milliseconds: number) => void;
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function fail(message: string): never {
	throw new Error(`[macos-bundle] ${message}`);
}

function run(command: string, args: string[], capture = false): string {
	const result = spawnSync(command, args, {
		encoding: capture ? "utf8" : undefined,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0)
		fail(`command failed (${result.status}): ${command} ${args.join(" ")}`);
	return capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

function defaultCapturedCommand(
	command: string,
	args: string[],
	options: { timeoutMs: number },
): CapturedCommandResult {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		error: result.error,
	};
}

function defaultWait(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runMacosDmgCreate(
	args: string[],
	dependencies: MacosDmgDependencies = {},
): void {
	const execute = dependencies.execute ?? defaultCapturedCommand;
	const wait = dependencies.wait ?? defaultWait;
	const attempts = MACOS_DMG_CREATE_RETRY_DELAYS_MS.length + 1;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const result = executeHdiutil(args, execute);
		const output = capturedOutput(result);
		if (isHdiutilTimeout(result)) fail(hdiutilFailure(args, "timed out"));
		if (result.error)
			fail(hdiutilFailure(args, `failed to start: ${result.error.message}`));
		if (result.status === 0) return;
		if (result.status === null)
			fail(hdiutilFailure(args, "exited without a status"));

		const retryDelay = MACOS_DMG_CREATE_RETRY_DELAYS_MS[attempt - 1];
		const resourceBusy = /resource busy/i.test(output);
		if (!resourceBusy || retryDelay === undefined) {
			fail(`command failed (${result.status}): hdiutil ${args.join(" ")}`);
		}

		console.warn(
			`[macos-bundle] hdiutil create resource busy; retrying in ${retryDelay}ms (${attempt}/${attempts})`,
		);
		wait(retryDelay);
	}
}

function executeHdiutil(
	args: string[],
	execute: NonNullable<MacosDmgDependencies["execute"]>,
): CapturedCommandResult {
	const result = execute("hdiutil", args, {
		timeoutMs: MACOS_HDIUTIL_TIMEOUT_MS,
	});
	const output = capturedOutput(result);
	if (output) process.stderr.write(output);
	return result;
}

function capturedOutput(result: CapturedCommandResult): string {
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function isHdiutilTimeout(result: CapturedCommandResult): boolean {
	return (
		result.error?.code === "ETIMEDOUT" ||
		/timed?\s*out|timeout/i.test(result.error?.message ?? "")
	);
}

function hdiutilFailure(args: string[], reason: string): string {
	const operation = args[0] ?? "command";
	if (reason === "timed out")
		return `hdiutil ${operation} timed out after ${MACOS_HDIUTIL_TIMEOUT_MS}ms`;
	return `hdiutil ${operation} ${reason}`;
}

export function runMacosDmgVerify(
	dmg: string,
	dependencies: MacosDmgDependencies = {},
): void {
	const execute = dependencies.execute ?? defaultCapturedCommand;
	const args = ["verify", dmg];
	const result = executeHdiutil(args, execute);
	if (isHdiutilTimeout(result)) fail(hdiutilFailure(args, "timed out"));
	if (result.error)
		fail(hdiutilFailure(args, `failed to start: ${result.error.message}`));
	if (result.status !== 0) {
		if (result.status === null)
			fail(hdiutilFailure(args, "exited without a status"));
		fail(`command failed (${result.status}): hdiutil ${args.join(" ")}`);
	}
}

export function macosDmgCreateArgs(
	volumeName: string,
	sourceFolder: string,
	output: string,
): string[] {
	return [
		"create",
		"-volname",
		volumeName,
		"-srcfolder",
		sourceFolder,
		"-fs",
		"HFS+",
		"-ov",
		"-format",
		"UDZO",
		"-imagekey",
		"zlib-level=9",
		"-o",
		output,
	];
}

export function macosBunSidecarPath(target: string): string {
	if (target !== "aarch64-apple-darwin" && target !== "x86_64-apple-darwin") {
		fail(`unsupported macOS target: ${target}`);
	}
	return join(IDE_ROOT, `src-tauri/resources/sidecars/bun-${target}`);
}

export function outerAdHocSignArgs(
	appBundle: string,
	entitlements = join(IDE_ROOT, "src-tauri/Entitlements.plist"),
): string[] {
	return [
		"--force",
		"--sign",
		"-",
		"--options",
		"runtime",
		"--entitlements",
		entitlements,
		appBundle,
	];
}

function assertVendorSignedBun(path: string): void {
	run("codesign", ["--verify", "--strict", path]);
	const details = run("codesign", ["-dv", "--verbose=4", path], true);
	if (!hasRequiredBunVendorSignature(details)) {
		fail(`Bun vendor signature is missing: ${path}`);
	}
}

function restoreVendorBun(appBundle: string, vendorBun: string): void {
	const bundledBun = join(appBundle, "Contents/MacOS/bun");
	if (!existsSync(bundledBun)) fail(`bundled Bun is missing: ${bundledBun}`);
	copyFileSync(vendorBun, bundledBun);
	chmodSync(bundledBun, 0o755);
	assertVendorSignedBun(bundledBun);
	// Do not use --deep here: that would replace Bun's vendor signature and
	// reintroduce the vendor-runtime cold-start regression.
	run("codesign", outerAdHocSignArgs(appBundle));
	run("codesign", ["--verify", "--deep", "--strict", appBundle]);
	assertVendorSignedBun(bundledBun);
}

function singleDmg(bundleRoot: string): string {
	const directory = join(bundleRoot, "dmg");
	if (!existsSync(directory)) fail(`DMG directory is missing: ${directory}`);
	const images = readdirSync(directory).filter((name) => name.endsWith(".dmg"));
	if (images.length !== 1)
		fail(`expected one DMG in ${directory}; found ${images.length}`);
	return join(directory, images[0]!);
}

function rebuildDmg(dmg: string, appBundle: string): void {
	const temporary = mkdtempSync(join(tmpdir(), "forgeax-macos-bundle-"));
	const sourceFolder = join(temporary, "source");
	const stagedApp = join(sourceFolder, basename(appBundle));
	const finalDmg = join(temporary, "bundle-final.dmg");
	try {
		mkdirSync(sourceFolder);
		// ditto preserves the app bundle's resource forks, extended attributes,
		// executable modes, and code signatures while staging the DMG contents.
		run("ditto", [appBundle, stagedApp]);
		symlinkSync("/Applications", join(sourceFolder, "Applications"), "dir");
		run("codesign", ["--verify", "--deep", "--strict", stagedApp]);
		assertVendorSignedBun(join(stagedApp, "Contents/MacOS/bun"));
		runMacosDmgCreate(
			macosDmgCreateArgs(basename(appBundle, ".app"), sourceFolder, finalDmg),
		);
		runMacosDmgVerify(finalDmg);
		copyFileSync(finalDmg, dmg);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const bundleRoot = argument("--bundle-root");
	const target = argument("--target");
	if (!bundleRoot || !target) fail("--bundle-root and --target are required");
	const resolvedBundleRoot = resolve(bundleRoot);
	// A failed finalization must not leave a receipt for an earlier signed app.
	invalidateNativeProductReceipt(resolvedBundleRoot);
	assertNativeProductSourceStable(join(IDE_ROOT, DESKTOP_BUILD_SOURCE_PATH));
	const appBundle = join(resolvedBundleRoot, "macos/ForgeaX Studio.app");
	const vendorBun = macosBunSidecarPath(target);
	if (!existsSync(appBundle) || !existsSync(vendorBun))
		fail("app bundle or staged vendor Bun is missing");
	assertVendorSignedBun(vendorBun);
	restoreVendorBun(appBundle, vendorBun);
	rebuildDmg(singleDmg(resolvedBundleRoot), appBundle);
	const receipt = createNativeProductReceipt({
		platform: "macos",
		productRoot: resolvedBundleRoot,
		executable: join(appBundle, "Contents/MacOS/forgeax-ide-desktop"),
		runtimeManifest: join(
			appBundle,
			"Contents/Resources/resources/runtime/desktop-runtime-manifest.json",
		),
		sourceContext: join(IDE_ROOT, DESKTOP_SOURCE_CONTEXT_PATH),
		buildSource: join(IDE_ROOT, DESKTOP_BUILD_SOURCE_PATH),
		output: join(resolvedBundleRoot, NATIVE_PRODUCT_RECEIPT_NAME),
	});
	console.log(
		JSON.stringify({
			code: "IDE_MACOS_BUNDLE_FINALIZED",
			target,
			bundleRoot: resolvedBundleRoot,
			receipt,
		}),
	);
}

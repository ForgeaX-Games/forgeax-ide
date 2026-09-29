#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyDesktopEngineDependencies } from "./desktop-engine-dependencies";

const REQUIRED_ENTITLEMENT = "com.apple.security.cs.disable-library-validation";
const REQUIRED_BUNDLE_IDENTIFIER = "com.forgeax.ide";
export const REQUIRED_BUN_VENDOR_TEAM = "7FRXF46ZSN";
export const REQUIRED_BUN_VENDOR_AUTHORITY =
	"Authority=Developer ID Application: Jarred Sumner";

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function codesign(args: string[]): string {
	const result = spawnSync("codesign", args, { encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.status !== 0)
		throw new Error(`codesign ${args.join(" ")} failed:\n${output}`);
	return output;
}

export function hasRequiredLibraryValidationEntitlement(
	output: string,
): boolean {
	return (
		output.includes(`<key>${REQUIRED_ENTITLEMENT}</key>`) &&
		/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(
			output,
		)
	);
}

export function hasRequiredBunVendorSignature(output: string): boolean {
	return (
		output.includes(`TeamIdentifier=${REQUIRED_BUN_VENDOR_TEAM}`) &&
		output.includes(REQUIRED_BUN_VENDOR_AUTHORITY) &&
		output.includes("flags=0x10000(runtime)")
	);
}

export function verifyApplicationExecutable(app: string): void {
	const result = spawnSync(
		"/usr/libexec/PlistBuddy",
		["-c", "Print :CFBundleExecutable", join(app, "Contents/Info.plist")],
		{ encoding: "utf8" },
	);
	const executable = result.stdout?.trim();
	if (
		result.status !== 0 ||
		executable !== "forgeax-ide-desktop" ||
		!existsSync(join(app, "Contents/MacOS", executable))
	) {
		throw new Error(
			`application bundle has an invalid IDE executable: ${executable ?? "missing"}`,
		);
	}
}

function verifyAdHocApplication(path: string): void {
	const details = codesign(["-dvvv", path]);
	if (!details.includes("Signature=adhoc"))
		throw new Error("application bundle is not ad-hoc signed");
	if (!details.includes(`Identifier=${REQUIRED_BUNDLE_IDENTIFIER}`)) {
		throw new Error(
			`application bundle does not have the expected identifier ${REQUIRED_BUNDLE_IDENTIFIER}`,
		);
	}
	const entitlements = codesign(["-d", "--entitlements", ":-", path]);
	if (!hasRequiredLibraryValidationEntitlement(entitlements)) {
		throw new Error(`application bundle is missing ${REQUIRED_ENTITLEMENT}`);
	}
}

function verifyVendorBun(path: string): void {
	const details = codesign(["-dvvv", path]);
	if (!hasRequiredBunVendorSignature(details)) {
		throw new Error(
			`bundled Bun runtime is not signed by vendor team ${REQUIRED_BUN_VENDOR_TEAM}`,
		);
	}
}

if (import.meta.main) {
	if (process.platform !== "darwin")
		throw new Error("macOS bundle verification requires macOS");
	const app = resolve(argument("--app") ?? "");
	if (!app.endsWith(".app") || !existsSync(app))
		throw new Error("--app must point to an existing .app bundle");
	const bun = join(app, "Contents/MacOS/bun");
	if (!existsSync(bun)) throw new Error("bundled Bun executable is missing");

	verifyApplicationExecutable(app);

	codesign(["--verify", "--deep", "--strict", "--verbose=4", app]);
	verifyAdHocApplication(app);
	verifyVendorBun(bun);
	verifyDesktopEngineDependencies(join(app, "Contents/Resources/resources"));
	console.log(
		JSON.stringify({
			code: "IDE_MACOS_BUNDLE_VALID",
			app,
			entitlement: REQUIRED_ENTITLEMENT,
		}),
	);
}

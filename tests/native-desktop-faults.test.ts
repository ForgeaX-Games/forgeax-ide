import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
	assessNativeDesktopFaultObservation,
	assessNativeDesktopFaultOracle,
	cleanupNativeDesktopFault,
	NATIVE_DESKTOP_FAULT_DEFINITIONS,
	type NativeDesktopFaultReceipt,
	stageNativeDesktopFaultCopy,
} from "../scripts/native-desktop-faults";
import {
	classifyNativeFaultEarly,
	verifyNativeDesktopResidualHarnessPrecleanup,
} from "../scripts/smoke-native-desktop";

const fixtures: string[] = [];

afterEach(() => {
	for (const path of fixtures.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function createReleaseFixture(): {
	root: string;
	app: string;
	launcher: string;
	sidecar: string;
	plist: string;
} {
	const root = mkdtempSync(join(tmpdir(), "forgeax-native-fault-test-"));
	fixtures.push(root);
	const app = join(root, "ForgeaX Studio.app");
	const resourceRoot = join(app, "Contents", "Resources", "resources");
	const launcher = join(resourceRoot, "runtime", "local-runtime.mjs");
	const sidecar = join(
		resourceRoot,
		"sidecars",
		"runtime-guardian-aarch64-apple-darwin",
	);
	const plist = join(app, "Contents", "Info.plist");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	mkdirSync(join(resourceRoot, "runtime"), { recursive: true });
	mkdirSync(join(resourceRoot, "sidecars"), { recursive: true });
	mkdirSync(join(resourceRoot, "server-runtime"), { recursive: true });
	writeFileSync(
		plist,
		`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>forgeax-ide-desktop</string><key>CFBundleIdentifier</key><string>com.forgeax.ide</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>\n`,
	);
	writeFileSync(
		join(app, "Contents", "MacOS", "forgeax-ide-desktop"),
		"#!/bin/sh\n",
	);
	writeFileSync(launcher, "#!/usr/bin/env bun\nprocess.exit(0);\n", {
		mode: 0o755,
	});
	writeFileSync(
		join(resourceRoot, "server-runtime", "native-preload.mjs"),
		"module.exports = {};\n",
	);
	writeFileSync(sidecar, "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(
		join(resourceRoot, "sidecars", "forgeax-server-aarch64-apple-darwin"),
		"#!/bin/sh\n",
		{ mode: 0o755 },
	);
	if (process.platform === "darwin") {
		const signed = spawnSync(
			"codesign",
			["--force", "--deep", "--sign", "-", app],
			{ encoding: "utf8" },
		);
		if (signed.status !== 0)
			throw new Error(
				`test release fixture could not be ad-hoc signed: ${signed.stderr || signed.stdout}`,
			);
	}
	return { root, app, launcher, sidecar, plist };
}

function stage(
	fixture: ReturnType<typeof createReleaseFixture>,
	scenario: Parameters<typeof stageNativeDesktopFaultCopy>[1],
	projectRoot?: string,
): NativeDesktopFaultReceipt {
	return stageNativeDesktopFaultCopy(fixture.app, scenario, {
		stagingParent: fixture.root,
		projectRoot,
	});
}

async function portAcceptsConnection(port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const finish = (value: boolean): void => {
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitForPortClosed(port: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!(await portAcceptsConnection(port))) return;
		await sleep(20);
	}
	throw new Error(`fixture port remained bound: ${port}`);
}

describe("native desktop fault staging", () => {
	const scenarios = [
		"missing-launcher",
		"sidecar-not-executable",
		"mid-start-failure",
		"readiness-timeout",
		"path-permission",
		"negative-validator",
	] as const;
	for (const scenario of scenarios) {
		test(`stages ${scenario} in a private copy and keeps the source byte identity`, async () => {
			const fixture = createReleaseFixture();
			const sourceBefore = readFileSync(fixture.launcher);
			const receipt = stage(fixture, scenario);
			try {
				expect(receipt.sourceArtifact).toBe(fixture.app);
				expect(receipt.stagingRoot.startsWith(realpathSync(fixture.root))).toBe(
					true,
				);
				expect(receipt.sourceDigest.files).toBeGreaterThan(0);
				expect(receipt.preMutationDigest).toEqual(receipt.sourceDigest);
				if (scenario === "path-permission")
					expect(receipt.sourceDigest).toEqual(receipt.copyDigest);
				else
					expect(receipt.sourceDigest.sha256).not.toBe(
						receipt.copyDigest.sha256,
					);
				expect(readFileSync(fixture.launcher)).toEqual(sourceBefore);
				expect(receipt.signature.source).toBe("preserved-source");
				if (scenario === "missing-launcher") {
					expect(
						existsSync(
							join(
								receipt.copyArtifact,
								"Contents/Resources/resources/runtime/local-runtime.mjs",
							),
						),
					).toBe(false);
					expect(receipt.signature.policy).toBe("resign-runtime-fault");
					if (process.platform === "darwin")
						expect(receipt.signature.copy).toBe("re-signed-for-runtime-fault");
				}
				if (scenario === "sidecar-not-executable") {
					expect(
						statSync(
							join(
								receipt.copyArtifact,
								"Contents/Resources/resources/sidecars/runtime-guardian-aarch64-apple-darwin",
							),
						).mode & 0o111,
					).toBe(0);
					expect(receipt.signature.policy).toBe("resign-runtime-fault");
				}
				if (scenario === "path-permission") {
					const permissionFixture = receipt.projectPermissionFixture;
					expect(permissionFixture).toBeDefined();
					expect(permissionFixture?.path).toBe(
						join(receipt.stagingRoot, "isolated-project", ".forgeax"),
					);
					expect(statSync(permissionFixture!.path).mode & 0o200).toBe(0);
					expect(
						statSync(
							join(
								receipt.copyArtifact,
								"Contents/Resources/resources/runtime/local-runtime.mjs",
							),
						).mode & 0o444,
					).not.toBe(0);
					expect(receipt.signature.policy).toBe("permission-only");
					if (process.platform === "darwin")
						expect(receipt.signature.verify).toMatchObject({
							attempted: true,
							passed: true,
						});
				}
				if (scenario === "negative-validator") {
					expect(readFileSync(fixture.plist, "utf8")).toContain(
						"com.forgeax.ide",
					);
					expect(
						readFileSync(
							join(receipt.copyArtifact, "Contents/Info.plist"),
							"utf8",
						),
					).toContain("com.forgeax.native-fault");
					expect(receipt.signature.copy).toBe("invalidated-by-mutation");
				}
				if (
					scenario === "mid-start-failure" ||
					scenario === "readiness-timeout"
				) {
					expect(receipt.signature.policy).toBe("resign-runtime-fault");
					if (process.platform === "darwin") {
						expect(receipt.signature.copy).toBe("re-signed-for-runtime-fault");
						expect(receipt.signature.verify).toMatchObject({
							attempted: true,
							passed: true,
						});
						expect(receipt.signature.sourceIdentity).toBeDefined();
						expect(receipt.signature.copyIdentity).toBeDefined();
					} else expect(receipt.signature.copy).toBe("not-applicable");
				}
			} finally {
				await cleanupNativeDesktopFault(receipt);
			}
		}, 15_000);
	}

	test("mid-start mutation retains the production launcher and disables only the later server sidecar", async () => {
		const fixture = createReleaseFixture();
		const receipt = stage(fixture, "mid-start-failure");
		try {
			expect(receipt.evidenceKind).toBe("native-product");
			expect(receipt.mutation.path).toContain("forgeax-server");
			expect(
				readFileSync(
					join(
						receipt.copyArtifact,
						"Contents/Resources/resources/runtime/local-runtime.mjs",
					),
				),
			).toEqual(readFileSync(fixture.launcher));
			expect(
				statSync(join(receipt.copyArtifact, receipt.mutation.path)).mode &
					0o111,
			).toBe(0);
		} finally {
			await cleanupNativeDesktopFault(receipt);
		}
	});

	test("path-permission keeps the signed artifact intact and restores only its created project fixture", async () => {
		const fixture = createReleaseFixture();
		const projectRoot = join(fixture.root, "fault-project");
		mkdirSync(projectRoot, { recursive: true });
		const receipt = stage(fixture, "path-permission", projectRoot);
		const permissionFixture = receipt.projectPermissionFixture;
		expect(permissionFixture).toBeDefined();
		expect(receipt.copyDigest).toEqual(receipt.sourceDigest);
		expect(
			readFileSync(
				join(
					receipt.copyArtifact,
					"Contents/Resources/resources/runtime/local-runtime.mjs",
				),
			),
		).toEqual(readFileSync(fixture.launcher));
		expect(statSync(permissionFixture!.path).mode & 0o200).toBe(0);
		await cleanupNativeDesktopFault(receipt);
		expect(existsSync(permissionFixture!.path)).toBe(false);
		expect(existsSync(projectRoot)).toBe(true);
	}, 15_000);

	test("rolls back the staging directory when a mutation cannot be completed", () => {
		const fixture = createReleaseFixture();
		rmSync(fixture.launcher);
		const parent = mkdtempSync(
			join(tmpdir(), "forgeax-native-fault-rollback-"),
		);
		try {
			expect(() =>
				stageNativeDesktopFaultCopy(fixture.app, "missing-launcher", {
					stagingParent: parent,
				}),
			).toThrow("no bundled runtime launcher");
			expect(readdirSync(parent)).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("readiness fault preserves the production launcher and patches only the real server preload", async () => {
		const fixture = createReleaseFixture();
		const receipt = stage(fixture, "readiness-timeout");
		try {
			expect(
				readFileSync(
					join(
						receipt.copyArtifact,
						"Contents/Resources/resources/runtime/local-runtime.mjs",
					),
				),
			).toEqual(readFileSync(fixture.launcher));
			expect(receipt.mutation.path).toBe(
				"Contents/Resources/resources/server-runtime/native-preload.mjs",
			);
			expect(
				readFileSync(join(receipt.copyArtifact, receipt.mutation.path), "utf8"),
			).toContain("FORGEAX_NATIVE_FAULT_READINESS_503");
		} finally {
			await cleanupNativeDesktopFault(receipt);
		}
	});

	test("residual runtime cleanup removes only the receipt-owned unchanged state", async () => {
		const fixture = createReleaseFixture();
		const projectRoot = join(fixture.root, "isolated-project");
		const receipt = stage(fixture, "residual-runtime", projectRoot);
		expect(receipt.residualStatePath).toBeDefined();
		const residual = receipt.residualFixture;
		const residualPid = residual === undefined ? -1 : residual.pid;
		const residualPort = residual === undefined ? -1 : residual.port;
		expect(typeof residualPid).toBe("number");
		expect(typeof residualPort).toBe("number");
		expect(residualPid).toBeGreaterThan(0);
		expect(residualPort).toBeGreaterThan(0);
		expect(residualPort).toBeLessThanOrEqual(65_535);
		expect(await portAcceptsConnection(residualPort)).toBe(true);
		expect(
			JSON.parse(readFileSync(receipt.residualStatePath!, "utf8")),
		).toMatchObject({
			launcherPid: residualPid,
			managedPorts: { server: residualPort },
		});
		expect(existsSync(receipt.residualStatePath!)).toBe(true);
		const precleanup =
			await verifyNativeDesktopResidualHarnessPrecleanup(receipt);
		expect(
			precleanup.process.liveMembers.some(
				(member) => member.pid === residualPid,
			),
		).toBe(true);
		expect(precleanup.portErrors.length).toBeGreaterThan(0);
		const evidence = await cleanupNativeDesktopFault(receipt);
		expect(evidence).toEqual({
			stateRemoved: true,
			fixturePidReleased: true,
			fixturePortReleased: true,
		});
		await waitForPortClosed(residualPort);
		expect(existsSync(receipt.residualStatePath!)).toBe(false);
		expect(existsSync(fixture.app)).toBe(true);
	});

	test("refuses cleanup after a residual diagnostic was changed by another writer", async () => {
		const fixture = createReleaseFixture();
		const receipt = stage(
			fixture,
			"residual-runtime",
			join(fixture.root, "isolated-project"),
		);
		const residual = receipt.residualFixture;
		const residualPort = residual === undefined ? -1 : residual.port;
		writeFileSync(
			receipt.residualStatePath!,
			`${readFileSync(receipt.residualStatePath!, "utf8")}changed\n`,
		);
		await expect(cleanupNativeDesktopFault(receipt)).rejects.toThrow(
			"refusing to remove changed residual state",
		);
		await waitForPortClosed(residualPort);
		expect(existsSync(receipt.residualStatePath!)).toBe(true);
		rmSync(receipt.stagingRoot, { recursive: true, force: true });
	});
});

describe("native desktop fault evidence", () => {
	test("classifies exact Tauri setup permission errors without accepting a timeout or driver error", () => {
		const raw =
			"native app exited before runtime state: code=1 signal=SIGABRT stderr=Failed to setup app: error encountered during setup hook: Permission denied (os error 13)";
		expect(classifyNativeFaultEarly("sidecar-not-executable", raw)).toEqual({
			phase: "preflight",
			code: "SIDECAR_NOT_EXECUTABLE",
		});
		expect(classifyNativeFaultEarly("path-permission", raw)).toEqual({
			phase: "preflight",
			code: "PATH_PERMISSION_DENIED",
		});
		expect(
			classifyNativeFaultEarly(
				"path-permission",
				"failed runtime state did not complete before its deadline",
			),
		).toBeUndefined();
	});

	test("validator and residual scenarios are harness controls, never product-failure evidence", () => {
		expect(
			NATIVE_DESKTOP_FAULT_DEFINITIONS.find(
				(item) => item.scenario === "negative-validator",
			)?.evidenceKind,
		).toBe("harness-control");
		expect(
			NATIVE_DESKTOP_FAULT_DEFINITIONS.find(
				(item) => item.scenario === "residual-runtime",
			)?.evidenceKind,
		).toBe("harness-control");
	});

	test("requires the scenario-specific phase, code, signature class, diagnostics and cleanup evidence", () => {
		const receipt = {
			scenario: "missing-launcher",
			evidenceKind: "native-product",
			phase: "preflight",
			code: "MISSING_LAUNCHER",
			signature: { policy: "resign-runtime-fault" },
		} as const;
		const cleanup = {
			stateRemoved: true,
			fixturePidReleased: true,
			fixturePortReleased: true,
		} as const;
		expect(
			assessNativeDesktopFaultOracle(receipt, {
				phase: "preflight",
				code: "MISSING_LAUNCHER",
				productError: "MISSING_LAUNCHER injected",
				diagnosticsWritten: true,
				cleanup,
			}).verdict,
		).toBe("product-failure-confirmed");
		expect(
			assessNativeDesktopFaultOracle(receipt, {
				phase: "preflight",
				code: "WRONG",
				productError: "MISSING_LAUNCHER injected",
				diagnosticsWritten: true,
				cleanup,
			}).verdict,
		).not.toBe("product-failure-confirmed");
		expect(
			assessNativeDesktopFaultOracle(receipt, {
				phase: "preflight",
				code: "MISSING_LAUNCHER",
				productError: "MISSING_LAUNCHER injected",
				diagnosticsWritten: false,
				cleanup,
			}).verdict,
		).not.toBe("product-failure-confirmed");
	});

	test("accepts a classifier-derived code while retaining the unmodified product error", () => {
		const receipt = {
			scenario: "mid-start-failure",
			evidenceKind: "native-product",
			phase: "startup",
			code: "STARTUP_FAILURE",
			signature: { policy: "resign-runtime-fault" },
		} as const;
		const cleanup = {
			stateRemoved: true,
			fixturePidReleased: true,
			fixturePortReleased: true,
		} as const;
		expect(
			assessNativeDesktopFaultOracle(receipt, {
				phase: "startup",
				code: "STARTUP_FAILURE",
				productError: "packaged runtime service server exited before readiness",
				diagnosticsWritten: true,
				cleanup,
			}).verdict,
		).toBe("product-failure-confirmed");
	});

	test("does not turn a driver-only failure into product failure", () => {
		const result = assessNativeDesktopFaultObservation({
			driverFailure: "Mac2 session creation timed out",
			diagnosticsWritten: true,
			cleanupVerified: true,
		});
		expect(result).toMatchObject({
			verdict: "driver-failure-only",
			productFailure: false,
			driverFailure: true,
		});
		expect(
			result.errors.some((error) =>
				error.includes("not product failure evidence"),
			),
		).toBe(true);
	});

	test("requires diagnostics and verified cleanup before accepting product fault evidence", () => {
		expect(
			assessNativeDesktopFaultObservation({
				productFailure: { phase: "readiness", code: "READINESS_TIMEOUT" },
				diagnosticsWritten: true,
				cleanupVerified: true,
			}).verdict,
		).toBe("product-failure-confirmed");
		expect(
			assessNativeDesktopFaultObservation({
				productFailure: { phase: "startup" },
				diagnosticsWritten: false,
				cleanupVerified: false,
			}).verdict,
		).toBe("cleanup-failure");
		const missingDiagnostics = assessNativeDesktopFaultObservation({
			productFailure: { phase: "startup" },
			diagnosticsWritten: false,
			cleanupVerified: true,
		});
		expect(missingDiagnostics.verdict).toBe("incomplete-evidence");
		expect(missingDiagnostics.productFailure).toBe(false);
		const cleanupError = assessNativeDesktopFaultObservation({
			productFailure: { phase: "readiness" },
			diagnosticsWritten: true,
			cleanupVerified: true,
			cleanupErrors: ["runtime port remained bound"],
		});
		expect(cleanupError.verdict).toBe("cleanup-failure");
		expect(cleanupError.productFailure).toBe(false);
		expect(
			assessNativeDesktopFaultObservation({
				diagnosticsWritten: true,
				cleanupVerified: true,
			}).verdict,
		).toBe("unexpected-success");
	});
});

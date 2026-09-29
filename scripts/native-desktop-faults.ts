import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Faults used by the native product acceptance run.  Every fault is staged in
 * a private copy of the release artifact; the source package is never edited.
 */
export const NATIVE_DESKTOP_FAULT_SCENARIOS = [
	"missing-launcher",
	"sidecar-not-executable",
	"mid-start-failure",
	"readiness-timeout",
	"path-permission",
	"negative-validator",
	"residual-runtime",
] as const;

export type NativeDesktopFaultScenario =
	(typeof NATIVE_DESKTOP_FAULT_SCENARIOS)[number];
export type NativeDesktopFaultPhase =
	| "preflight"
	| "startup"
	| "readiness"
	| "validator"
	| "cleanup";

export type NativeDesktopFaultDefinition = {
	readonly scenario: NativeDesktopFaultScenario;
	readonly phase: NativeDesktopFaultPhase;
	readonly code: string;
	readonly description: string;
	readonly evidenceKind: "native-product" | "harness-control";
};

export type NativeDesktopFaultSignaturePolicy =
	| "auto"
	| "resign-runtime-fault"
	| "signature-rejection"
	| "permission-only";

export const NATIVE_DESKTOP_FAULT_DEFINITIONS: readonly NativeDesktopFaultDefinition[] =
	[
		{
			scenario: "missing-launcher",
			phase: "preflight",
			code: "MISSING_LAUNCHER",
			description:
				"remove the bundled runtime launcher from an isolated artifact copy",
			evidenceKind: "native-product",
		},
		{
			scenario: "sidecar-not-executable",
			phase: "preflight",
			code: "SIDECAR_NOT_EXECUTABLE",
			description: "remove execute bits from a bundled runtime sidecar",
			evidenceKind: "native-product",
		},
		{
			scenario: "mid-start-failure",
			phase: "startup",
			code: "STARTUP_FAILURE",
			description:
				"remove execute permission from the later forgeax-server sidecar while retaining the production launcher and earlier services",
			evidenceKind: "native-product",
		},
		{
			scenario: "readiness-timeout",
			phase: "readiness",
			code: "READINESS_TIMEOUT",
			description:
				"keep the production launcher and make the real bundled server health endpoint answer HTTP 503 until its production readiness deadline",
			evidenceKind: "native-product",
		},
		{
			scenario: "path-permission",
			phase: "preflight",
			code: "PATH_PERMISSION_DENIED",
			description:
				"make a receipt-owned isolated project .forgeax directory non-writable while preserving the signed artifact",
			evidenceKind: "native-product",
		},
		{
			scenario: "negative-validator",
			phase: "validator",
			code: "INVALID_PRODUCT_IDENTITY",
			description:
				"change the product identity in an isolated bundle copy and assert the verifier rejects it",
			evidenceKind: "harness-control",
		},
		{
			scenario: "residual-runtime",
			phase: "cleanup",
			code: "RESIDUAL_RUNTIME",
			description:
				"create a stale PID-qualified runtime state owned by this fixture",
			evidenceKind: "harness-control",
		},
	] as const;

type FaultMutation = {
	readonly operation: "remove" | "chmod" | "replace" | "write";
	readonly path: string;
	readonly beforeSha256?: string;
	readonly afterSha256?: string;
	readonly beforeMode?: number;
	readonly afterMode?: number;
	readonly detail: string;
};

export type ArtifactDigest = {
	readonly sha256: string;
	readonly files: number;
	readonly executableFiles: number;
};

type InventoryDigest = ArtifactDigest & {
	readonly fileHashes: ReadonlyMap<string, string>;
};

export type NativeDesktopFaultReceipt = {
	readonly schema: "forgeax-native-desktop-fault/v1";
	readonly scenario: NativeDesktopFaultScenario;
	readonly phase: NativeDesktopFaultPhase;
	readonly code: string;
	readonly evidenceKind: NativeDesktopFaultDefinition["evidenceKind"];
	readonly sourceArtifact: string;
	readonly copyArtifact: string;
	readonly stagingRoot: string;
	readonly sourceDigest: ArtifactDigest;
	/** Strict byte/mode inventory equality immediately after copy, before mutation. */
	readonly preMutationDigest: ArtifactDigest;
	readonly copyDigest: ArtifactDigest;
	readonly mutation: FaultMutation;
	readonly signature: {
		readonly source: "preserved-source";
		readonly copy:
			| "unchanged"
			| "invalidated-by-mutation"
			| "re-signed-for-runtime-fault"
			| "not-applicable";
		readonly policy: Exclude<NativeDesktopFaultSignaturePolicy, "auto">;
		readonly sourceIdentity?: NativeDesktopCodeSignatureIdentity;
		readonly copyIdentity?: NativeDesktopCodeSignatureIdentity;
		readonly verify: {
			readonly attempted: boolean;
			readonly passed: boolean;
			readonly detail: string;
		};
		readonly reason: string;
	};
	readonly ownedPaths: readonly string[];
	/** A project-root fixture created only for path-permission and restored before removal. */
	readonly projectPermissionFixture?: {
		readonly path: string;
		readonly beforeMode: number;
		readonly afterMode: number;
	};
	readonly residualStatePath?: string;
	readonly residualStateSha256?: string;
	readonly residualFixture?: { readonly pid: number; readonly port: number };
};

export type StageNativeDesktopFaultOptions = {
	/** Existing private directory in which a new fault staging directory is created. */
	readonly stagingParent?: string;
	/** Isolated project root for the residual-runtime case. */
	readonly projectRoot?: string;
	/**
	 * `auto` re-signs intended runtime-fault copies on macOS and treats other
	 * byte-mutating faults as explicit signature-rejection cases.
	 */
	readonly signaturePolicy?: NativeDesktopFaultSignaturePolicy;
};

export type NativeDesktopCodeSignatureIdentity = {
	readonly identifier?: string;
	readonly teamIdentifier?: string;
	readonly authorities: readonly string[];
};

const LAUNCHER_RELATIVE_CANDIDATES = [
	"Contents/Resources/resources/runtime/local-runtime.mjs",
	"resources/runtime/local-runtime.mjs",
] as const;

const residualFixtures = new Map<string, ChildProcessWithoutNullStreams>();

function definitionFor(
	scenario: NativeDesktopFaultScenario,
): NativeDesktopFaultDefinition {
	const definition = NATIVE_DESKTOP_FAULT_DEFINITIONS.find(
		(item) => item.scenario === scenario,
	);
	if (!definition)
		throw new Error(`unknown native desktop fault scenario: ${scenario}`);
	return definition;
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function modeOf(path: string): number {
	return lstatSync(path).mode & 0o777;
}

function portableRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function assertDirectory(path: string, label: string): void {
	if (!existsSync(path) || !statSync(path).isDirectory())
		throw new Error(`${label} must be an existing directory: ${path}`);
}

function assertNoSymlink(path: string, label: string): void {
	if (lstatSync(path).isSymbolicLink())
		throw new Error(`${label} may not be a symbolic link: ${path}`);
}

function inventoryDigest(
	root: string,
	fallbackFileHashes?: ReadonlyMap<string, string>,
): InventoryDigest {
	const rows: string[] = [];
	const fileHashes = new Map<string, string>();
	let files = 0;
	let executableFiles = 0;
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		)) {
			const absolute = join(directory, entry.name);
			const relativePath = portableRelative(root, absolute);
			if (entry.isSymbolicLink())
				throw new Error(
					`fault artifacts may not contain symlinks: ${relativePath}`,
				);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) {
				const mode = modeOf(absolute);
				let contentHash: string;
				try {
					contentHash = sha256(readFileSync(absolute));
				} catch (error) {
					const fallback = fallbackFileHashes?.get(relativePath);
					if (!fallback)
						throw new Error(
							`cannot hash fault artifact file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
							{ cause: error },
						);
					// A permission fault intentionally makes the bytes unreadable. The
					// pre-mutation digest is the only safe content identity available;
					// the changed mode is still included in the enclosing inventory.
					contentHash = fallback;
				}
				fileHashes.set(relativePath, contentHash);
				rows.push(
					`${relativePath}\u0000${mode.toString(8)}\u0000${contentHash}`,
				);
				files += 1;
				if ((mode & 0o111) !== 0) executableFiles += 1;
			} else
				throw new Error(`unsupported fault artifact entry: ${relativePath}`);
		}
	};
	visit(root);
	return {
		sha256: sha256(rows.join("\n")),
		files,
		executableFiles,
		fileHashes,
	};
}

function copyArtifact(source: string, destination: string): void {
	cpSync(source, destination, {
		recursive: true,
		force: false,
		errorOnExist: true,
		preserveTimestamps: true,
	});
	assertDirectory(destination, "fault artifact copy");
}

function resourceRoot(artifact: string): string {
	const bundled = join(artifact, "Contents", "Resources", "resources");
	if (existsSync(bundled)) return bundled;
	const flat = join(artifact, "resources");
	if (existsSync(flat)) return flat;
	throw new Error(
		`release artifact has no bundled resources directory: ${artifact}`,
	);
}

function launcherPath(artifact: string): string {
	for (const candidate of LAUNCHER_RELATIVE_CANDIDATES) {
		const path = join(artifact, candidate);
		if (existsSync(path)) {
			assertNoSymlink(path, "runtime launcher");
			return path;
		}
	}
	throw new Error(
		`release artifact has no bundled runtime launcher: ${artifact}`,
	);
}

function sidecarPath(artifact: string): string {
	const root = join(resourceRoot(artifact), "sidecars");
	assertDirectory(root, "bundled sidecar directory");
	const names = readdirSync(root)
		.filter((name) => !name.startsWith("."))
		.sort();
	const selected =
		names.find((name) => name.startsWith("runtime-guardian-")) ??
		names.find((name) => name.startsWith("bun-")) ??
		names.find((name) => name.startsWith("forgeax-server-"));
	if (!selected)
		throw new Error(`release artifact has no runtime sidecar: ${root}`);
	const path = join(root, selected);
	assertNoSymlink(path, "runtime sidecar");
	if (!statSync(path).isFile())
		throw new Error(`runtime sidecar is not a file: ${path}`);
	return path;
}

function serverSidecarPath(artifact: string): string {
	const root = join(resourceRoot(artifact), "sidecars");
	const selected = readdirSync(root)
		.filter((name) => /^forgeax-server(?:-|$)/.test(name))
		.sort()[0];
	if (!selected)
		throw new Error(`release artifact has no forgeax-server sidecar: ${root}`);
	const path = join(root, selected);
	assertNoSymlink(path, "forgeax-server sidecar");
	if (!statSync(path).isFile())
		throw new Error(`forgeax-server sidecar is not a file: ${path}`);
	return path;
}

function productIdentityPath(artifact: string): string {
	const path = join(artifact, "Contents", "Info.plist");
	if (existsSync(path)) {
		assertNoSymlink(path, "product identity");
		return path;
	}
	const manifest = join(artifact, "manifest.json");
	if (existsSync(manifest)) {
		assertNoSymlink(manifest, "artifact manifest");
		return manifest;
	}
	throw new Error(
		`release artifact has no validator identity file: ${artifact}`,
	);
}

function runtimeDirectoryFor(projectRoot: string): string {
	const path = join(resolve(projectRoot), ".forgeax", "runtime");
	const base = resolve(projectRoot);
	const relativePath = relative(base, path);
	if (!relativePath || relativePath.startsWith(`..${sep}`))
		throw new Error(`residual runtime path escaped project root: ${path}`);
	return path;
}

function statePathFor(projectRoot: string, pid: number): string {
	if (!Number.isSafeInteger(pid) || pid <= 0)
		throw new Error(`residual fixture PID must be a positive integer: ${pid}`);
	return join(runtimeDirectoryFor(projectRoot), `desktop-prod-${pid}.json`);
}

type ResidualFixture = {
	readonly child: ChildProcessWithoutNullStreams;
	readonly pid: number;
	readonly port: number;
};

function startResidualFixture(runtimeDirectory: string): ResidualFixture {
	const readyPath = join(
		runtimeDirectory,
		`residual-ready-${process.pid}-${Date.now()}.json`,
	);
	const source = [
		"const fs = require('node:fs');",
		"const net = require('node:net');",
		"const ready = process.argv[1];",
		"const server = net.createServer(() => {});",
		"server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') process.exit(91); fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, port: address.port })); });",
		"const stop = () => server.close(() => process.exit(0));",
		"process.on('SIGTERM', stop); process.on('SIGINT', stop);",
		"setInterval(() => {}, 1000);",
	].join("\n");
	const child = spawn(process.execPath, ["-e", source, readyPath], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (
		typeof child.pid !== "number" ||
		!Number.isSafeInteger(child.pid) ||
		child.pid <= 0
	)
		throw new Error("residual fixture did not provide a process identity");
	const deadline = Date.now() + 2_000;
	while (!existsSync(readyPath) && Date.now() < deadline)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	if (!existsSync(readyPath)) {
		try {
			child.kill("SIGTERM");
		} catch {
			/* fixture may have exited */
		}
		throw new Error(
			"residual fixture did not publish a ready listener before the deadline",
		);
	}
	const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
		pid?: number;
		port?: number;
	};
	rmSync(readyPath, { force: true });
	const port = ready.port;
	if (
		ready.pid !== child.pid ||
		typeof port !== "number" ||
		!Number.isSafeInteger(port) ||
		port <= 0 ||
		port > 65_535
	) {
		try {
			child.kill("SIGTERM");
		} catch {
			/* fixture may have exited */
		}
		throw new Error(
			`residual fixture published invalid ownership data: ${JSON.stringify(ready)}`,
		);
	}
	return { child, pid: child.pid, port };
}

function assertPortReleased(port: number): void {
	const source = [
		"const net = require('node:net');",
		"const port = Number(process.argv[1]);",
		"const server = net.createServer();",
		"server.once('error', error => { console.error(String(error)); process.exit(2); });",
		"server.listen(port, '127.0.0.1', () => server.close(error => process.exit(error ? 3 : 0)));",
	].join("\n");
	const result = spawnSync(process.execPath, ["-e", source, String(port)], {
		encoding: "utf8",
		timeout: 2_000,
	});
	if (result.status !== 0 || result.error)
		throw new Error(
			`receipt-owned residual listener port ${port} remained bound: ${result.error?.message ?? result.stderr.trim()}`,
		);
}

/** Synchronous staging rollback still has to prove the child is gone before its fixture is removed. */
function stopResidualFixtureForRollback(
	child: ChildProcessWithoutNullStreams,
	port?: number,
): void {
	if (
		child.exitCode === null &&
		child.signalCode === null &&
		!child.kill("SIGTERM")
	) {
		throw new Error(
			`could not request rollback shutdown for receipt-owned residual fixture ${child.pid ?? "unknown"}`,
		);
	}
	const pid = child.pid;
	if (!pid)
		throw new Error(
			"receipt-owned residual fixture had no PID during rollback",
		);
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const probe = spawnSync("/bin/kill", ["-0", String(pid)], {
			stdio: "ignore",
			timeout: 500,
		});
		if (probe.status !== 0) {
			if (port !== undefined) assertPortReleased(port);
			return;
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
	}
	throw new Error(
		`receipt-owned residual fixture did not exit during rollback: ${pid}`,
	);
}

async function stopResidualFixture(
	statePath: string,
	fixture: { readonly pid: number; readonly port: number },
): Promise<void> {
	const child = residualFixtures.get(statePath);
	residualFixtures.delete(statePath);
	if (!child)
		throw new Error(
			`receipt-owned residual fixture handle is unavailable: ${fixture.pid}`,
		);
	if (child.pid !== fixture.pid)
		throw new Error(
			`receipt-owned residual fixture identity no longer matches its child handle: ${fixture.pid}`,
		);
	if (
		child.exitCode === null &&
		child.signalCode === null &&
		!child.kill("SIGTERM")
	)
		throw new Error(
			`could not request receipt-owned residual fixture shutdown: ${fixture.pid}`,
		);
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			assertPortReleased(fixture.port);
			return;
		}
		await sleep(10);
	}
	throw new Error(
		`receipt-owned residual fixture did not exit after SIGTERM: ${fixture.pid}`,
	);
}

/**
 * This is appended to the copied server preload, never substituted for the
 * runtime launcher.  The real packaged server still binds its own port and
 * receives this request; only its /api/health reply is changed to 503.
 */
function readinessTimeoutPreloadPatch(): string {
	return `
// forgeax native fault: preserve the production launcher and exercise its real readiness loop.
{
  const originalServe = Bun.serve.bind(Bun);
  Bun.serve = ((options) => {
    const originalFetch = options.fetch;
    return originalServe({ ...options, fetch(request, server) {
      if (new URL(request.url).pathname === '/api/health') {
        return new Response(JSON.stringify({ code: 'FORGEAX_NATIVE_FAULT_READINESS_503' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch.call(this, request, server);
    } });
  });
}
`;
}

function mutateIdentity(path: string): { before: string; after: string } {
	const source = readFileSync(path, "utf8");
	let replacement = source;
	if (path.endsWith(".plist")) {
		replacement = source.replace("com.forgeax.ide", "com.forgeax.native-fault");
		if (replacement === source)
			throw new Error(
				`product identity does not contain the expected bundle identifier: ${path}`,
			);
	} else {
		replacement = `${source}\n{"nativeFault":"invalid-product-identity"}\n`;
	}
	return { before: source, after: replacement };
}

type CodeSignResult = {
	readonly status: number | null;
	readonly output: string;
	readonly error?: string;
};

function runCodesign(args: readonly string[]): CodeSignResult {
	const result = spawnSync("codesign", [...args], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
		...(result.error ? { error: result.error.message } : {}),
	};
}

function parseCodeSignatureIdentity(
	output: string,
): NativeDesktopCodeSignatureIdentity {
	const identifier = output.match(/(?:^|\n)Identifier=(.+)/)?.[1]?.trim();
	const teamIdentifier = output
		.match(/(?:^|\n)TeamIdentifier=(.+)/)?.[1]
		?.trim();
	const authorities = [...output.matchAll(/(?:^|\n)Authority=(.+)/g)].map(
		(match) => match[1].trim(),
	);
	return {
		...(identifier ? { identifier } : {}),
		...(teamIdentifier ? { teamIdentifier } : {}),
		authorities,
	};
}

function signatureIdentity(path: string): NativeDesktopCodeSignatureIdentity {
	const result = runCodesign(["-dvvv", path]);
	if (result.status !== 0)
		throw new Error(
			`could not inspect product code signature for ${path}: ${result.error ?? (result.output || "codesign failed")}`,
		);
	return parseCodeSignatureIdentity(result.output);
}

function verifyCodeSignature(path: string): CodeSignResult {
	return runCodesign(["--verify", "--deep", "--strict", "--verbose=4", path]);
}

function preservedApplicationEntitlements(
	sourceArtifact: string,
	copyArtifact: string,
): string | undefined {
	const result = runCodesign(["-d", "--entitlements", ":-", sourceArtifact]);
	if (result.status !== 0) return undefined;
	const xml = result.output.slice(result.output.indexOf("<?xml")).trim();
	if (!xml.startsWith("<?xml") || !xml.includes("</plist>")) return undefined;
	const path = join(
		resolve(copyArtifact, ".."),
		"preserved-source-entitlements.plist",
	);
	writeFileSync(
		path,
		`${xml.slice(0, xml.indexOf("</plist>") + "</plist>".length)}\n`,
		{ mode: 0o600 },
	);
	return path;
}

function resolveSignaturePolicy(
	scenario: NativeDesktopFaultScenario,
	requested: NativeDesktopFaultSignaturePolicy | undefined,
): Exclude<NativeDesktopFaultSignaturePolicy, "auto"> {
	if (requested && requested !== "auto") return requested;
	if (scenario === "negative-validator") return "signature-rejection";
	if (scenario === "residual-runtime" || scenario === "path-permission")
		return "permission-only";
	// Resource mutations seal the bundle on macOS. Re-sign every scenario that
	// is meant to reach Tauri/runtime preflight; signature rejection is its own
	// validator case and cannot stand in for these product faults.
	return "resign-runtime-fault";
}

type SignatureAssessment = {
	readonly copy: NativeDesktopFaultReceipt["signature"]["copy"];
	readonly policy: Exclude<NativeDesktopFaultSignaturePolicy, "auto">;
	readonly sourceIdentity?: NativeDesktopCodeSignatureIdentity;
	readonly copyIdentity?: NativeDesktopCodeSignatureIdentity;
	readonly verify: {
		readonly attempted: boolean;
		readonly passed: boolean;
		readonly detail: string;
	};
	readonly reason: string;
};

function assessSignature(
	sourceArtifact: string,
	copyArtifact: string,
	scenario: NativeDesktopFaultScenario,
	requestedPolicy: NativeDesktopFaultSignaturePolicy | undefined,
): SignatureAssessment {
	const policy = resolveSignaturePolicy(scenario, requestedPolicy);
	if (scenario === "residual-runtime") {
		return {
			copy: "not-applicable",
			policy,
			verify: {
				attempted: false,
				passed: false,
				detail:
					"residual-runtime creates external fixture state and does not mutate the artifact",
			},
			reason: "the artifact bytes were not changed",
		};
	}
	if (process.platform !== "darwin") {
		return {
			copy:
				policy === "resign-runtime-fault"
					? "not-applicable"
					: signatureAfterMutation(scenario),
			policy,
			verify: {
				attempted: false,
				passed: false,
				detail: "macOS codesign verification is unavailable on this host",
			},
			reason:
				policy === "resign-runtime-fault"
					? "runtime-fault signing is deferred to the macOS native acceptance host"
					: "signature semantics are recorded without invoking macOS codesign",
		};
	}
	const sourceVerification = verifyCodeSignature(sourceArtifact);
	if (sourceVerification.status !== 0)
		throw new Error(
			`source artifact must have a verifiable macOS signature before fault staging: ${sourceVerification.output || sourceVerification.error || "codesign failed"}`,
		);
	const sourceIdentity = signatureIdentity(sourceArtifact);
	if (policy === "permission-only") {
		const copyVerification = verifyCodeSignature(copyArtifact);
		return {
			copy:
				copyVerification.status === 0 ? "unchanged" : "invalidated-by-mutation",
			policy,
			sourceIdentity,
			verify: {
				attempted: true,
				passed: copyVerification.status === 0,
				detail:
					copyVerification.output ||
					copyVerification.error ||
					"signature verification completed",
			},
			reason:
				copyVerification.status === 0
					? "only launchability or permissions changed; signature verdict is separate from runtime fault"
					: "the permission mutation also invalidated the bundle signature; treat that rejection separately from runtime behavior",
		};
	}
	if (policy === "signature-rejection") {
		const copyVerification = verifyCodeSignature(copyArtifact);
		if (copyVerification.status === 0)
			throw new Error(
				`fault copy unexpectedly passed macOS signature verification for an intentional signature-rejection scenario: ${copyArtifact}`,
			);
		return {
			copy: "invalidated-by-mutation",
			policy,
			sourceIdentity,
			verify: {
				attempted: true,
				passed: false,
				detail:
					copyVerification.output ||
					copyVerification.error ||
					"signature verification rejected the mutated copy",
			},
			reason:
				"this copy is intentionally left unsigned after mutation; signature rejection is a separate failure class",
		};
	}
	// Re-seal only the outer application. `--deep` would ad-hoc re-sign the
	// vendor-signed bundled Bun runtime and invalidate the release verifier.
	const entitlements = preservedApplicationEntitlements(
		sourceArtifact,
		copyArtifact,
	);
	const resign = runCodesign([
		"--force",
		"--sign",
		"-",
		...(entitlements ? ["--entitlements", entitlements] : []),
		copyArtifact,
	]);
	if (resign.status !== 0)
		throw new Error(
			`could not ad-hoc re-sign runtime fault copy: ${resign.output || resign.error || "codesign failed"}`,
		);
	const copyVerification = verifyCodeSignature(copyArtifact);
	if (copyVerification.status !== 0)
		throw new Error(
			`re-signed runtime fault copy failed macOS signature verification: ${copyVerification.output || copyVerification.error || "codesign failed"}`,
		);
	const copyIdentity = signatureIdentity(copyArtifact);
	return {
		copy: "re-signed-for-runtime-fault",
		policy,
		sourceIdentity,
		copyIdentity,
		verify: {
			attempted: true,
			passed: true,
			detail: copyVerification.output || "re-signed copy verified",
		},
		reason:
			"the mutated runtime fixture was ad-hoc re-signed so the native launch reaches the intended runtime failure",
	};
}

function signatureAfterMutation(
	scenario: NativeDesktopFaultScenario,
): NativeDesktopFaultReceipt["signature"]["copy"] {
	if (scenario === "residual-runtime") return "not-applicable";
	// The launcher is a sealed bundle resource, so removing it changes the
	// resource set even though no executable bytes were rewritten.
	if (scenario === "missing-launcher") return "invalidated-by-mutation";
	if (scenario === "sidecar-not-executable" || scenario === "path-permission")
		return "unchanged";
	return "invalidated-by-mutation";
}

export function stageNativeDesktopFaultCopy(
	sourceArtifactInput: string,
	scenario: NativeDesktopFaultScenario,
	options: StageNativeDesktopFaultOptions = {},
): NativeDesktopFaultReceipt {
	const definition = definitionFor(scenario);
	const sourceArtifact = resolve(sourceArtifactInput);
	assertDirectory(sourceArtifact, "release artifact");
	const sourceDigest = inventoryDigest(sourceArtifact);
	// macOS Tauri rejects executable paths containing any symlink. `/var` is a
	// symlink to `/private/var`, so make the staging root canonical before it
	// ever becomes part of the copied bundle's executable path.
	const stagingParent = realpathSync(
		resolve(options.stagingParent ?? tmpdir()),
	);
	assertDirectory(stagingParent, "fault staging parent");
	const stagingRoot = join(
		stagingParent,
		`forgeax-native-fault-${scenario}-${process.pid}-${Date.now()}`,
	);
	mkdirSync(stagingRoot, { recursive: false });
	let residualChild: ChildProcessWithoutNullStreams | undefined;
	let projectPermissionFixture: NativeDesktopFaultReceipt["projectPermissionFixture"];
	try {
		const copyArtifactPath = join(
			stagingRoot,
			sourceArtifact.endsWith(".app") ? basename(sourceArtifact) : "artifact",
		);
		copyArtifact(sourceArtifact, copyArtifactPath);
		const copyBeforeDigest = inventoryDigest(copyArtifactPath);
		if (
			copyBeforeDigest.sha256 !== sourceDigest.sha256 ||
			copyBeforeDigest.files !== sourceDigest.files ||
			copyBeforeDigest.executableFiles !== sourceDigest.executableFiles
		) {
			throw new Error(
				`fault artifact copy changed before mutation: source=${sourceDigest.sha256} copy=${copyBeforeDigest.sha256}`,
			);
		}
		let mutation: FaultMutation;
		let residualStatePath: string | undefined;
		let residualStateSha256: string | undefined;
		let residualFixture:
			| { readonly pid: number; readonly port: number }
			| undefined;
		let residualRuntimeDirectory: string | undefined;
		let residualProjectRoot: string | undefined;
		if (scenario === "missing-launcher") {
			const target = launcherPath(copyArtifactPath);
			const before = readFileSync(target);
			rmSync(target, { force: false });
			mutation = {
				operation: "remove",
				path: portableRelative(copyArtifactPath, target),
				beforeSha256: sha256(before),
				detail: "removed only from the isolated copy",
			};
		} else if (scenario === "sidecar-not-executable") {
			const target = sidecarPath(copyArtifactPath);
			const beforeMode = modeOf(target);
			const afterMode = beforeMode & ~0o111;
			chmodSync(target, afterMode);
			mutation = {
				operation: "chmod",
				path: portableRelative(copyArtifactPath, target),
				beforeMode,
				afterMode,
				detail: "removed execute bits from the copied sidecar",
			};
		} else if (scenario === "mid-start-failure") {
			const target = serverSidecarPath(copyArtifactPath);
			const beforeMode = modeOf(target);
			const afterMode = beforeMode & ~0o111;
			chmodSync(target, afterMode);
			mutation = {
				operation: "chmod",
				path: portableRelative(copyArtifactPath, target),
				beforeMode,
				afterMode,
				detail:
					"kept production launcher/agent-host/engine intact but made later forgeax-server spawn fail",
			};
		} else if (scenario === "readiness-timeout") {
			// Keep local-runtime.mjs byte-for-byte identical to the release. The
			// copied preload is loaded by the actual bundled forgeax-server process.
			const target = join(
				resourceRoot(copyArtifactPath),
				"server-runtime",
				"native-preload.mjs",
			);
			if (!existsSync(target) || !statSync(target).isFile())
				throw new Error(
					`release artifact has no server native preload: ${target}`,
				);
			const before = readFileSync(target);
			const after = Buffer.concat([
				before,
				Buffer.from(readinessTimeoutPreloadPatch()),
			]);
			writeFileSync(target, after, { mode: modeOf(target) });
			mutation = {
				operation: "replace",
				path: portableRelative(copyArtifactPath, target),
				beforeSha256: sha256(before),
				afterSha256: sha256(after),
				detail:
					"kept the production launcher and patched only copied server preload to return health HTTP 503",
			};
		} else if (scenario === "path-permission") {
			// This is intentionally outside the sealed application: making a bundle
			// resource unreadable merely turns codesign verification into the tested
			// failure. Tauri creates .forgeax/runtime during setup, so deny that
			// directory's owner write permission in this receipt-owned project root
			// while leaving the copy byte-identical and verifiably signed.
			const projectRootInput = resolve(
				options.projectRoot ?? join(stagingRoot, "isolated-project"),
			);
			mkdirSync(projectRootInput, { recursive: true });
			const projectRoot = realpathSync(projectRootInput);
			const target = join(projectRoot, ".forgeax");
			if (existsSync(target))
				throw new Error(
					`path-permission project fixture already exists: ${target}`,
				);
			mkdirSync(target, { mode: 0o700 });
			const beforeMode = modeOf(target);
			const afterMode = beforeMode & ~0o200;
			chmodSync(target, afterMode);
			projectPermissionFixture = { path: target, beforeMode, afterMode };
			mutation = {
				operation: "chmod",
				path: target,
				beforeMode,
				afterMode,
				detail:
					"created only this receipt-owned project .forgeax fixture and removed owner write so Tauri setup cannot create .forgeax/runtime",
			};
		} else if (scenario === "negative-validator") {
			const target = productIdentityPath(copyArtifactPath);
			const changed = mutateIdentity(target);
			writeFileSync(target, changed.after);
			mutation = {
				operation: "replace",
				path: portableRelative(copyArtifactPath, target),
				beforeSha256: sha256(changed.before),
				afterSha256: sha256(changed.after),
				detail:
					"changed only the copied product identity so the validator must reject it",
			};
		} else {
			const projectRoot = resolve(
				options.projectRoot ?? join(stagingRoot, "isolated-project"),
			);
			residualProjectRoot = projectRoot;
			residualRuntimeDirectory = runtimeDirectoryFor(projectRoot);
			// Create the live fixture only after all artifact signing/digest work has
			// succeeded, so these earlier failures cannot leak a listener.
			mutation = {
				operation: "write",
				path: residualRuntimeDirectory,
				detail: "will create a PID-qualified stale state owned by this fixture",
			};
		}
		let signature: SignatureAssessment;
		signature = assessSignature(
			sourceArtifact,
			copyArtifactPath,
			scenario,
			options.signaturePolicy,
		);
		const copyDigest = inventoryDigest(
			copyArtifactPath,
			copyBeforeDigest.fileHashes,
		);
		if (residualRuntimeDirectory) {
			mkdirSync(residualRuntimeDirectory, { recursive: true });
			const fixture = startResidualFixture(residualRuntimeDirectory);
			residualChild = fixture.child;
			residualFixture = { pid: fixture.pid, port: fixture.port };
			residualStatePath = statePathFor(residualProjectRoot!, fixture.pid);
			const state =
				JSON.stringify({
					schemaVersion: 1,
					profile: "desktop-prod",
					status: "starting",
					launcherPid: fixture.pid,
					managedPorts: { server: fixture.port },
				}) + "\n";
			writeFileSync(residualStatePath, state, { mode: 0o600 });
			residualStateSha256 = sha256(state);
			residualFixtures.set(residualStatePath, fixture.child);
			mutation = {
				operation: "write",
				path: residualStatePath,
				afterSha256: residualStateSha256,
				detail: "created a PID-qualified stale state owned by this fixture",
			};
		}
		return {
			schema: "forgeax-native-desktop-fault/v1",
			scenario,
			phase: definition.phase,
			code: definition.code,
			evidenceKind: definition.evidenceKind,
			sourceArtifact,
			copyArtifact: copyArtifactPath,
			stagingRoot,
			sourceDigest,
			preMutationDigest: copyBeforeDigest,
			copyDigest,
			mutation,
			signature: {
				source: "preserved-source",
				...signature,
			},
			ownedPaths: [
				stagingRoot,
				...(projectPermissionFixture ? [projectPermissionFixture.path] : []),
				...(residualStatePath ? [residualStatePath] : []),
			],
			projectPermissionFixture,
			residualStatePath,
			residualStateSha256,
			residualFixture,
		};
	} catch (primary) {
		const rollbackErrors: Error[] = [];
		if (residualChild) {
			try {
				stopResidualFixtureForRollback(residualChild);
			} catch (error) {
				rollbackErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		if (projectPermissionFixture) {
			try {
				chmodSync(
					projectPermissionFixture.path,
					projectPermissionFixture.beforeMode,
				);
				rmSync(projectPermissionFixture.path, {
					recursive: true,
					force: false,
				});
			} catch (error) {
				rollbackErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		try {
			rmSync(stagingRoot, { recursive: true, force: true });
		} catch (error) {
			rollbackErrors.push(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		if (rollbackErrors.length)
			throw new AggregateError(
				[primary, ...rollbackErrors],
				"fault staging failed and rollback was incomplete",
			);
		throw primary;
	}
}

export type NativeDesktopFaultObservation = {
	readonly productFailure?: {
		readonly phase: NativeDesktopFaultPhase;
		readonly code?: string;
	};
	readonly driverFailure?: string;
	readonly diagnosticsWritten: boolean;
	readonly cleanupVerified: boolean;
	readonly cleanupErrors?: readonly string[];
};

export type NativeDesktopFaultVerdict = {
	readonly verdict:
		| "product-failure-confirmed"
		| "driver-failure-only"
		| "cleanup-failure"
		| "incomplete-evidence"
		| "unexpected-success";
	readonly productFailure: boolean;
	readonly driverFailure: boolean;
	readonly errors: readonly string[];
};

export type NativeDesktopFaultOracleObservation = {
	readonly phase?: NativeDesktopFaultPhase;
	readonly code?: string;
	readonly productError?: string;
	/** A verifier identity rejection and a codesign rejection are both package preflight facts. */
	readonly preflightRejection?: "identity" | "signature";
	readonly diagnosticsWritten: boolean;
	readonly cleanup: NativeDesktopFaultCleanupEvidence;
};

/**
 * Scenario-specific oracle used by the native runner.  It prevents a generic
 * inspect exception or a non-zero child exit from being relabelled as the
 * injected fault: each expected phase/code must be observed explicitly.
 */
export function assessNativeDesktopFaultOracle(
	receipt: Pick<
		NativeDesktopFaultReceipt,
		"scenario" | "phase" | "code" | "evidenceKind"
	> & {
		readonly signature: Pick<NativeDesktopFaultReceipt["signature"], "policy">;
	},
	observed: NativeDesktopFaultOracleObservation,
): NativeDesktopFaultVerdict {
	const errors: string[] = [];
	if (receipt.evidenceKind !== "native-product")
		errors.push(
			`scenario ${receipt.scenario} is a harness control and cannot be promoted to native product fault evidence`,
		);
	if (!observed.diagnosticsWritten)
		errors.push("fault diagnostics were not written");
	if (
		!observed.cleanup.stateRemoved ||
		!observed.cleanup.fixturePidReleased ||
		!observed.cleanup.fixturePortReleased
	)
		errors.push("fault cleanup evidence is incomplete");
	const signatureScenario = receipt.signature.policy === "signature-rejection";
	if (signatureScenario) {
		if (observed.phase !== receipt.phase || observed.code !== receipt.code)
			errors.push(
				`expected ${receipt.phase}/${receipt.code} package rejection, observed ${observed.phase ?? "none"}/${observed.code ?? "none"}`,
			);
		if (!observed.preflightRejection)
			errors.push(
				"expected product signature or identity rejection was not observed",
			);
	} else {
		if (observed.preflightRejection === "signature")
			errors.push(
				"runtime fault was rejected by signature verification before its runtime phase",
			);
		if (observed.phase !== receipt.phase)
			errors.push(
				`expected ${receipt.phase} product phase, observed ${observed.phase ?? "none"}`,
			);
		if (observed.code !== receipt.code)
			errors.push(
				`expected ${receipt.code} fault code, observed ${observed.code ?? "none"}`,
			);
		// Codes such as STARTUP_FAILURE are runner classifications, not product
		// protocol fields. The runner must retain the raw product error and prove
		// the classification separately; requiring that raw text to echo our
		// harness label would make this oracle impossible to satisfy honestly.
		if (!observed.productError?.trim())
			errors.push("product failure did not retain a raw runtime error");
	}
	if (errors.length)
		return {
			verdict: "cleanup-failure",
			productFailure: false,
			driverFailure: false,
			errors,
		};
	return {
		verdict: "product-failure-confirmed",
		productFailure: true,
		driverFailure: false,
		errors,
	};
}

/** Driver/session errors remain inconclusive; they can never prove a product fault. */
export function assessNativeDesktopFaultObservation(
	input: NativeDesktopFaultObservation,
): NativeDesktopFaultVerdict {
	const errors: string[] = [...(input.cleanupErrors ?? [])];
	const cleanupHasErrors = errors.length > 0;
	if (!input.cleanupVerified) errors.push("fault cleanup was not verified");
	if (input.driverFailure && !input.productFailure) {
		errors.push(
			`driver failure is not product failure evidence: ${input.driverFailure}`,
		);
		return {
			verdict: "driver-failure-only",
			productFailure: false,
			driverFailure: true,
			errors,
		};
	}
	if (!input.diagnosticsWritten)
		errors.push("fault diagnostics were not written");
	if (cleanupHasErrors || !input.cleanupVerified)
		return {
			verdict: "cleanup-failure",
			productFailure: false,
			driverFailure: Boolean(input.driverFailure),
			errors,
		};
	if (!input.diagnosticsWritten)
		return {
			verdict: "incomplete-evidence",
			productFailure: false,
			driverFailure: Boolean(input.driverFailure),
			errors,
		};
	if (input.productFailure && !input.driverFailure)
		return {
			verdict: "product-failure-confirmed",
			productFailure: true,
			driverFailure: false,
			errors,
		};
	if (input.productFailure && input.driverFailure) {
		errors.push(
			"product failure and driver failure occurred together; retain both causes for review",
		);
		return {
			verdict: "product-failure-confirmed",
			productFailure: true,
			driverFailure: true,
			errors,
		};
	}
	return {
		verdict: "unexpected-success",
		productFailure: false,
		driverFailure: Boolean(input.driverFailure),
		errors,
	};
}

/**
 * Remove only paths that this receipt created.  A changed residual file is
 * preserved so a later investigation can inspect it instead of losing data.
 */
export type NativeDesktopFaultCleanupEvidence = {
	readonly stateRemoved: boolean;
	readonly fixturePidReleased: boolean;
	readonly fixturePortReleased: boolean;
};

export async function cleanupNativeDesktopFault(
	receipt: NativeDesktopFaultReceipt,
): Promise<NativeDesktopFaultCleanupEvidence> {
	const stagingRoot = resolve(receipt.stagingRoot);
	const copyArtifact = resolve(receipt.copyArtifact);
	if (!copyArtifact.startsWith(`${stagingRoot}${sep}`))
		throw new Error(
			`refusing to clean a fault artifact outside its staging root: ${copyArtifact}`,
		);
	if (receipt.residualStatePath) {
		if (
			!receipt.ownedPaths.includes(receipt.residualStatePath) ||
			!receipt.residualStateSha256
		) {
			throw new Error(
				`refusing to clean an unverified residual state path: ${receipt.residualStatePath}`,
			);
		}
		let stateError: Error | undefined;
		if (existsSync(receipt.residualStatePath)) {
			const current = sha256(readFileSync(receipt.residualStatePath));
			if (current !== receipt.residualStateSha256)
				stateError = new Error(
					`refusing to remove changed residual state: ${receipt.residualStatePath}`,
				);
		}
		if (receipt.residualFixture)
			await stopResidualFixture(
				receipt.residualStatePath,
				receipt.residualFixture,
			);
		if (stateError) throw stateError;
		if (existsSync(receipt.residualStatePath))
			unlinkSync(receipt.residualStatePath);
	}
	if (receipt.projectPermissionFixture) {
		const fixture = receipt.projectPermissionFixture;
		if (
			!receipt.ownedPaths.includes(fixture.path) ||
			!existsSync(fixture.path)
		) {
			throw new Error(
				`refusing to clean an unverified path-permission fixture: ${fixture.path}`,
			);
		}
		if (modeOf(fixture.path) !== fixture.afterMode) {
			throw new Error(
				`refusing to clean changed path-permission fixture: ${fixture.path}`,
			);
		}
		chmodSync(fixture.path, fixture.beforeMode);
		rmSync(fixture.path, { recursive: true, force: false });
	}
	rmSync(stagingRoot, { recursive: true, force: false });
	return {
		stateRemoved:
			!receipt.residualStatePath || !existsSync(receipt.residualStatePath),
		fixturePidReleased: true,
		fixturePortReleased: true,
	};
}

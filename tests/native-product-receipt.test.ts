import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	assertNativeProductSourceStable,
	createNativeProductReceipt,
	nativeProductSourceRoot,
	verifyNativeProductReceipt,
} from "../scripts/native-product-receipt";

const revision = "a".repeat(40);
function digest(value: string | Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}
function fixture(dirty = false) {
	const root = mkdtempSync(join(tmpdir(), "native-product-receipt-"));
	const executable = join(
		root,
		"ForgeaX Studio.app/Contents/MacOS/forgeax-ide-desktop",
	);
	const manifest = join(
		root,
		"ForgeaX Studio.app/Contents/Resources/resources/runtime/desktop-runtime-manifest.json",
	);
	const context = join(root, "source-context.json");
	const source = join(root, "desktop-build-source.json");
	mkdirSync(join(executable, ".."), { recursive: true });
	mkdirSync(join(manifest, ".."), { recursive: true });
	writeFileSync(executable, "signed final executable");
	writeFileSync(
		manifest,
		JSON.stringify({ platform: "macos-arm64", digest: "b".repeat(64) }),
	);
	writeFileSync(
		context,
		JSON.stringify({
			schema: "forgeax-server-source-build/v1",
			sourceRevisions: { studio: "c".repeat(40), server: "d".repeat(40) },
		}),
	);
	writeFileSync(
		source,
		JSON.stringify({
			schema: "forgeax-local-build-source/v1",
			bun: "1.4.0",
			repositories: {
				".": {
					revision: "c".repeat(40),
					dirty,
					diffSha256: "e".repeat(64),
					untracked: [],
				},
				"packages/ide": {
					revision,
					dirty,
					diffSha256: "f".repeat(64),
					untracked: [],
				},
			},
		}),
	);
	return { root, executable, manifest, context, source };
}

test("creates a portable final-product receipt bound to executable, runtime manifest, and build-time source", () => {
	const value = fixture();
	try {
		const output = join(value.root, "native-product-receipt.json");
		const receipt = createNativeProductReceipt({
			platform: "macos",
			productRoot: value.root,
			executable: value.executable,
			runtimeManifest: value.manifest,
			sourceContext: value.context,
			buildSource: value.source,
			output,
			currentSource: JSON.parse(readFileSync(value.source, "utf8")),
		});
		expect(receipt).toMatchObject({
			schema: "forgeax-native-product-receipt/v1",
			platform: "macos",
			revision,
			executable: "ForgeaX Studio.app/Contents/MacOS/forgeax-ide-desktop",
			sha256: digest("signed final executable"),
			source: { kind: "committed" },
		});
		expect(receipt.runtimeManifest).toEqual({
			path: "ForgeaX Studio.app/Contents/Resources/resources/runtime/desktop-runtime-manifest.json",
			sha256: digest(readFileSync(value.manifest)),
			digest: "b".repeat(64),
		});
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(receipt);
		const portableRoot = join(value.root, "portable-copy");
		mkdirSync(portableRoot, { recursive: true });
		cpSync(
			join(value.root, "ForgeaX Studio.app"),
			join(portableRoot, "ForgeaX Studio.app"),
			{ recursive: true },
		);
		copyFileSync(output, join(portableRoot, "native-product-receipt.json"));
		expect(
			verifyNativeProductReceipt({
				receipt: join(portableRoot, "native-product-receipt.json"),
				platform: "macos",
				executable: join(portableRoot, receipt.executable),
				revision,
			}),
		).toEqual(receipt);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("rejects a tampered executable and permits atomic replacement after a successful rerun", () => {
	const value = fixture();
	try {
		const output = join(value.root, "receipt.json");
		const options = {
			platform: "macos" as const,
			productRoot: value.root,
			executable: value.executable,
			runtimeManifest: value.manifest,
			sourceContext: value.context,
			buildSource: value.source,
			output,
			currentSource: JSON.parse(readFileSync(value.source, "utf8")),
		};
		createNativeProductReceipt(options);
		writeFileSync(value.executable, "tampered");
		expect(() =>
			verifyNativeProductReceipt({
				receipt: output,
				platform: "macos",
				executable: value.executable,
			}),
		).toThrow("expected executable");
		createNativeProductReceipt(options);
		expect(
			verifyNativeProductReceipt({
				receipt: output,
				platform: "macos",
				executable: value.executable,
			}).sha256,
		).toBe(digest("tampered"));
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("rejects a final product when the source changed after desktop preparation", () => {
	const value = fixture();
	try {
		const snapshot = JSON.parse(readFileSync(value.source, "utf8"));
		expect(() =>
			assertNativeProductSourceStable(value.source, {
				...snapshot,
				repositories: {
					...snapshot.repositories,
					"packages/ide": {
						...snapshot.repositories["packages/ide"],
						diffSha256: "0".repeat(64),
						dirty: true,
					},
				},
			}),
		).toThrow("source changed after desktop preparation");
		expect(() =>
			assertNativeProductSourceStable(value.source, snapshot),
		).not.toThrow();
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("resolves the Studio root from the script directory without depending on cwd", () => {
	expect(
		nativeProductSourceRoot("/fixture/forgeax-studio/packages/ide/scripts"),
	).toBe("/fixture/forgeax-studio");
});

test("records dirty working-tree provenance without presenting it as an immutable source build", () => {
	const value = fixture(true);
	try {
		const receipt = createNativeProductReceipt({
			platform: "macos",
			productRoot: value.root,
			executable: value.executable,
			runtimeManifest: value.manifest,
			sourceContext: value.context,
			buildSource: value.source,
			output: join(value.root, "receipt.json"),
			currentSource: JSON.parse(readFileSync(value.source, "utf8")),
		});
		expect(receipt.revision).toBe(revision);
		expect(receipt.source.kind).toBe("dirty-working-tree");
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("refuses to create a receipt when product and runtime manifest platforms differ", () => {
	const value = fixture();
	try {
		expect(() =>
			createNativeProductReceipt({
				platform: "windows",
				productRoot: value.root,
				executable: value.executable,
				runtimeManifest: value.manifest,
				sourceContext: value.context,
				buildSource: value.source,
				output: join(value.root, "receipt.json"),
				currentSource: JSON.parse(readFileSync(value.source, "utf8")),
			}),
		).toThrow("runtime manifest platform does not match product");
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

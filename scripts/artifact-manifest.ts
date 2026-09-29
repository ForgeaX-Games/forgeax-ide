import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ARTIFACT_MANIFEST_SCHEMA = "forgeax-runtime-artifact/v1" as const;

export type ArtifactScope = "common" | "target";
export type ArtifactFile = {
	path: string;
	sha256: string;
	size: number;
	executable: boolean;
};
export type ArtifactIdentityFile = { path: string; sha256: string };
export type ArtifactProducer = {
	repository: string;
	revision: string;
	tree: string;
};
export type ArtifactTarget = { platform: string; triple: string };
export type ArtifactInputs = {
	lockfiles: ArtifactIdentityFile[];
	buildScripts: ArtifactIdentityFile[];
	toolchains: Record<string, string>;
};
export type ArtifactDescriptor = {
	artifactId: string;
	producer: ArtifactProducer;
	inputs: ArtifactInputs;
	scope: ArtifactScope;
	target: ArtifactTarget | null;
};
export type ArtifactManifest = ArtifactDescriptor & {
	schema: typeof ARTIFACT_MANIFEST_SCHEMA;
	algorithm: "sha256";
	files: ArtifactFile[];
	digest: string;
};

const MANIFEST_KEYS = [
	"algorithm",
	"artifactId",
	"digest",
	"files",
	"inputs",
	"producer",
	"schema",
	"scope",
	"target",
];
const PRODUCER_KEYS = ["repository", "revision", "tree"];
const INPUT_KEYS = ["buildScripts", "lockfiles", "toolchains"];
const IDENTITY_FILE_KEYS = ["path", "sha256"];
const TARGET_KEYS = ["platform", "triple"];
const FILE_KEYS = ["executable", "path", "sha256", "size"];
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NATIVE_PATH =
	/(^|\/)(?:@esbuild|@rollup|@img|sharp|esbuild|rollup)(?:\/|$)|\.(?:dll|dylib|exe|node|so)(?:\.[0-9]+)*$|(?:aarch64-apple-darwin|x86_64-apple-darwin|x86_64-pc-windows-msvc)/i;

function fail(message: string): never {
	throw new Error(`[artifact-manifest] ${message}`);
}

function exactKeys(
	value: unknown,
	keys: string[],
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...keys].sort())
	);
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) fail("undefined is not canonical JSON");
	return encoded;
}

export function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function manifestDigest(
	manifest: Omit<ArtifactManifest, "digest">,
): string {
	return sha256(canonicalJson(manifest));
}

function normalizeArtifactPath(path: string): string {
	if (
		!path ||
		path === "." ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.startsWith("/") ||
		path.startsWith("//") ||
		/^[A-Za-z]:/.test(path) ||
		path.endsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		fail(`unsafe artifact path: ${path}`);
	return path;
}

function assertPortableUniquePaths(paths: string[], field: string): void {
	const portable = new Set<string>();
	for (const path of paths) {
		const key = path.normalize("NFC").toLowerCase();
		if (portable.has(key))
			fail(
				`${field} contains a case-fold or Unicode-normalized path collision: ${path}`,
			);
		portable.add(key);
	}
}

function assertInside(root: string, path: string): void {
	const rootPath = resolve(root);
	const resolved = resolve(rootPath, path);
	const rel = relative(rootPath, resolved);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		fail(`path escapes artifact root: ${path}`);
}

function assertIdentityFiles(
	value: unknown,
	field: string,
): asserts value is ArtifactIdentityFile[] {
	if (!Array.isArray(value)) fail(`${field} must be an array`);
	let previous = "";
	const paths: string[] = [];
	for (const item of value) {
		if (
			!exactKeys(item, IDENTITY_FILE_KEYS) ||
			typeof item.path !== "string" ||
			typeof item.sha256 !== "string" ||
			!SHA256.test(item.sha256)
		) {
			fail(`invalid ${field} entry`);
		}
		const path = normalizeArtifactPath(item.path);
		if (path <= previous) fail(`${field} must be sorted with unique paths`);
		previous = path;
		paths.push(path);
	}
	assertPortableUniquePaths(paths, field);
}

function assertDescriptor(value: unknown): asserts value is ArtifactDescriptor {
	const descriptor = value as Partial<ArtifactDescriptor>;
	if (
		typeof descriptor.artifactId !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*\/v[1-9][0-9]*$/.test(descriptor.artifactId)
	)
		fail("invalid artifact id");
	if (
		!exactKeys(descriptor.producer, PRODUCER_KEYS) ||
		typeof descriptor.producer.repository !== "string" ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
			descriptor.producer.repository,
		) ||
		typeof descriptor.producer.revision !== "string" ||
		!REVISION.test(descriptor.producer.revision) ||
		typeof descriptor.producer.tree !== "string" ||
		!REVISION.test(descriptor.producer.tree)
	)
		fail("invalid producer identity");
	if (!exactKeys(descriptor.inputs, INPUT_KEYS)) fail("invalid input identity");
	assertIdentityFiles(descriptor.inputs.lockfiles, "lockfiles");
	assertIdentityFiles(descriptor.inputs.buildScripts, "buildScripts");
	if (
		!descriptor.inputs.toolchains ||
		typeof descriptor.inputs.toolchains !== "object" ||
		Array.isArray(descriptor.inputs.toolchains) ||
		Object.keys(descriptor.inputs.toolchains).length === 0 ||
		Object.entries(descriptor.inputs.toolchains).some(
			([key, item]) =>
				!/^[a-z][a-z0-9._-]*$/.test(key) || typeof item !== "string" || !item,
		)
	)
		fail("invalid toolchain identity");
	if (descriptor.scope !== "common" && descriptor.scope !== "target")
		fail("invalid artifact scope");
	if (descriptor.scope === "common" && descriptor.target !== null)
		fail("common artifact cannot declare a target");
	if (
		descriptor.scope === "target" &&
		(!exactKeys(descriptor.target, TARGET_KEYS) ||
			typeof descriptor.target.platform !== "string" ||
			!descriptor.target.platform ||
			typeof descriptor.target.triple !== "string" ||
			!descriptor.target.triple)
	)
		fail("target artifact requires platform and triple");
}

function assertNoSymlinkComponents(root: string, path: string): void {
	let current = resolve(root);
	for (const part of path.split("/")) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink())
			fail(`symlinks are forbidden: ${path}`);
	}
}

function hashStableFile(path: string): {
	sha256: string;
	size: number;
	executable: boolean;
} {
	const before = lstatSync(path);
	const digest = sha256(readFileSync(path));
	const after = lstatSync(path);
	if (
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs
	)
		fail(`file changed while hashing: ${path}`);
	return {
		sha256: digest,
		size: after.size,
		executable: (after.mode & 0o111) !== 0,
	};
}

function listFiles(root: string): ArtifactFile[] {
	if (!existsSync(root) || !statSync(root).isDirectory())
		fail(`artifact root is not a directory: ${root}`);
	const result: ArtifactFile[] = [];
	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(left, right) =>
				left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		)) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = join(directory, entry.name);
			if (entry.isSymbolicLink()) fail(`symlinks are forbidden: ${path}`);
			if (entry.isDirectory()) walk(absolute, path);
			else if (entry.isFile())
				result.push({
					path: normalizeArtifactPath(path),
					...hashStableFile(absolute),
				});
			else fail(`unsupported artifact entry: ${path}`);
		}
	};
	walk(root, "");
	result.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	);
	assertPortableUniquePaths(
		result.map((file) => file.path),
		"artifact",
	);
	return result;
}

export function inventoryArtifactFiles(root: string): ArtifactFile[] {
	return listFiles(root);
}

export function normalizePortableArtifactFiles(root: string): void {
	if (!existsSync(root) || !statSync(root).isDirectory())
		fail(`artifact root is not a directory: ${root}`);
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink())
				fail(`symlinks are forbidden: ${relative(root, path)}`);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) chmodSync(path, 0o644);
			else fail(`unsupported artifact entry: ${relative(root, path)}`);
		}
	};
	walk(resolve(root));
}

export function createArtifactManifest(
	root: string,
	descriptor: ArtifactDescriptor,
): ArtifactManifest {
	assertDescriptor(descriptor);
	const files = listFiles(root);
	if (files.length === 0) fail("artifact contains no files");
	if (descriptor.scope === "common") {
		const native = files.find((file) => NATIVE_PATH.test(file.path));
		if (native)
			fail(`common artifact contains target-native path: ${native.path}`);
	}
	const unsigned = {
		schema: ARTIFACT_MANIFEST_SCHEMA,
		algorithm: "sha256" as const,
		...descriptor,
		files,
	};
	return { ...unsigned, digest: manifestDigest(unsigned) };
}

export type ArtifactExpectation = Partial<
	Pick<
		ArtifactDescriptor,
		"artifactId" | "producer" | "inputs" | "scope" | "target"
	>
>;

export function verifyArtifactManifest(
	root: string,
	value: unknown,
	expected: ArtifactExpectation = {},
): ArtifactManifest {
	if (!exactKeys(value, MANIFEST_KEYS))
		fail("unknown or missing manifest fields");
	const manifest = value as unknown as ArtifactManifest;
	if (
		manifest.schema !== ARTIFACT_MANIFEST_SCHEMA ||
		manifest.algorithm !== "sha256"
	)
		fail("unknown manifest schema or digest algorithm");
	assertDescriptor(manifest);
	if (
		!Array.isArray(manifest.files) ||
		manifest.files.length === 0 ||
		typeof manifest.digest !== "string" ||
		!SHA256.test(manifest.digest)
	)
		fail("invalid manifest files or digest");
	assertPortableUniquePaths(
		manifest.files.map((file) =>
			typeof file?.path === "string" ? file.path : "",
		),
		"manifest",
	);
	let previous = "";
	for (const file of manifest.files) {
		if (
			!exactKeys(file, FILE_KEYS) ||
			typeof file.path !== "string" ||
			typeof file.sha256 !== "string" ||
			!SHA256.test(file.sha256) ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			typeof file.executable !== "boolean"
		)
			fail("invalid file record");
		const path = normalizeArtifactPath(file.path);
		if (path <= previous) fail("file records must be sorted with unique paths");
		previous = path;
		assertInside(root, path);
		const absolute = join(root, path);
		if (!existsSync(absolute)) fail(`missing artifact file: ${path}`);
		assertNoSymlinkComponents(root, path);
		const stat = lstatSync(absolute);
		if (!stat.isFile()) fail(`artifact path is not a file: ${path}`);
		const realRoot = realpathSync(resolve(root));
		const real = realpathSync(absolute);
		const realRelative = relative(realRoot, real);
		if (
			!realRelative ||
			realRelative === ".." ||
			realRelative.startsWith(`..${sep}`) ||
			isAbsolute(realRelative)
		)
			fail(`resolved path escapes artifact root: ${path}`);
		if (
			stat.size !== file.size ||
			sha256(readFileSync(absolute)) !== file.sha256 ||
			((stat.mode & 0o111) !== 0) !== file.executable
		) {
			fail(`artifact file does not match manifest: ${path}`);
		}
		if (manifest.scope === "common" && NATIVE_PATH.test(path))
			fail(`common artifact contains target-native path: ${path}`);
	}
	const actual = listFiles(root).map((file) => file.path);
	if (
		JSON.stringify(actual) !==
		JSON.stringify(manifest.files.map((file) => file.path))
	)
		fail("artifact contains stale or undeclared files");
	const { digest, ...unsigned } = manifest;
	if (manifestDigest(unsigned) !== digest) fail("manifest digest mismatch");
	for (const [key, expectedValue] of Object.entries(expected)) {
		if (
			canonicalJson(manifest[key as keyof ArtifactManifest]) !==
			canonicalJson(expectedValue)
		)
			fail(`${key} identity mismatch`);
	}
	return manifest;
}

export type ComposeInput = {
	root: string;
	manifest: unknown;
	expected: ArtifactExpectation;
};

export function composeArtifacts(
	destination: string,
	inputs: ComposeInput[],
): ArtifactFile[] {
	if (inputs.length === 0) fail("compose requires at least one artifact");
	if (existsSync(destination)) fail("compose destination already exists");
	const verified = inputs.map((input) => ({
		root: input.root,
		manifest: verifyArtifactManifest(
			input.root,
			input.manifest,
			input.expected,
		),
	}));
	const claimed = new Set<string>();
	const files: Array<ArtifactFile & { root: string }> = [];
	for (const input of verified) {
		for (const file of input.manifest.files) {
			if (claimed.has(file.path)) fail(`duplicate composed path: ${file.path}`);
			claimed.add(file.path);
			files.push({ ...file, root: input.root });
		}
	}
	const temporary = `${destination}.compose-${process.pid}`;
	if (existsSync(temporary))
		fail(`compose temporary path already exists: ${temporary}`);
	try {
		mkdirSync(temporary, { recursive: true });
		for (const file of files) {
			const output = join(temporary, file.path);
			assertInside(temporary, file.path);
			mkdirSync(dirname(output), { recursive: true });
			copyFileSync(join(file.root, file.path), output);
			chmodSync(output, file.executable ? 0o755 : 0o644);
		}
		renameSync(temporary, destination);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
	return files
		.map(({ root: _root, ...file }) => file)
		.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
}

export function identityContent(
	path: string,
	content: Uint8Array | string,
): ArtifactIdentityFile {
	return { path: normalizeArtifactPath(path), sha256: sha256(content) };
}

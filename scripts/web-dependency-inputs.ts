#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import inventory from "../product/direct-dependencies.json";
import { completeSourceWorkspace } from "./complete-source-workspace";

export type Revision = {
	repository: string;
	revision: string;
	pullRequest?: number;
};
export type DependencyInputs = {
	schemaVersion: 1;
	ide: Revision;
	companions: Revision[];
};
export type Candidate = Revision & {
	name: string;
	mode: string;
	path: string;
	primary: boolean;
};
type Packed = Candidate & {
	tarball: string;
	sha256: string;
	bun: string;
	files: Record<string, string>;
};
type Plan = {
	schemaVersion: 1;
	ide: Revision;
	studio: Revision;
	candidates: Candidate[];
	packed: Packed[];
};
const IDE_REPOSITORY = "ForgeaX-Games/forgeax-ide";
const dependencies = Object.entries(inventory.packages).filter(
	([, value]) => value.repository !== IDE_REPOSITORY,
);
const workspaceLintRepositories = new Set([
	"ForgeaX-Games/forgeax-chat",
	"ForgeaX-Games/forgeax-dashboard",
	"ForgeaX-Games/forgeax-interface",
	"ForgeaX-Games/forgeax-settings",
]);

export function validateRevision(value: unknown): Revision {
	if (!value || typeof value !== "object")
		throw new Error("Revision must be an object");
	const x = value as Revision;
	if (
		![
			IDE_REPOSITORY,
			...dependencies.map(([, value]) => value.repository),
		].includes(x.repository)
	)
		throw new Error("Unsupported dependency repository: " + x.repository);
	if (!/^[a-f0-9]{40}$/.test(x.revision))
		throw new Error(
			"An immutable 40-character commit is required: " + x.repository,
		);
	if (
		x.pullRequest !== undefined &&
		(!Number.isSafeInteger(x.pullRequest) || x.pullRequest < 1)
	)
		throw new Error("Invalid pull request number");
	return {
		repository: x.repository,
		revision: x.revision,
		...(x.pullRequest ? { pullRequest: x.pullRequest } : {}),
	};
}

export function validateDependencyInputs(
	value: unknown,
	primary: Revision,
): DependencyInputs {
	validateRevision(primary);
	if (primary.repository === IDE_REPOSITORY)
		throw new Error("Expected a dependency PR");
	const x = value as DependencyInputs;
	if (x?.schemaVersion !== 1 || !Array.isArray(x.companions))
		throw new Error("Unsupported IDE Web inputs schema");
	const ide = validateRevision(x.ide);
	if (ide.repository !== IDE_REPOSITORY)
		throw new Error("The ide input must identify forgeax-ide");
	const seen = new Set([IDE_REPOSITORY, primary.repository]);
	const companions = x.companions.map((item) => {
		const ref = validateRevision(item);
		if (seen.has(ref.repository))
			throw new Error("Duplicate candidate: " + ref.repository);
		seen.add(ref.repository);
		return ref;
	});
	return { schemaVersion: 1, ide, companions };
}

export function dependencyInputsFromParameters(
	primary: Revision,
	env: NodeJS.ProcessEnv,
): DependencyInputs {
	let companions: unknown;
	try {
		companions = JSON.parse(env.IDE_WEB_COMPANIONS || "[]");
	} catch {
		throw new Error("IDE_WEB_COMPANIONS must be a JSON array");
	}
	return validateDependencyInputs(
		{
			schemaVersion: 1,
			ide: { repository: IDE_REPOSITORY, revision: env.BLUEKING_IDE_REVISION },
			companions,
		},
		primary,
	);
}

function run(
	command: string,
	args: string[],
	cwd: string,
	capture = false,
	env = process.env,
): string {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			command +
				" " +
				args.join(" ") +
				" failed: " +
				(result.stderr ?? result.status),
		);
	return result.stdout?.trim() ?? "";
}
function git(path: string, ...args: string[]): string {
	return run("git", ["-C", path, ...args], path, true);
}
function json(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}
function save(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function clean(path: string): void {
	if (git(path, "status", "--porcelain", "--untracked-files=no"))
		throw new Error("Candidate source must be clean: " + path);
}

function canonicalOrigin(path: string, repository: string): void {
	const remote = git(path, "remote", "get-url", "origin");
	// Preserve the checkout plugin's private-repository authentication. Never
	// print the URL, which may contain credentials supplied by that plugin.
	const normalized = remote.replace(/^git@github\.com:/, "https://github.com/");
	const url = new URL(normalized);
	if (
		url.hostname !== "github.com" ||
		url.pathname.replace(/^\//, "").replace(/\.git$/, "") !== repository
	) {
		throw new Error(
			"Candidate origin is not the declared repository: " + repository,
		);
	}
}

export function assertRevision(path: string, expected: Revision): void {
	if (git(path, "rev-parse", "HEAD") !== expected.revision)
		throw new Error(
			"Checked-out revision differs from the check input: " +
				expected.repository,
		);
}

function checkout(candidate: Candidate): void {
	if (!existsSync(join(candidate.path, ".git"))) {
		throw new Error(
			"Authenticated candidate checkout is missing: " + candidate.repository,
		);
	}
	clean(candidate.path);
	canonicalOrigin(candidate.path, candidate.repository);
	// Fetch only from the canonical repository, including fork PR heads exposed
	// by GitHub. Branch names and caller-supplied filesystem paths are not inputs.
	const ref = candidate.pullRequest
		? "refs/pull/" + candidate.pullRequest + "/head"
		: candidate.revision;
	git(candidate.path, "fetch", "origin", ref);
	if (git(candidate.path, "rev-parse", "FETCH_HEAD") !== candidate.revision)
		throw new Error("Companion PR has moved: " + candidate.repository);
	git(
		candidate.path,
		"-c",
		"core.hooksPath=/dev/null",
		"checkout",
		"--detach",
		candidate.revision,
	);
	git(candidate.path, "submodule", "update", "--init", "--recursive");
	assertRevision(candidate.path, candidate);
	if (json(join(candidate.path, "package.json")).name !== candidate.name)
		throw new Error("Candidate package identity mismatch");
}

export function isIntegratedRevision(
	path: string,
	ref: Revision,
	remote = "origin",
): boolean {
	assertRevision(path, ref);
	clean(path);
	if (ref.pullRequest) {
		git(path, "fetch", remote, "refs/pull/" + ref.pullRequest + "/head");
		if (git(path, "rev-parse", "FETCH_HEAD") !== ref.revision)
			throw new Error("Companion PR moved during the build");
	}
	git(path, "fetch", remote, "refs/heads/main");
	return (
		spawnSync("git", [
			"-C",
			path,
			"merge-base",
			"--is-ancestor",
			ref.revision,
			"FETCH_HEAD",
		]).status === 0
	);
}

export function dependencyOrder<T extends { name: string }>(
	items: T[],
	edges: (item: T) => string[],
): T[] {
	const ordered: T[] = [];
	const visiting = new Set<string>();
	const complete = new Set<string>();
	function visit(item: T): void {
		if (complete.has(item.name)) return;
		if (visiting.has(item.name))
			throw new Error("Cyclic npm candidate build dependencies: " + item.name);
		visiting.add(item.name);
		for (const name of edges(item)) {
			const child = items.find((value) => value.name === name);
			if (child) visit(child);
		}
		visiting.delete(item.name);
		complete.add(item.name);
		ordered.push(item);
	}
	items.forEach(visit);
	return ordered;
}

// Web builds lint only the source-workspace application packages. npm
// candidates keep their existing build-and-pack contract because they are
// verified through the packed artifact installed into IDE.
export function lintWorkspaceCandidates(
	candidates: Candidate[],
	execute: (candidate: Candidate) => void = (candidate) =>
		run(process.execPath, ["run", "lint"], candidate.path),
): void {
	for (const candidate of candidates) {
		if (
			candidate.mode === "workspace" &&
			workspaceLintRepositories.has(candidate.repository)
		)
			execute(candidate);
	}
}

/** Lint the workspace source against the same packed companions as the IDE graph. */
export function lintWorkspaceCandidateAgainstPackedGraph(
	candidate: Candidate,
	packed: Packed[],
): void {
	const overrides = Object.fromEntries(
		packed.map((item) => [item.name, item.tarball]),
	);
	const manifest = json(join(candidate.path, "package.json"));
	const direct = new Set(
		Object.keys({
			...manifest.dependencies,
			...manifest.devDependencies,
			...manifest.peerDependencies,
		}),
	);
	withOverrides(candidate.path, overrides, () => {
		run(process.execPath, ["install", "--ignore-scripts"], candidate.path);
		run(
			process.execPath,
			["install", "--ignore-scripts", "--frozen-lockfile"],
			candidate.path,
		);
		verifyInstalledCandidates(
			candidate.path,
			packed.filter((item) => direct.has(item.name)),
		);
	});
	// Lint the original source files after restoring temporary install inputs.
	// node_modules still contains the verified packed companion graph.
	run(process.execPath, ["run", "lint"], candidate.path);
}

// Restore source manifests/locks even after a failed build. The effective lock
// belongs to this candidate run and is archived separately, never committed.
export function withOverrides<T>(
	path: string,
	overrides: Record<string, string>,
	action: () => T,
): T {
	const manifestPath = join(path, "package.json");
	const manifest = readFileSync(manifestPath);
	const lockPath = join(path, "bun.lock");
	const lock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
	try {
		const data = JSON.parse(manifest.toString());
		save(manifestPath, {
			...data,
			overrides: { ...data.overrides, ...overrides },
		});
		return action();
	} finally {
		writeFileSync(manifestPath, manifest);
		if (lock) writeFileSync(lockPath, lock);
		else rmSync(lockPath, { force: true });
	}
}

function candidateBun(
	path: string,
	artifacts: string,
): { executable: string; version: string; env: NodeJS.ProcessEnv } {
	const manager: string = json(join(path, "package.json")).packageManager;
	if (!/^bun@\d+\.\d+\.\d+$/.test(manager))
		throw new Error("Candidate must pin its Bun toolchain");
	const version = manager.slice(4);
	if (
		version ===
		(process.versions.bun ??
			execFileSync("bun", ["--version"], { encoding: "utf8" }).trim())
	)
		return {
			executable: process.versions.bun ? process.execPath : "bun",
			version,
			env: process.env,
		};
	const tools = resolve(
		artifacts,
		"../../../.forgeax/ide-web-tools",
		"bun-" + version,
	);
	const executable = join(tools, "node_modules/.bin/bun");
	if (!existsSync(executable))
		run("npm", ["install", "--prefix", tools, "--no-save", manager], path);
	return {
		executable,
		version,
		env: { ...process.env, PATH: dirname(executable) + ":" + process.env.PATH },
	};
}

function packedFileHashes(
	tarball: string,
	artifacts: string,
): Record<string, string> {
	const entries = run("tar", ["-tzf", tarball], artifacts, true).split("\n");
	if (
		entries.some(
			(entry) =>
				!entry.startsWith("package/") ||
				entry.split("/").includes("..") ||
				entry.includes("\\"),
		)
	) {
		throw new Error("Unexpected path in candidate package");
	}
	const directory = mkdtempSync(join(artifacts, "package-content-"));
	try {
		run("tar", ["-xzf", tarball, "-C", directory], artifacts);
		const hashes: Record<string, string> = {};
		function walk(prefix: string): void {
			for (const name of readdirSync(join(directory, "package", prefix))) {
				const relative = prefix ? prefix + "/" + name : name;
				const path = join(directory, "package", relative);
				const stat = lstatSync(path);
				if (stat.isDirectory()) walk(relative);
				else if (stat.isFile()) hashes[relative] = sha256(path);
				else throw new Error("Candidate package contains a non-regular file");
			}
		}
		walk("");
		return hashes;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function packCandidate(
	candidate: Candidate,
	artifacts: string,
	overrides: Record<string, string>,
): Packed {
	mkdirSync(artifacts, { recursive: true });
	const tool = candidateBun(candidate.path, artifacts);
	const invoke = (args: string[]) =>
		run(tool.executable, args, candidate.path, false, tool.env);
	invoke(["install", "--frozen-lockfile", "--ignore-scripts"]);
	withOverrides(candidate.path, overrides, () => {
		if (Object.keys(overrides).length) invoke(["install", "--ignore-scripts"]);
		invoke(["run", "build"]);
		if (existsSync(join(candidate.path, "bun.lock"))) {
			copyFileSync(
				join(candidate.path, "bun.lock"),
				join(artifacts, candidate.name.slice(9) + "-build.bun.lock"),
			);
		}
	});
	const manifestPath = join(candidate.path, "package.json");
	const original = readFileSync(manifestPath);
	const temporaryTarball = join(
		artifacts,
		candidate.name.slice(9) + "-" + candidate.revision + ".tgz",
	);
	try {
		// Detect same-version registry/cache substitution after installation.
		save(manifestPath, {
			...JSON.parse(original.toString()),
			forgeaxCiCandidate: {
				repository: candidate.repository,
				revision: candidate.revision,
			},
		});
		invoke(["pm", "pack", "--ignore-scripts", "--filename", temporaryTarball]);
	} finally {
		writeFileSync(manifestPath, original);
	}
	clean(candidate.path);
	const digest = sha256(temporaryTarball);
	const tarball = temporaryTarball.replace(/\.tgz$/, "-" + digest + ".tgz");
	renameSync(temporaryTarball, tarball);
	return {
		...candidate,
		tarball,
		sha256: digest,
		bun: tool.version,
		files: packedFileHashes(tarball, artifacts),
	};
}

export function verifyInstalledCandidates(ide: string, packed: Packed[]): void {
	for (const candidate of packed) {
		if (sha256(candidate.tarball) !== candidate.sha256)
			throw new Error("Candidate tarball changed: " + candidate.name);
		const manifest = json(
			join(ide, "node_modules", candidate.name, "package.json"),
		);
		if (
			manifest.forgeaxCiCandidate?.repository !== candidate.repository ||
			manifest.forgeaxCiCandidate?.revision !== candidate.revision
		) {
			throw new Error(
				"IDE is using a registry/stale package instead of the PR candidate: " +
					candidate.name,
			);
		}
		for (const [file, expected] of Object.entries(candidate.files)) {
			const installed = join(ide, "node_modules", candidate.name, file);
			if (!existsSync(installed) || sha256(installed) !== expected)
				throw new Error(
					"Installed candidate payload differs from the packed build: " +
						candidate.name +
						"/" +
						file,
				);
		}
	}
}

function paths() {
	const ide = resolve(import.meta.dirname, "..");
	const studio = resolve(ide, "../..");
	const artifacts = join(ide, "blueking-artifacts");
	return {
		ide,
		studio,
		artifacts,
		planPath: join(artifacts, "dependency-inputs.json"),
	};
}

async function prepare(): Promise<void> {
	const { ide, studio, artifacts, planPath } = paths();
	const primary = validateRevision({
		repository: process.env.BLUEKING_DEPENDENCY_REPOSITORY,
		revision: process.env.BLUEKING_DEPENDENCY_REVISION,
	});
	const inputs = dependencyInputsFromParameters(primary, process.env);
	assertRevision(ide, inputs.ide);
	const candidates = [primary, ...inputs.companions].map((ref): Candidate => {
		const [name, contract] = dependencies.find(
			([, value]) => value.repository === ref.repository,
		)!;
		const path =
			"path" in contract
				? join(studio, contract.path)
				: join(studio, ".forgeax/ide-web-candidates", name.slice(9));
		return {
			...ref,
			name,
			mode: contract.mode,
			path,
			primary: ref.repository === primary.repository,
		};
	});
	const plan: Plan = {
		schemaVersion: 1,
		ide: inputs.ide,
		studio: {
			repository: "ForgeaX-Games/forgeax-studio",
			revision: git(studio, "rev-parse", "HEAD"),
		},
		candidates,
		packed: [],
	};
	save(planPath, plan);
	candidates.forEach(checkout);
	const packed: Packed[] = [];
	const overrides: Record<string, string> = {};
	for (const candidate of dependencyOrder(
		candidates.filter((value) => value.mode === "npm"),
		(value) => {
			const m = json(join(value.path, "package.json"));
			return Object.keys({
				...m.dependencies,
				...m.devDependencies,
				...m.peerDependencies,
			});
		},
	)) {
		const result = packCandidate(candidate, artifacts, overrides);
		packed.push(result);
		overrides[candidate.name] = result.tarball;
		save(planPath, { ...plan, packed });
	}
	// Seed from the committed graph; candidate manifest/override changes get a
	// separate effective lock, followed by a frozen reinstall of that exact graph.
	const workspace = join(studio, ".forgeax/ide-source-workspace");
	const generator = await import(
		join(studio, "scripts/lib/ide-integration-workspace.ts")
	);
	generator.writeIdeIntegrationWorkspaceManifest(workspace);
	const manifest = completeSourceWorkspace(
		json(join(workspace, "package.json")),
		json(join(studio, "package.json")),
		studio,
		"../../",
	);
	save(join(workspace, "package.json"), {
		...manifest,
		overrides: { ...manifest.overrides, ...overrides },
	});
	copyFileSync(
		join(ide, ".ci/web-source.bun.lock"),
		join(workspace, "bun.lock"),
	);
	run(process.execPath, ["install", "--ignore-scripts"], workspace);
	run(
		process.execPath,
		["install", "--ignore-scripts", "--frozen-lockfile"],
		workspace,
	);
	copyFileSync(
		join(workspace, "bun.lock"),
		join(artifacts, "effective-web.bun.lock"),
	);
	generator.ensureIdeIntegrationPackageLinks(studio);
	const editor = join(studio, "packages/editor");
	run(
		process.execPath,
		["install", "--ignore-scripts", "--frozen-lockfile"],
		editor,
	);
	withOverrides(editor, overrides, () => {
		if (packed.length)
			run(process.execPath, ["install", "--ignore-scripts"], editor);
		copyFileSync(
			join(editor, "bun.lock"),
			join(artifacts, "effective-editor.bun.lock"),
		);
	});
	lintWorkspaceCandidates(candidates, (candidate) =>
		lintWorkspaceCandidateAgainstPackedGraph(candidate, packed),
	);
	verifyInstalledCandidates(ide, packed);
	save(planPath, { ...plan, packed });
}

function verify(): void {
	const { ide, studio, planPath } = paths();
	const plan: Plan = json(planPath);
	assertRevision(ide, plan.ide);
	assertRevision(studio, plan.studio);
	verifyInstalledCandidates(ide, plan.packed);
	const unsettled: string[] = [];
	canonicalOrigin(ide, IDE_REPOSITORY);
	if (!isIntegratedRevision(ide, plan.ide)) unsettled.push(IDE_REPOSITORY);
	for (const candidate of plan.candidates) {
		assertRevision(candidate.path, candidate);
		clean(candidate.path);
		if (candidate.primary) continue;
		canonicalOrigin(candidate.path, candidate.repository);
		if (!isIntegratedRevision(candidate.path, candidate))
			unsettled.push(candidate.repository);
	}
	// An unmerged companion can be built for diagnosis, but cannot leave a stale
	// green required check when it changes or closes. Integrate compatible layers
	// first, then rerun downstream PRs against the merged immutable commits.
	if (unsettled.length)
		throw new Error(
			"Joint Web build succeeded, but required check waits for companion commits to land on main: " +
				unsettled.join(", "),
		);
	console.log("All candidate inputs still match; companions are integrated.");
}

function record(): void {
	const { ide, studio, artifacts } = paths();
	const packages = Object.fromEntries(
		Object.entries(inventory.packages).map(([name, contract]) => {
			const installed = realpathSync(join(ide, "node_modules", name));
			const manifest = json(join(installed, "package.json"));
			return [
				name,
				{
					repository: contract.repository,
					mode: contract.mode,
					version: manifest.version,
					...("path" in contract
						? {
								revision: git(join(studio, contract.path), "rev-parse", "HEAD"),
								sourceDirty: !!git(
									join(studio, contract.path),
									"status",
									"--porcelain",
									"--untracked-files=no",
								),
							}
						: {}),
					...(manifest.forgeaxCiCandidate
						? { candidate: manifest.forgeaxCiCandidate }
						: {}),
				},
			];
		}),
	);
	const receipt = {
		schemaVersion: 1,
		ide: {
			repository: IDE_REPOSITORY,
			revision: git(ide, "rev-parse", "HEAD"),
			sourceDirty: !!git(ide, "status", "--porcelain", "--untracked-files=no"),
		},
		studio: {
			repository: "ForgeaX-Games/forgeax-studio",
			revision: git(studio, "rev-parse", "HEAD"),
		},
		packages,
		bun:
			process.versions.bun ??
			execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
		node: run("node", ["--version"], ide, true),
		webLockSha256: sha256(
			join(studio, ".forgeax/ide-source-workspace/bun.lock"),
		),
	};
	save(join(artifacts, "build-inputs.json"), receipt);
	console.log(JSON.stringify(receipt, null, 2));
}

if (import.meta.main) {
	const command = Bun.argv[2];
	if (command === "prepare") await prepare();
	else if (command === "verify") verify();
	else if (command === "record") record();
	else throw new Error("Expected prepare, record or verify");
}

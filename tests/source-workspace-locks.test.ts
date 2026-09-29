import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseConfigFileTextToJson } from "typescript";
import { expect, test } from "vitest";
import desktopBuildInputs from "../.ci/desktop-build-inputs.json";
import manifest from "../package.json";
import { registryIndependentLock } from "../scripts/registry-independent-lock";

for (const [name, path, workspaceKey] of [
	["web", "../.ci/web-source.bun.lock", "../../packages/ide"],
	["desktop", "../.ci/desktop-source.bun.lock", "packages/ide"],
]) {
	test(`${name} lock matches the IDE dependency declarations`, () => {
		const file = new URL(path, import.meta.url);
		const parsed = parseConfigFileTextToJson(
			file.pathname,
			readFileSync(file, "utf8"),
		);
		expect(parsed.error).toBeUndefined();
		expect(registryIndependentLock(readFileSync(file, "utf8"))).toBe(
			readFileSync(file, "utf8"),
		);
		const workspace = parsed.config.workspaces[workspaceKey];
		for (const field of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
		] as const) {
			expect(workspace[field]).toEqual(manifest[field]);
		}
	});
}

test("frozen Bun installs download from the environment registry and preserve integrity", async () => {
	const root = mkdtempSync(join(tmpdir(), "ide-registry-lock-"));
	const requests: string[] = [];
	let tarball: Buffer;
	const server = createServer((request, response) => {
		requests.push(request.url ?? "");
		response.end(tarball);
	});
	try {
		const packaged = join(root, "archive/package");
		mkdirSync(packaged, { recursive: true });
		writeFileSync(
			join(packaged, "package.json"),
			JSON.stringify({ name: "@fixture/registry", version: "1.2.3" }),
		);
		const archive = join(root, "package.tgz");
		execFileSync("tar", [
			"-czf",
			archive,
			"-C",
			join(root, "archive"),
			"package",
		]);
		tarball = readFileSync(archive);
		const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
		const lock = registryIndependentLock(`{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": { "": { "name": "fixture", "dependencies": { "@fixture/registry": "1.2.3" } } },
  "packages": {
    "@fixture/registry": ["@fixture/registry@1.2.3", "https://old-registry.invalid/npm/@fixture/registry/-/registry-1.2.3.tgz", {}, "${integrity}"],
  }
}`);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No registry port");
		for (const name of ["first", "second"]) {
			const cwd = join(root, name);
			mkdirSync(cwd);
			writeFileSync(
				join(cwd, "package.json"),
				JSON.stringify({
					name: "fixture",
					dependencies: { "@fixture/registry": "1.2.3" },
				}),
			);
			writeFileSync(join(cwd, "bun.lock"), lock);
			await promisify(execFile)(
				"bun",
				["install", "--frozen-lockfile", "--ignore-scripts"],
				{
					cwd,
					timeout: 5_000,
					env: {
						...process.env,
						BUN_CONFIG_REGISTRY: `http://127.0.0.1:${address.port}/${name}/`,
						BUN_INSTALL_CACHE_DIR: join(cwd, "cache"),
					},
				},
			);
			expect(readFileSync(join(cwd, "bun.lock"), "utf8")).toBe(lock);
			expect(
				JSON.parse(
					readFileSync(
						join(cwd, "node_modules/@fixture/registry/package.json"),
						"utf8",
					),
				).version,
			).toBe("1.2.3");
		}
		expect(requests).toEqual([
			"/first/@fixture/registry/-/registry-1.2.3.tgz",
			"/second/@fixture/registry/-/registry-1.2.3.tgz",
		]);
		// Retain explicit artifact locations instead of turning them into registry packages.
		const explicit = `{
  "direct": ["direct@https://example.com/direct.tgz", {}, "${integrity}"],
  "git": ["git@github:owner/repo#revision", {}],
  "local": ["local@workspace:packages/local"],
}`;
		expect(registryIndependentLock(explicit)).toBe(explicit);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	{
		scenario: "recovers from one interrupted download",
		interruptions: 1,
		corrupt: false,
	},
	{
		scenario: "fails after repeated interruptions",
		interruptions: Infinity,
		corrupt: false,
	},
	{
		scenario: "rejects a complete archive with the wrong integrity",
		interruptions: 0,
		corrupt: true,
	},
])("frozen Bun install $scenario", async ({ interruptions, corrupt }) => {
	const root = mkdtempSync(join(tmpdir(), "ide-registry-transport-"));
	// Incompressible content exercises Bun's streaming extraction path (> 2 MiB).
	const content = randomBytes(3 * 1024 * 1024);
	let tarball: Buffer;
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(200, { "Content-Length": tarball.length });
		if (requests <= interruptions) {
			response.write(tarball.subarray(0, 600_000), () => response.destroy());
		} else {
			response.end(tarball);
		}
	});
	try {
		const packaged = join(root, "archive/package");
		mkdirSync(packaged, { recursive: true });
		writeFileSync(
			join(packaged, "package.json"),
			JSON.stringify({ name: "@fixture/transport", version: "1.0.0" }),
		);
		writeFileSync(join(packaged, "payload.bin"), content);
		const archive = join(root, "package.tgz");
		const pack = () => {
			execFileSync("tar", [
				"-czf",
				archive,
				"-C",
				join(root, "archive"),
				"package",
			]);
			return readFileSync(archive);
		};
		tarball = pack();
		expect(tarball.length).toBeGreaterThan(2 * 1024 * 1024);
		const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
		if (corrupt) {
			writeFileSync(
				join(packaged, "payload.bin"),
				Buffer.concat([content, Buffer.from("changed")]),
			);
			tarball = pack();
		}
		const workspace = {
			name: "fixture",
			dependencies: { "@fixture/transport": "1.0.0" },
		};
		const lock = JSON.stringify({
			lockfileVersion: 1,
			configVersion: 1,
			workspaces: { "": workspace },
			packages: {
				"@fixture/transport": ["@fixture/transport@1.0.0", "", {}, integrity],
			},
		});
		writeFileSync(join(root, "package.json"), JSON.stringify(workspace));
		writeFileSync(join(root, "bun.lock"), lock);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No registry port");
		const result = await new Promise<{
			code: number | string | null;
			stderr: string;
		}>((resolve) => {
			execFile(
				"bun",
				["install", "--frozen-lockfile", "--ignore-scripts"],
				{
					cwd: root,
					timeout: 5_000,
					env: {
						...process.env,
						BUN_CONFIG_REGISTRY: `http://127.0.0.1:${address.port}/`,
						BUN_INSTALL_CACHE_DIR: join(root, "cache"),
					},
				},
				(error, _stdout, stderr) =>
					resolve({ code: error ? (error.code ?? null) : 0, stderr }),
			);
		});
		expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(lock);
		if (corrupt) {
			expect(result.code, result.stderr).toBe(1);
			expect(result.stderr).toContain("Integrity check failed");
			expect(requests).toBe(1);
		} else if (interruptions === Infinity) {
			expect(result.code, result.stderr).toBe(1);
			expect(result.stderr).toContain("ConnectionClosed");
			expect(requests).toBeGreaterThan(1);
		} else {
			expect(result.code, result.stderr).toBe(0);
			expect(requests).toBe(2);
			const installed = readFileSync(
				join(root, "node_modules/@fixture/transport/payload.bin"),
			);
			// Compare every byte without traversing millions of Buffer properties.
			expect(installed.equals(content)).toBe(true);
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("desktop lock includes server workspaces and pinned browser overrides", () => {
	const file = new URL("../.ci/desktop-source.bun.lock", import.meta.url);
	const { config } = parseConfigFileTextToJson(
		file.pathname,
		readFileSync(file, "utf8"),
	);
	for (const name of ["server", "orchestrator", "agent-host"]) {
		expect(config.workspaces[`packages/${name}`]).toBeDefined();
	}
	expect(config.overrides.playwright).toBe(desktopBuildInputs.playwright);
	expect(config.overrides["playwright-core"]).toBe(
		desktopBuildInputs.playwright,
	);
});

test("desktop installation prepares the Editor config graph and rejects its lock drift", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-desktop-lock-"));
	const ide = join(root, "packages/ide");
	const editor = join(root, "packages/editor");
	const write = (path: string, contents: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	};
	const run = (command: string, args: string[], cwd = root) =>
		spawnSync(command, args, {
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, "cache") },
		});
	try {
		const originalManifest = JSON.stringify({ name: "fixture", private: true });
		write("package.json", originalManifest);
		write("bunfig.toml", '[install]\nlinker = "isolated"\n');
		write(
			"packages/ide/package.json",
			JSON.stringify({
				name: "@fixture/ide",
				packageManager: `bun@${execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()}`,
				dependencies: { "@forgeax/app-shell": "workspace:*" },
			}),
		);
		write(
			"packages/editor/package.json",
			JSON.stringify({
				name: "@fixture/editor",
				private: true,
				workspaces: ["packages/*"],
				dependencies: { "@fixture/panel": "workspace:*" },
			}),
		);
		write("packages/editor/bunfig.toml", '[install]\nlinker = "hoisted"\n');
		write(
			"packages/editor/packages/panel/package.json",
			JSON.stringify({
				name: "@fixture/panel",
				dependencies: { "@fixture/engine-ui": "workspace:*" },
			}),
		);
		write(
			"packages/editor/packages/ui/package.json",
			JSON.stringify({
				name: "@fixture/engine-ui",
				exports: { "./importer": "./importer.mjs" },
			}),
		);
		write(
			"packages/editor/packages/ui/importer.mjs",
			'export const ready = "ready";',
		);
		write(
			"packages/editor/probe.mjs",
			'import { ready } from "@fixture/engine-ui/importer"; console.log(ready);',
		);
		for (const name of ["server", "orchestrator", "agent-host"])
			write(`packages/${name}/package.json`, JSON.stringify({ name }));
		for (const name of ["app-shell", "recursive-input-contract"])
			write(
				`packages/${name}/package.json`,
				JSON.stringify({ name: `@forgeax/${name}`, version: "1.0.0" }),
			);
		write(
			"scripts/lib/ide-integration-workspace.ts",
			`export function createIdeIntegrationRootManifest(manifest) {
        return { ...manifest, workspaces: ['packages/ide', 'packages/editor', 'packages/editor/packages/*'], dependencies: { '@fixture/editor': 'workspace:*' } };
      }
      export function ensureIdeIntegrationPackageLinks() {}`,
		);
		const git = (...args: string[]) => {
			const result = run("git", ["-c", "core.hooksPath=/dev/null", ...args]);
			expect(result.status, result.stderr).toBe(0);
			return result.stdout.trim();
		};
		git("init", "-q");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		);
		write(
			"packages/ide/product/integration-inputs.json",
			JSON.stringify({
				studio: {
					repository: "ForgeaX-Games/forgeax-studio",
					revision: git("rev-parse", "HEAD"),
				},
			}),
		);
		for (const file of [
			"scripts/install-desktop-source-workspace.ts",
			"scripts/complete-source-workspace.ts",
			"scripts/registry-independent-lock.ts",
			"scripts/build-source-sidecar.ts",
			"scripts/release-artifact-identity.ts",
			"scripts/artifact-manifest.ts",
			"scripts/desktop-platforms.ts",
			"scripts/executable-identity.ts",
			".ci/desktop-build-inputs.json",
		])
			write(
				`packages/ide/${file}`,
				readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
			);

		const editorInstall = run("bun", ["install", "--ignore-scripts"], editor);
		expect(editorInstall.status, editorInstall.stderr).toBe(0);
		const editorLock = readFileSync(join(editor, "bun.lock"), "utf8");
		write("packages/ide/.ci/desktop-source.bun.lock", editorLock);
		// Start with no hoisted links, as on the cold desktop CI worker.
		for (const path of [
			"node_modules",
			"packages/panel/node_modules",
			"packages/ui/node_modules",
		])
			rmSync(join(editor, path), { recursive: true, force: true });
		const install = (...args: string[]) =>
			run("bun", ["scripts/install-desktop-source-workspace.ts", ...args], ide);
		const seeded = install("--update-lock");
		expect(seeded.status, seeded.stderr).toBe(0);
		const probe = run(process.execPath, ["probe.mjs"], editor);
		expect(probe.status, probe.stderr).toBe(0);
		expect(probe.stdout.trim()).toBe("ready");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
			originalManifest,
		);
		expect(existsSync(join(root, "bun.lock"))).toBe(false);
		expect(readFileSync(join(editor, "bun.lock"), "utf8")).toBe(editorLock);
		const frozen = install();
		expect(frozen.status, frozen.stderr).toBe(0);
		// A frozen install must not repair an incompatible Editor lock silently.
		writeFileSync(
			join(editor, "bun.lock"),
			editorLock.replaceAll("@fixture/panel", "@fixture/stale-panel"),
		);
		const stale = install();
		expect(stale.status).not.toBe(0);
		expect(stale.stderr).toContain("Editor dependency installation failed");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
			originalManifest,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);

// This executes six real, separately bounded Bun installs against a local-only
// graph. Keep the integration scenario bounded as a whole as well.
test("Web installs freeze the committed lock, reject drift, and update only when requested", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-web-lock-"));
	const ide = join(root, "packages/ide");
	try {
		for (const path of [
			"scripts/lib",
			"packages/ide/scripts",
			"packages/ide/.ci",
			"packages/editor/packages",
			"packages/member",
			"packages/other",
		]) {
			mkdirSync(join(root, path), { recursive: true });
		}
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture-root", private: true }),
		);
		for (const name of [
			"app-shell",
			"server",
			"orchestrator",
			"agent-host",
			"recursive-input-contract",
		]) {
			const path = join(root, "packages", name);
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "package.json"),
				JSON.stringify({ name: `@forgeax/${name}`, version: "1.0.0" }),
			);
		}
		writeFileSync(
			join(ide, "package.json"),
			JSON.stringify({
				packageManager: `bun@${execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()}`,
			}),
		);
		const member = join(root, "packages/member/package.json");
		writeFileSync(
			member,
			JSON.stringify({ name: "fixture-member", version: "1.0.0" }),
		);
		writeFileSync(
			join(root, "packages/other/package.json"),
			JSON.stringify({ name: "fixture-other", version: "1.0.0" }),
		);
		copyFileSync(
			new URL("../scripts/install-web-source-workspace.ts", import.meta.url),
			join(ide, "scripts/install-web-source-workspace.ts"),
		);
		copyFileSync(
			new URL("../scripts/registry-independent-lock.ts", import.meta.url),
			join(ide, "scripts/registry-independent-lock.ts"),
		);
		copyFileSync(
			new URL("../scripts/complete-source-workspace.ts", import.meta.url),
			join(ide, "scripts/complete-source-workspace.ts"),
		);
		// Keep the install process real; the fixture supplies a local-only integration graph.
		writeFileSync(
			join(root, "scripts/lib/ide-integration-workspace.ts"),
			`
      import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      export function writeIdeIntegrationWorkspaceManifest(path) {
        mkdirSync(path,{recursive:true});
        writeFileSync(join(path,'package.json'),JSON.stringify({name:'web-fixture',private:true,workspaces:['../../packages/member','../../packages/other'],dependencies:{'fixture-member':'workspace:*','@forgeax/app-shell':'workspace:*'}}));
      }
      export function ensureIdeIntegrationPackageLinks(root) { writeFileSync(join(root,'linked'),'ok'); }
    `,
		);
		writeFileSync(
			join(root, "scripts/lib/ide-install-diagnostics.ts"),
			`
      import {spawnSync} from 'node:child_process';
      export async function runIdeWorkspaceInstall({cwd,args,env}) { return spawnSync(process.execPath,args,{cwd,env,stdio:'inherit'}); }
    `,
		);
		const run = (...args: string[]) =>
			spawnSync("bun", ["scripts/install-web-source-workspace.ts", ...args], {
				cwd: ide,
				encoding: "utf8",
				timeout: 15000,
				env: {
					...process.env,
					BUN_INSTALL_CACHE_DIR: join(root, "cache"),
					TMPDIR: root,
				},
			});
		const lock = join(ide, ".ci/web-source.bun.lock");
		expect(run().status).not.toBe(0);
		expect(existsSync(join(root, "linked"))).toBe(false);
		const updated = run("--update-lock");
		if (updated.status !== 0) throw new Error(updated.stderr);
		const original = readFileSync(lock, "utf8");
		expect(run().status).toBe(0);
		expect(readFileSync(lock, "utf8")).toBe(original);
		rmSync(join(root, "linked"));
		const generator = join(root, "scripts/lib/ide-integration-workspace.ts");
		writeFileSync(
			generator,
			readFileSync(generator, "utf8").replace(
				"'fixture-member':'workspace:*'",
				"'fixture-member':'workspace:*','fixture-copy':'file:../../packages/other'",
			),
		);
		const stale = run();
		expect(stale.status).not.toBe(0);
		expect(stale.stderr).toContain("lockfile");
		expect(existsSync(join(root, "linked"))).toBe(false);
		expect(readFileSync(lock, "utf8")).toBe(original);
		expect(run("--update-lock").status).toBe(0);
		expect(readFileSync(lock, "utf8")).not.toBe(original);
		expect(run().status).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);

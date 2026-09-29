import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { materializeCiAppShell } from "../scripts/materialize-ci-app-shell";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("IDE pins remain exact when Studio mounts float, preserving injected Git configuration and dirty work", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-ci-app-shell-"));
	roots.push(root);
	const product = join(root, "packages/ide/product");
	mkdirSync(product, { recursive: true });
	const source = join(root, "source");
	mkdirSync(source);
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	git(source, "init", "-q");
	git(source, "config", "user.email", "fixture@example.invalid");
	git(source, "config", "user.name", "Fixture");
	writeFileSync(
		join(source, "package.json"),
		'{"name":"@forgeax/app-shell","version":"1.0.0"}\n',
	);
	git(source, "add", ".");
	git(source, "commit", "-qm", "first");
	const first = git(source, "rev-parse", "HEAD");
	writeFileSync(join(source, "second.txt"), "second");
	git(source, "add", ".");
	git(source, "commit", "-qm", "second");
	const second = git(source, "rev-parse", "HEAD");
	const url = "https://github.com/ForgeaX-Games/forgeax-app-shell.git";
	// An injected adapter configuration must survive without being copied into
	// the repository. Redirect to a local fixture so this test requires no token.
	vi.stubEnv("GIT_CONFIG_COUNT", "1");
	vi.stubEnv("GIT_CONFIG_KEY_0", `url.${source}.insteadOf`);
	vi.stubEnv("GIT_CONFIG_VALUE_0", url);
	// Studio's developer mount may follow main independently of the IDE input.
	writeFileSync(
		join(root, ".packages"),
		JSON.stringify([{ path: "packages/app-shell", url, branch: "main" }]),
	);
	const pin = (revision: string) =>
		writeFileSync(
			join(product, "integration-inputs.json"),
			JSON.stringify({
				schemaVersion: 1,
				appShell: { repository: "ForgeaX-Games/forgeax-app-shell", revision },
			}),
		);
	pin(first);
	expect(materializeCiAppShell(root)).toBe(first);
	const target = join(root, "packages/app-shell");
	expect(git(target, "remote", "get-url", "origin")).toBe(source);
	expect(readFileSync(join(target, ".git/config"), "utf8")).toContain(url);
	pin(second);
	expect(materializeCiAppShell(root)).toBe(second);
	writeFileSync(join(target, "second.txt"), "local change");
	pin(first);
	expect(() => materializeCiAppShell(root)).toThrow("must be clean");
	expect(readFileSync(join(target, "second.txt"), "utf8")).toBe("local change");
	pin("main");
	expect(() => materializeCiAppShell(root)).toThrow("immutable SHA");
});

test("invalid IDE inputs fail before creating an AppShell checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-ci-app-shell-input-"));
	roots.push(root);
	const product = join(root, "packages/ide/product");
	mkdirSync(product, { recursive: true });
	const appShell = {
		repository: "ForgeaX-Games/forgeax-app-shell",
		revision: "a".repeat(40),
	};
	for (const input of [
		null,
		{},
		{ schemaVersion: 1 },
		{ schemaVersion: 2, appShell },
		{ schemaVersion: 1, appShell: { ...appShell, repository: "other/repo" } },
		...[
			undefined,
			"main",
			"a".repeat(7),
			"A".repeat(40),
			`${appShell.revision}\n`,
		].map((revision) => ({
			schemaVersion: 1,
			appShell: { ...appShell, revision },
		})),
	]) {
		writeFileSync(
			join(product, "integration-inputs.json"),
			JSON.stringify(input),
		);
		expect(() => materializeCiAppShell(root)).toThrow("immutable SHA");
		expect(existsSync(join(root, "packages/app-shell"))).toBe(false);
	}
});

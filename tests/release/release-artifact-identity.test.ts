import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { submoduleRevision } from "../../scripts/release-artifact-identity";

const roots: string[] = [];

function root(name: string): string {
	const value = mkdtempSync(join(tmpdir(), `${name}-`));
	roots.push(value);
	return value;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim());
	return result.stdout.trim();
}

function repository(name: string): { root: string; revision: string } {
	const path = root(name);
	git(path, "init", "--quiet");
	git(path, "config", "user.name", "ForgeaX Test");
	git(path, "config", "user.email", "test@forgeax.invalid");
	writeFileSync(join(path, "fixture.txt"), name);
	git(path, "add", "fixture.txt");
	git(path, "commit", "--quiet", "-m", "fixture");
	return { root: path, revision: git(path, "rev-parse", "HEAD") };
}

function superproject(revision: string): string {
	const project = repository("release-artifact-superproject").root;
	git(
		project,
		"update-index",
		"--add",
		"--cacheinfo",
		`160000,${revision},packages/dependency`,
	);
	git(project, "commit", "--quiet", "-m", "pin dependency");
	return project;
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("release artifact submodule identity", () => {
	test("reads an unmaterialized submodule revision from the authoritative gitlink", () => {
		const dependency = repository("release-artifact-dependency");
		const project = superproject(dependency.revision);
		mkdirSync(join(project, "packages/dependency"), { recursive: true });

		expect(submoduleRevision(project, "packages/dependency")).toBe(
			dependency.revision,
		);
		expect(
			git(join(project, "packages/dependency"), "rev-parse", "HEAD"),
		).not.toBe(dependency.revision);
	});

	test("accepts a materialized submodule that matches its gitlink", () => {
		const dependency = repository("release-artifact-matching");
		const project = superproject(dependency.revision);
		mkdirSync(join(project, "packages"), { recursive: true });
		git(project, "clone", "--quiet", dependency.root, "packages/dependency");

		expect(submoduleRevision(project, "packages/dependency")).toBe(
			dependency.revision,
		);
	});

	test("fails closed when a materialized submodule disagrees with its gitlink", () => {
		const pinned = repository("release-artifact-pinned");
		const materialized = repository("release-artifact-materialized");
		const project = superproject(pinned.revision);
		mkdirSync(join(project, "packages"), { recursive: true });
		git(project, "clone", "--quiet", materialized.root, "packages/dependency");

		expect(() => submoduleRevision(project, "packages/dependency")).toThrow(
			"submodule revision mismatch",
		);
	});
});

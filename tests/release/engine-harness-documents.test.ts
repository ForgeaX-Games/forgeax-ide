import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { engineHarnessDocuments } from "../../scripts/engine-harness-documents";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "harness-documents-"));
	roots.push(root);
	const remote = join(root, "remote");
	mkdirSync(remote);
	const git = (args: string[], input?: string) =>
		execFileSync("git", args, {
			cwd: remote,
			input,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.com",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.com",
			},
		}).trim();
	git(["init", "--bare", "--quiet"]);
	git(["config", "uploadpack.allowFilter", "true"]);
	git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
	const blob = (text: string) => git(["hash-object", "-w", "--stdin"], text);
	const unused = blob("Large unreferenced research");
	const makeCommit = (text: string) => {
		const tree = git(
			["mktree"],
			[
				`100644 blob ${blob(text)}\tguide.md`,
				`100644 blob ${unused}\tunused.md`,
				`120000 blob ${blob("/outside.md")}\tunsafe.md`,
			].join("\n") + "\n",
		);
		const revision = git(
			["-c", "commit.gpgsign=false", "commit-tree", tree],
			"Fixture\n",
		);
		git(["update-ref", "refs/heads/main", revision]);
		return revision;
	};
	const repository = pathToFileURL(remote).href;
	const cacheRoot = join(root, "cache");
	return { root, remote, repository, cacheRoot, makeCommit, unused };
}

test("fetches only referenced blobs and reuses a pinned cache without remote access", () => {
	const f = fixture();
	const revision = f.makeCommit("Pinned guide");
	const options = {
		repository: f.repository,
		revision,
		cacheRoot: f.cacheRoot,
	};
	const documents = engineHarnessDocuments(options);
	expect(documents.read("guide.md")?.bytes.toString()).toBe("Pinned guide");
	expect(documents.read("missing.md")).toBeUndefined();
	expect(() => documents.read("unsafe.md")).toThrow("regular file");
	const cache = join(
		f.cacheRoot,
		createHash("sha256").update(f.repository).digest("hex"),
		revision,
	);
	const objects = execFileSync(
		"git",
		["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
		{ cwd: cache, encoding: "utf8" },
	);
	expect(objects.split("\n")).not.toContain(f.unused);
	renameSync(f.remote, join(f.root, "offline"));
	expect(
		engineHarnessDocuments(options).read("guide.md")?.bytes.toString(),
	).toBe("Pinned guide");
	expect(() => engineHarnessDocuments(options).read("unused.md")).toThrow(
		"failed",
	);
});

test("a changed pin uses different cached content and unsafe paths never access the remote", () => {
	const f = fixture();
	const first = f.makeCommit("First");
	const second = f.makeCommit("Second");
	const read = (revision: string) =>
		engineHarnessDocuments({
			repository: f.repository,
			revision,
			cacheRoot: f.cacheRoot,
		});
	expect(read(first).read("guide.md")?.bytes.toString()).toBe("First");
	expect(read(second).read("guide.md")?.bytes.toString()).toBe("Second");
	for (const path of [
		"../outside.md",
		"/absolute.md",
		"docs/../outside.md",
		"C:\\outside.md",
	])
		expect(() => read(first).read(path)).toThrow(
			"Unsafe harness document path",
		);
	expect(() => read("main")).toThrow("exact source commit");
});

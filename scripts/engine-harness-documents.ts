import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import input from "../product/engine-harness-input.json";

export type HarnessDocument = { bytes: Buffer; mode: number };
export type HarnessDocuments = {
	revision: string;
	read: (path: string) => HarnessDocument | undefined;
};

/** Build-time reader: cache Git objects, never check out or ship a harness clone. */
export function engineHarnessDocuments(
	options: { repository?: string; revision?: string; cacheRoot?: string } = {},
): HarnessDocuments {
	const repository = options.repository ?? input.repository;
	const revision = options.revision ?? input.revision;
	if (!/^[a-f0-9]{40}$/.test(revision))
		throw new Error("Harness documents require an exact source commit");
	const cache = join(
		options.cacheRoot ??
			process.env.FORGEAX_HARNESS_DOCUMENT_CACHE ??
			join(homedir(), ".cache/forgeax/engine-harness-documents"),
		createHash("sha256").update(repository).digest("hex"),
		revision,
	);
	let files: Map<string, { oid: string; mode: string }> | undefined;
	let token: string | undefined;
	function git(args: string[], optional = false): Buffer {
		const result = spawnSync(
			"git",
			[
				...(token
					? [
							"-c",
							`http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
						]
					: []),
				...args,
			],
			{
				cwd: cache,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				maxBuffer: 32 * 1024 * 1024,
			},
		);
		if (result.error || result.status !== 0) {
			if (optional) return Buffer.alloc(0);
			// Never include the authenticated command line in an exception.
			throw new Error(
				`Harness document ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString().trim()}`,
			);
		}
		return result.stdout;
	}
	function inventory(): Map<string, { oid: string; mode: string }> {
		if (files) return files;
		token =
			process.env.FORGEAX_HARNESS_TOKEN ||
			process.env.GITHUB_TOKEN ||
			process.env.GH_TOKEN;
		if (!token && repository.startsWith("https://github.com/")) {
			const auth = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
			if (auth.status === 0) token = auth.stdout.trim() || undefined;
		}
		mkdirSync(cache, { recursive: true });
		git(["init", "--bare", "--quiet"]);
		git(["config", "remote.origin.url", repository]);
		git(["config", "remote.origin.promisor", "true"]);
		git(["config", "remote.origin.partialclonefilter", "blob:none"]);
		const cached = git(
			["rev-parse", "--verify", "refs/forgeax/documents"],
			true,
		)
			.toString()
			.trim();
		if (cached !== revision) {
			git([
				"fetch",
				"--quiet",
				"--depth=1",
				"--no-tags",
				"--filter=blob:none",
				"origin",
				`${revision}:refs/forgeax/documents`,
			]);
			console.log(`[engine-harness-docs] fetched tree ${revision}`);
		}
		files = new Map();
		for (const entry of git(["ls-tree", "-r", "-t", "-z", revision])
			.toString("utf8")
			.split("\0")) {
			if (!entry) continue;
			const tab = entry.indexOf("\t");
			const [mode, type, oid] = entry.slice(0, tab).split(" ");
			if (
				mode &&
				oid &&
				(type === "blob" || type === "tree" || type === "commit")
			)
				files.set(entry.slice(tab + 1), { mode, oid });
		}
		return files;
	}
	return {
		revision,
		read(path) {
			if (
				path.includes("\\") ||
				path.includes(":") ||
				path.split("/").some((part) => !part || part === "." || part === "..")
			)
				throw new Error(`Unsafe harness document path: ${path}`);
			const entry = inventory().get(path);
			if (!entry || entry.mode === "040000") return undefined;
			if (entry.mode !== "100644" && entry.mode !== "100755")
				throw new Error(`Harness document must be a regular file: ${path}`);
			// Git's promisor remote downloads only a requested, uncached blob.
			return {
				bytes: git(["cat-file", "blob", entry.oid]),
				mode: entry.mode === "100755" ? 0o755 : 0o644,
			};
		},
	};
}

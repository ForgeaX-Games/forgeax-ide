import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	engineHarnessDocuments,
	type HarnessDocuments,
} from "./engine-harness-documents";

/** Package Engine-authored documentation; project installation belongs to Server. */
export function stageEngineProjectSkills(
	engineRoot: string,
	resourcesRoot: string,
	engineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: engineRoot,
		encoding: "utf8",
	}).trim(),
	harness: HarnessDocuments = engineHarnessDocuments(),
): string[] {
	if (!/^[a-f0-9]{40}$/.test(engineCommit))
		throw new Error("Engine skills require an exact source commit");
	const root = realpathSync(engineRoot);
	const sourceSkills = join(root, "skills");
	const prefix = "editor/packages/engine";
	const target = join(resourcesRoot, prefix);
	const skills = readdirSync(sourceSkills, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory(),
	);
	if (
		skills.length === 0 ||
		skills.some(
			(entry) => !existsSync(join(sourceSkills, entry.name, "SKILL.md")),
		)
	) {
		throw new Error("Engine skills payload has no valid SKILL.md inventory");
	}
	const insideRoot = (file: string): boolean => {
		const path = relative(root, file);
		return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
	};
	const required = new Set<string>();
	const visited = new Set<string>();
	let harnessUsed = false;
	const harnessRoot = join(root, ".forgeax-harness");
	const harnessPath = (file: string): string | undefined => {
		const path = relative(harnessRoot, file);
		return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
			? path
			: undefined;
	};
	rmSync(join(target, "skills"), { recursive: true, force: true });
	rmSync(join(target, ".forgeax-harness"), { recursive: true, force: true });
	const copy = (source: string, requiredHarness = true): void => {
		if (visited.has(source)) return;
		let research = harnessPath(source);
		if (research === undefined) {
			if (!existsSync(source) || !statSync(source).isFile()) return;
			const canonical = realpathSync(source);
			if (!insideRoot(canonical))
				throw new Error(
					`Engine skill file escapes source root: ${relative(root, source)}`,
				);
			research = harnessPath(canonical);
		}
		if (research === "") return;
		// Always use the pinned snapshot, even when a developer's floating
		// harness checkout happens to exist. Its contents are never changed.
		const document =
			research === undefined
				? undefined
				: harness.read(research.split(sep).join("/"));
		if (research !== undefined && !document) {
			if (requiredHarness)
				throw new Error(
					`Engine references a harness document absent at ${harness.revision}: ${research}`,
				);
			// Historical research contains unresolved draft links. Preserve them,
			// as before, while requiring every direct Engine documentation input.
			return;
		}
		visited.add(source);
		const path = relative(root, source);
		const destination = join(target, path);
		mkdirSync(dirname(destination), { recursive: true });
		if (document) {
			writeFileSync(destination, document.bytes);
			chmodSync(destination, document.mode);
			harnessUsed = true;
		} else copyFileSync(source, destination);
		required.add(`${prefix}/${path.split("\\").join("/")}`);
		if (!source.endsWith(".md")) return;
		const markdown =
			document?.bytes.toString("utf8") ?? readFileSync(source, "utf8");
		for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
			const href = match[1]!.split("#")[0]!;
			if (!href || /^[a-z]+:/i.test(href) || href.startsWith("/")) continue;
			let decoded: string;
			try {
				decoded = decodeURIComponent(href);
			} catch {
				continue;
			}
			const referenced = resolve(dirname(source), decoded);
			// SDK templates also contain links resolved only after publication.
			if (insideRoot(referenced)) copy(referenced, research === undefined);
		}
	};
	const scan = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) scan(path);
			else copy(path);
		}
	};
	scan(sourceSkills);
	writeFileSync(
		join(target, "engine-skills-version.json"),
		`${JSON.stringify({ engineCommit, ...(harnessUsed ? { harnessCommit: harness.revision } : {}) })}\n`,
	);
	required.add(`${prefix}/engine-skills-version.json`);
	return [...required].sort();
}

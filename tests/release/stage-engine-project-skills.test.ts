import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { stageEngineProjectSkills } from "../../scripts/stage-engine-project-skills";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const commit = "9c7d75d96e34effadafb4cef593c56214b68a45a";
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ide skills fixture "));
	roots.push(root);
	const engine = join(root, "Engine source");
	const resources = join(root, "App resources");
	const put = (path: string, text: string) => {
		const file = join(engine, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	put(
		"skills/forgeax-engine-sdk/SKILL.md",
		"[API](../../packages/app/README.md#entry)",
	);
	put(
		"packages/app/README.md",
		"[Types](src/index.ts) [cycle](../../skills/forgeax-engine-sdk/SKILL.md)",
	);
	put("packages/app/src/index.ts", "export interface BootstrapContext {}");
	return { root, engine, resources, put };
}

test("stages existing Engine documentation and its reference closure without Engine installer code", () => {
	const f = fixture();
	const files = stageEngineProjectSkills(f.engine, f.resources, commit);
	const base = join(f.resources, "editor/packages/engine");
	expect(files).toEqual([
		"editor/packages/engine/engine-skills-version.json",
		"editor/packages/engine/packages/app/README.md",
		"editor/packages/engine/packages/app/src/index.ts",
		"editor/packages/engine/skills/forgeax-engine-sdk/SKILL.md",
	]);
	expect(
		JSON.parse(readFileSync(join(base, "engine-skills-version.json"), "utf8")),
	).toEqual({ engineCommit: commit });
	expect(readFileSync(join(base, "packages/app/README.md"), "utf8")).toContain(
		"[Types](src/index.ts)",
	);
	expect(existsSync(join(base, "packages/devkit/src/skill-install.ts"))).toBe(
		false,
	);
	expect(existsSync(join(f.engine, "scripts/stage-project-skills.mjs"))).toBe(
		false,
	);
	for (const file of files)
		expect(existsSync(join(f.resources, file))).toBe(true);
});

test("keeps unresolved SDK document template links and excludes external or outside-root references", () => {
	const f = fixture();
	f.put(
		"skills/forgeax-engine-sdk/SDK-README.md",
		"[SDK root](sdk/README.md) [external](https://example.com/guide) [outside](../../../outside.md)",
	);
	writeFileSync(join(f.root, "outside.md"), "not an Engine resource");
	const files = stageEngineProjectSkills(f.engine, f.resources, commit);
	expect(files.some((file) => file.includes("outside"))).toBe(false);
	expect(
		readFileSync(
			join(
				f.resources,
				"editor/packages/engine/skills/forgeax-engine-sdk/SDK-README.md",
			),
			"utf8",
		),
	).toContain("[SDK root](sdk/README.md)");
});

for (const harnessExists of [false, true]) {
	test(`stages only pinned referenced documents when harness exists=${harnessExists}`, () => {
		const f = fixture();
		const source = [
			"[Types](src/index.ts)",
			"[Example](examples/start.ts#main)",
			"[Design](../../.forgeax-harness/docs/Design%20%28v2%29.md#design-notes)",
			"[Knowledge](../../.forgeax-harness/knowledge-base/类型.md#用法)",
			"[Other](../../.forgeax-harness-extra/api.md)",
			"[External](https://example.com/api#entry)",
			"[cycle](../../skills/forgeax-engine-sdk/SKILL.md)",
		].join("\n");
		f.put("packages/app/README.md", source);
		f.put("packages/app/examples/start.ts", "export function main() {}");
		f.put(
			"skills/forgeax-engine-sdk/scripts/check.mjs",
			"console.log('skill')",
		);
		f.put(".forgeax-harness-extra/api.md", "Normal product API reference");
		if (harnessExists) {
			f.put(
				".forgeax-harness/docs/Design (v2).md",
				"[Secret](../../secret.txt)",
			);
			f.put(".forgeax-harness/knowledge-base/类型.md", "Research notes");
			f.put("secret.txt", "Must not follow research references");
		}
		const base = join(f.resources, "editor/packages/engine");
		mkdirSync(join(base, ".forgeax-harness"), { recursive: true });
		writeFileSync(join(base, ".forgeax-harness/stale.md"), "Old staging");
		const documents = new Map([
			["docs/Design (v2).md", "[Detail](detail.md#notes)"],
			["docs/detail.md", "Pinned design details [draft](missing.md)"],
			["knowledge-base/类型.md", "Pinned type documentation"],
			["unused.md", "Unreferenced research"],
		]);
		const files = stageEngineProjectSkills(f.engine, f.resources, commit, {
			revision: "b".repeat(40),
			read(path) {
				const text = documents.get(path);
				return text === undefined
					? undefined
					: { bytes: Buffer.from(text), mode: 0o644 };
			},
		});
		expect(files).toContain("editor/packages/engine/packages/app/src/index.ts");
		expect(files).toContain(
			"editor/packages/engine/packages/app/examples/start.ts",
		);
		expect(files).toContain(
			"editor/packages/engine/skills/forgeax-engine-sdk/scripts/check.mjs",
		);
		expect(files).toContain(
			"editor/packages/engine/.forgeax-harness-extra/api.md",
		);
		expect(files.filter((file) => file.includes("/.forgeax-harness/"))).toEqual(
			[
				"editor/packages/engine/.forgeax-harness/docs/Design (v2).md",
				"editor/packages/engine/.forgeax-harness/docs/detail.md",
				"editor/packages/engine/.forgeax-harness/knowledge-base/类型.md",
			],
		);
		expect(
			readFileSync(join(base, ".forgeax-harness/docs/detail.md"), "utf8"),
		).toBe("Pinned design details [draft](missing.md)");
		expect(existsSync(join(base, ".forgeax-harness/stale.md"))).toBe(false);
		expect(existsSync(join(base, ".forgeax-harness/unused.md"))).toBe(false);
		expect(existsSync(join(base, "secret.txt"))).toBe(false);
		expect(readFileSync(join(base, "packages/app/README.md"), "utf8")).toBe(
			source,
		);
		expect(
			JSON.parse(
				readFileSync(join(base, "engine-skills-version.json"), "utf8"),
			),
		).toEqual({ engineCommit: commit, harnessCommit: "b".repeat(40) });
		expect(readFileSync(join(f.engine, "packages/app/README.md"), "utf8")).toBe(
			source,
		);
		if (harnessExists)
			expect(
				readFileSync(
					join(f.engine, ".forgeax-harness/docs/Design (v2).md"),
					"utf8",
				),
			).toBe("[Secret](../../secret.txt)");
	});
}

test.skipIf(process.platform === "win32")(
	"reads harness aliases from the pinned snapshot without including checkout content",
	() => {
		const f = fixture();
		f.put(".forgeax-harness/docs/research.md", "[Private](../../secret.txt)");
		f.put("secret.txt", "Private research dependency");
		symlinkSync(
			join(f.engine, ".forgeax-harness/docs/research.md"),
			join(f.engine, "skills/forgeax-engine-sdk/research.md"),
		);
		f.put(
			"skills/forgeax-engine-sdk/SKILL.md",
			"[Research](research.md#notes)",
		);
		const files = stageEngineProjectSkills(f.engine, f.resources, commit, {
			revision: "b".repeat(40),
			read: () => ({ bytes: Buffer.from("Pinned research"), mode: 0o644 }),
		});
		expect(files).toEqual([
			"editor/packages/engine/engine-skills-version.json",
			"editor/packages/engine/skills/forgeax-engine-sdk/SKILL.md",
			"editor/packages/engine/skills/forgeax-engine-sdk/research.md",
		]);
		expect(
			readFileSync(
				join(
					f.resources,
					"editor/packages/engine/skills/forgeax-engine-sdk/SKILL.md",
				),
				"utf8",
			),
		).toBe("[Research](research.md#notes)");
		expect(
			readFileSync(
				join(
					f.resources,
					"editor/packages/engine/skills/forgeax-engine-sdk/research.md",
				),
				"utf8",
			),
		).toBe("Pinned research");
	},
);

test("fails when the pinned snapshot cannot supply a direct Engine reference", () => {
	const f = fixture();
	f.put(
		"packages/app/README.md",
		"[Design](../../.forgeax-harness/docs/new.md)",
	);
	expect(() =>
		stageEngineProjectSkills(f.engine, f.resources, commit, {
			revision: "b".repeat(40),
			read: () => undefined,
		}),
	).toThrow("Engine references a harness document absent at");
});

test("uses native filesystem joins with portable manifest paths and refreshes a prior staging", () => {
	const f = fixture();
	f.put(
		"skills/forgeax-engine-sdk/references/path with spaces.md",
		"platform-neutral reference",
	);
	stageEngineProjectSkills(f.engine, f.resources, commit);
	const stale = join(
		f.resources,
		"editor/packages/engine/skills/stale/SKILL.md",
	);
	mkdirSync(dirname(stale), { recursive: true });
	writeFileSync(stale, "stale");
	const files = stageEngineProjectSkills(f.engine, f.resources, commit);
	expect(existsSync(stale)).toBe(false);
	expect(files).toContain(
		"editor/packages/engine/skills/forgeax-engine-sdk/references/path with spaces.md",
	);
	expect(
		files.every(
			(file) =>
				!file.includes("\\") &&
				!relative(f.resources, join(f.resources, file)).startsWith(".."),
		),
	).toBe(true);
});

test("rejects missing skill entrypoints and non-immutable source identity", () => {
	const f = fixture();
	mkdirSync(join(f.engine, "skills/broken"));
	expect(() => stageEngineProjectSkills(f.engine, f.resources, commit)).toThrow(
		"SKILL.md inventory",
	);
	expect(() =>
		stageEngineProjectSkills(f.engine, f.resources, "release20260901"),
	).toThrow("exact source commit");
});

test.skipIf(process.platform === "win32")(
	"rejects a skill symlink that escapes the Engine input",
	() => {
		const f = fixture();
		writeFileSync(join(f.root, "outside.md"), "private outside data");
		symlinkSync(
			join(f.root, "outside.md"),
			join(f.engine, "skills/forgeax-engine-sdk/outside.md"),
		);
		expect(() =>
			stageEngineProjectSkills(f.engine, f.resources, commit),
		).toThrow("escapes source root");
	},
);

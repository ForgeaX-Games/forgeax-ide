import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import idePackage from "../package.json";
import productManifest from "../product/forgeax-product.json";
import { inspectProductAgentRoster } from "../scripts/product-agent-roster";

const ideRoot = join(import.meta.dir, "..");
const fixtures: string[] = [];

afterEach(() => {
	for (const root of fixtures.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function productWithAvatar(media: Buffer): string {
	const root = mkdtempSync(join(tmpdir(), "forgeax-product-avatar-"));
	fixtures.push(root);
	const id = "@forgeax-test/agent";
	const version = "1.0.0";
	const packageRoot = join(root, "node_modules", id);
	mkdirSync(join(root, "product"), { recursive: true });
	mkdirSync(join(packageRoot, "avatar"), { recursive: true });
	writeFileSync(
		join(root, "product/forgeax-product.json"),
		JSON.stringify({ extensions: [{ id }] }),
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ optionalDependencies: { [id]: version } }),
	);
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: id, version }),
	);
	writeFileSync(
		join(packageRoot, "forgeax-extension.json"),
		JSON.stringify({ id, version, contributes: { agents: [{ id: "test" }] } }),
	);
	writeFileSync(
		join(packageRoot, "avatar/AVATAR.md"),
		"default: idle\nfallback: idle\n| idle | idle.webm |\n",
	);
	writeFileSync(join(packageRoot, "avatar/idle.webm"), media);
	return root;
}

describe("release product agent roster", () => {
	test("derives the unique agent catalog from exact packaged extension manifests plus the brand", () => {
		const roster = inspectProductAgentRoster(ideRoot);
		expect(roster.packageIds).toEqual(
			productManifest.extensions.map(({ id }) => id),
		);
		expect(roster.extensionAgentIds).toContain("reel-editor");
		expect(roster.agentIds).toEqual(["forge", ...roster.extensionAgentIds]);
		expect(new Set(roster.agentIds).size).toBe(roster.agentIds.length);
	});

	test("accepts a WEBM header followed by payload", () => {
		const root = productWithAvatar(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]));
		expect(inspectProductAgentRoster(root).avatarResources).toEqual([
			{
				packageId: "@forgeax-test/agent",
				agentId: "test",
				rulesFile: "avatar/AVATAR.md",
				mediaFiles: ["avatar/idle.webm"],
			},
		]);
	});

	test.each([
		["empty", Buffer.alloc(0)],
		["truncated header", Buffer.from([0x1a, 0x45, 0xdf])],
		["header without payload", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
		["invalid header", Buffer.from([0x00, 0x45, 0xdf, 0xa3, 0x01])],
	] as const)("rejects %s avatar media", (_label, media) => {
		const root = productWithAvatar(media);
		expect(() => inspectProductAgentRoster(root)).toThrow(
			"avatar media is not a non-empty WEBM container: avatar/idle.webm",
		);
	});

	test("requires complete package-owned WEBM rules for every animated persona", () => {
		const roster = inspectProductAgentRoster(ideRoot);
		expect(roster.animatedAgentIds.length).toBeGreaterThan(0);
		expect(roster.animatedAgentIds).toContain("reel-editor");
		expect(roster.animatedAgentIds).not.toContain("sino");
		expect(roster.animatedAgentIds).not.toContain("audio-designer");
		for (const resource of roster.avatarResources) {
			expect(resource.rulesFile).toEndWith("AVATAR.md");
			expect(resource.mediaFiles).toHaveLength(9);
			expect(new Set(resource.mediaFiles).size).toBe(9);
		}
	});

	test("locks every product selection to the same exact dependency version", () => {
		const lock = Bun.JSONC.parse(
			readFileSync(join(ideRoot, ".ci/web-source.bun.lock"), "utf8"),
		) as {
			workspaces: Record<
				string,
				{ optionalDependencies?: Record<string, string> }
			>;
			packages: Record<string, [string, string, unknown, string]>;
		};
		const selected =
			lock.workspaces["../../packages/ide"]?.optionalDependencies;
		for (const { id } of productManifest.extensions) {
			const version = (
				idePackage.optionalDependencies as Record<string, string>
			)[id];
			expect(selected?.[id], `${id} workspace lock`).toBe(version);
			expect(lock.packages[id]?.[0], `${id} package lock`).toBe(
				`${id}@${version}`,
			);
			expect(lock.packages[id]?.[3], `${id} package integrity`).toMatch(
				/^sha512-/,
			);
		}
	});
});

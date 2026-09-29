import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import idePackage from "../package.json";
import productManifest from "../product/forgeax-product.json";
import { buildDiagnosticComponents } from "../scripts/diagnostics";
import { selectBuiltinExtensions } from "../src/product/extension-selection";
import { buildProductRuntimeReport } from "../src/runtime/product-runtime-report";

const expectedExtensions = [
	{ id: "@forgeax-extension/scene-generator", required: false },
	{ id: "@forgeax-extension/game-video", required: false },
	{ id: "@forgeax-extension/bgm", required: false },
	{ id: "@forgeax-extension/agent-audio-designer", required: false },
	{ id: "@forgeax-extension/agent-iro", required: false },
	{ id: "@forgeax-extension/agent-animator-2d", required: false },
	{ id: "@forgeax-extension/agent-vfx-artist-3d", required: false },
	{ id: "@forgeax-extension/agent-lowpoly", required: false },
	{ id: "@forgeax-extension/agent-director", required: false },
	{ id: "@forgeax-extension/agent-mira", required: false },
	{ id: "@forgeax-extension/reel", required: false },
	{ id: "@forgeax-extension/agent-mochi", required: false },
	{ id: "@forgeax-extension/agent-rin", required: false },
	{ id: "@forgeax-extension/agent-sakura", required: false },
	{ id: "@forgeax-extension/agent-kaede", required: false },
	{ id: "@forgeax-extension/agent-kumo", required: false },
	{ id: "@forgeax-extension/agent-cc-coder", required: false },
	{ id: "@forgeax-extension/agent-claude-code-default", required: false },
	{ id: "@forgeax-extension/agent-codex-default", required: false },
	{ id: "@forgeax-extension/agent-cursor-default", required: false },
	{ id: "@forgeax-extension/agent-suzu", required: false },
	{ id: "@forgeax-extension/agent-kotone", required: false },
	{ id: "@forgeax-extension/agent-tsumugi", required: false },
	{ id: "@forgeax-extension/agent-ai-asset", required: false },
	{ id: "@forgeax-extension/agent-ui-designer", required: false },
	{ id: "@forgeax-extension/agent-gen3d", required: false },
	{ id: "@forgeax-extension/agent-nodia", required: false },
	{ id: "@forgeax-extension/agent-yevi", required: false },
	{ id: "@forgeax-extension/agent-lock", required: false },
	{ id: "@forgeax-extension/agent-monitor", required: false },
	{ id: "@forgeax-extension/diffusion-renderer", required: false },
	{ id: "@forgeax-extension/plugin-author", required: false },
	{ id: "@forgeax-extension/model-anthropic-text", required: false },
	{ id: "@forgeax-extension/skill-author-plugin", required: false },
	{ id: "@forgeax-extension/skill-make-game-design", required: false },
	{ id: "@forgeax-extension/team-forge", required: false },
	{ id: "@forgeax-extension/tool-balance-resim", required: false },
	{ id: "@forgeax-extension/ai-asset", required: false },
	{ id: "@forgeax-extension/character-3d", required: false },
	{ id: "@forgeax-extension/animation", required: false },
	{ id: "@forgeax-extension/skill-effects", required: false },
	{ id: "@forgeax-extension/system-configuration", required: false },
	{ id: "@forgeax-extension/agent-persona", required: false },
	{ id: "@forgeax-extension/game-balance", required: false },
	{ id: "@forgeax-extension/source-navigation", required: false },
	{ id: "@forgeax-extension/color-grading", required: false },
];

describe("IDE product extension manifest", () => {
	test("is the explicit authority for built-in product extensions", () => {
		expect(productManifest.extensions).toEqual(expectedExtensions);
		expect(new Set(productManifest.extensions.map(({ id }) => id)).size).toBe(
			productManifest.extensions.length,
		);
	});

	test("pins every optional extension as an exact optional npm dependency", () => {
		for (const extension of productManifest.extensions) {
			const version = (
				idePackage.optionalDependencies as Record<string, string>
			)[extension.id];
			expect(
				version,
				`${extension.id} must be optional in @forgeax/ide`,
			).toMatch(/^\d+\.\d+\.\d+$/);
			expect(
				(idePackage.dependencies as Record<string, string>)[extension.id],
			).toBeUndefined();
		}
	});

	test("derives runtime selection from the product manifest", () => {
		expect(selectBuiltinExtensions()).toEqual(
			expectedExtensions.map(({ id, required }) => ({
				id,
				required,
				version: (idePackage.optionalDependencies as Record<string, string>)[
					id
				],
			})),
		);
	});

	test("propagates declared optionality into product diagnostics", () => {
		expect(
			buildDiagnosticComponents().filter(({ kind }) => kind === "extension"),
		).toEqual(
			expect.arrayContaining(
				expectedExtensions.map(({ id, required }) =>
					expect.objectContaining({ id, required }),
				),
			),
		);
	});

	test("recognizes an installed resource extension without a JavaScript entry", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-resource-extension-"));
		try {
			const id = "@forgeax-extension/bgm";
			const directory = join(root, "node_modules", id);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({ name: id, version: "0.6.0" }),
			);
			const resolve = createRequire(join(root, "package.json")).resolve;
			expect(() => resolve(id)).toThrow();
			expect(buildDiagnosticComponents(resolve)).toContainEqual(
				expect.objectContaining({ id, status: "ready" }),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports a missing optional package as degraded without throwing", () => {
		const missingId = "@forgeax-extension/bgm";
		const components = buildDiagnosticComponents((id) => {
			if (id === `${missingId}/package.json`)
				throw new Error("package unavailable");
			return `/packages/${id}`;
		});
		const report = buildProductRuntimeReport(components);

		expect(report.status).toBe("degraded");
		expect(report.components).toContainEqual(
			expect.objectContaining({
				id: missingId,
				required: false,
				status: "failed",
				phase: "resolve-package",
			}),
		);
		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "IDE_OPTIONAL_COMPONENT_FAILED",
				component: missingId,
				retryable: true,
			}),
		);
	});

	test("keeps product intent in one manifest without legacy artifact locks", () => {
		expect(productManifest.services).toEqual([
			{
				id: "forgeax-server",
				version: "0.1.0",
				source: "released-service",
				required: true,
			},
		]);
		expect(
			existsSync(
				join(import.meta.dirname, "../product/builtin-extensions.lock.json"),
			),
		).toBe(false);
		expect(
			existsSync(join(import.meta.dirname, "../product/services.lock.json")),
		).toBe(false);
		expect(
			existsSync(join(import.meta.dirname, "../release/ide-release.lock.json")),
		).toBe(false);
	});
});

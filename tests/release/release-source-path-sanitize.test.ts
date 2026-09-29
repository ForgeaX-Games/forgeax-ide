import { describe, expect, it } from "vitest";
import {
	sanitizeReleaseSourceCode,
	sanitizeReleaseSourcePaths,
} from "../../scripts/release-source-path-sanitize";

describe("release source path sanitizer", () => {
	it("normalizes final shader manifest source paths to stable product-relative paths", () => {
		const integrationRoot =
			"/home/you/work/forgeax-ide/forgeax-ide/forgeax-studio";
		const manifest = JSON.stringify({
			materialShaders: [
				{
					identifier: "forgeax::custom",
					sourcePath: `${integrationRoot}/packages/editor/packages/engine/packages/render/src/custom.wgsl`,
				},
			],
		});

		const sanitized = sanitizeReleaseSourcePaths(manifest, integrationRoot);

		expect(JSON.parse(sanitized)).toEqual({
			materialShaders: [
				{
					identifier: "forgeax::custom",
					sourcePath: "editor/packages/engine/packages/render/src/custom.wgsl",
				},
			],
		});
		expect(sanitized).not.toContain(integrationRoot);
		expect(sanitized).not.toContain("packages/editor");
	});

	for (const cachedRoot of [
		"/Users/you/studio/.worktrees/previous/editor",
		"/home/you/previous/packages/editor",
		"C:\\agent\\previous\\packages\\editor",
	]) {
		it(`normalizes cached shader metadata from ${cachedRoot}`, () => {
			const shader = "editor/packages/engine/packages/shader/src/default.wgsl";
			const sourcePath = `${cachedRoot}/packages/engine/packages/shader/src/default.wgsl`;
			const composedWgsl = "// sourcePath remains shader text";
			const manifest = {
				materialShaders: [
					{ identifier: "forgeax::default", sourcePath, composedWgsl },
				],
			};
			const sanitized = sanitizeReleaseSourcePaths(
				JSON.stringify(manifest),
				"/different/current/studio",
			);
			expect(JSON.parse(sanitized)).toEqual({
				materialShaders: [
					{ identifier: "forgeax::default", sourcePath: shader, composedWgsl },
				],
			});
			expect(
				sanitizeReleaseSourcePaths(sanitized, "/different/current/studio"),
			).toBe(sanitized);
		});
	}

	it("does not rewrite Vite module ids during source transformation", () => {
		const moduleId =
			"\0/home/you/work/forgeax-ide/forgeax-ide/forgeax-studio/packages/ide/node_modules/react/jsx-runtime.js";
		expect(sanitizeReleaseSourceCode(moduleId)).toBe(moduleId);
	});
});

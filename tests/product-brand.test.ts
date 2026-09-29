import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer } from "vite";
import { afterEach, expect, test } from "vitest";
import { __probeBrand, vitePluginBrand } from "../scripts/vite-plugin-brand";

const roots: string[] = [];
const originalBrand = process.env.FORGEAX_BRAND;
const originalDirectory = process.env.FORGEAX_BRAND_DIR;

afterEach(() => {
	if (originalBrand === undefined) delete process.env.FORGEAX_BRAND;
	else process.env.FORGEAX_BRAND = originalBrand;
	if (originalDirectory === undefined) delete process.env.FORGEAX_BRAND_DIR;
	else process.env.FORGEAX_BRAND_DIR = originalDirectory;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ide-product-brand-")));
	roots.push(root);
	const packageDir = join(root, "packages/ide");
	const brandRoot = join(root, "brand");
	mkdirSync(packageDir, { recursive: true });
	delete process.env.FORGEAX_BRAND;
	delete process.env.FORGEAX_BRAND_DIR;
	for (const id of ["forgeax", "custom"]) {
		mkdirSync(join(brandRoot, `defaults.${id}/assets/nested`), {
			recursive: true,
		});
		writeFileSync(
			join(brandRoot, `defaults.${id}.json`),
			JSON.stringify({
				id,
				schemaVersion: 1,
				product: { name: `${id} Studio`, shortName: id, tagline: "Product" },
				assistant: { name: "Forge" },
				splash: {
					title: `${id} boot`,
					subtitle: "Loading",
					theme: "classic-lime",
				},
				providers: {
					native: { id: "forgeax", label: "Native", title: "Native" },
				},
				links: {
					repoUrl: "https://example.com/repo",
					communityUrl: "https://example.com/community",
				},
				assets: { logo: "nested/logo.svg" },
			}),
		);
		writeFileSync(
			join(brandRoot, `defaults.${id}/assets/nested/logo.svg`),
			`<svg>${id}</svg>`,
		);
	}
	writeFileSync(
		join(packageDir, "index.html"),
		"<html><head><title>%BRAND_PRODUCT_NAME%</title><script>window.earlyBrand = window.__BRAND__.config.id;</script></head><body>%BRAND_ASSISTANT_NAME%</body></html>",
	);
	return { root, packageDir, brandRoot };
}

test("IDE resolves the default, active selection and environment-selected product brand", () => {
	const { packageDir, brandRoot } = fixture();
	expect(__probeBrand(packageDir).config.id).toBe("forgeax");
	symlinkSync("defaults.custom", join(brandRoot, "active"));
	expect(__probeBrand(packageDir).source.kind).toBe("symlink");
	expect(__probeBrand(packageDir).config.id).toBe("custom");
	process.env.FORGEAX_BRAND = "forgeax";
	expect(__probeBrand(packageDir).source.kind).toBe("env");
	expect(__probeBrand(packageDir).config.id).toBe("forgeax");
	process.env.FORGEAX_BRAND_DIR = brandRoot;
	expect(__probeBrand(packageDir).source.kind).toBe("override-dir");
});

test("IDE injects brand before bootstrap and serves the same selected assets in dev and build", async () => {
	const { packageDir } = fixture();
	process.env.FORGEAX_BRAND = "custom";
	const server = await createServer({
		root: packageDir,
		configFile: false,
		logLevel: "silent",
		plugins: [vitePluginBrand({ packageDir })],
		server: { host: "127.0.0.1", port: 0, hmr: false },
	});
	try {
		await server.listen();
		const address = server.httpServer!.address();
		if (!address || typeof address === "string")
			throw new Error("Expected TCP address");
		const origin = `http://127.0.0.1:${address.port}`;
		const html = await (await fetch(origin)).text();
		expect(html).toContain("<title>custom Studio</title>");
		expect(html.indexOf("window.__BRAND__=")).toBeLessThan(
			html.indexOf("window.earlyBrand"),
		);
		expect(html).toContain('"assetBaseUrl":"/brand/assets/"');
		expect(
			await (await fetch(`${origin}/brand/assets/nested/logo.svg`)).text(),
		).toBe("<svg>custom</svg>");
	} finally {
		await server.close();
	}
	await build({
		root: packageDir,
		configFile: false,
		logLevel: "silent",
		plugins: [vitePluginBrand({ packageDir })],
	});
	expect(
		readFileSync(join(packageDir, "dist/brand/assets/nested/logo.svg"), "utf8"),
	).toBe("<svg>custom</svg>");
	const html = readFileSync(join(packageDir, "dist/index.html"), "utf8");
	expect(html.indexOf("window.__BRAND__=")).toBeLessThan(
		html.indexOf("window.earlyBrand"),
	);
});

test("IDE refuses an absent or mismatched brand instead of silently selecting another product", () => {
	const { packageDir, brandRoot } = fixture();
	process.env.FORGEAX_BRAND = "missing";
	expect(() => __probeBrand(packageDir)).toThrow("manifest not found");
	process.env.FORGEAX_BRAND = "custom";
	writeFileSync(
		join(brandRoot, "defaults.custom.json"),
		JSON.stringify({ id: "wrong", schemaVersion: 1 }),
	);
	expect(() => __probeBrand(packageDir)).toThrow("does not match pack id");
});

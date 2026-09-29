import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Each launch owns its mutable files, even when another App uses the same projects. */
export function materializeEngineWorkspace(
	resourceRoot: string,
	projectRoot: string,
): string {
	const source = join(resourceRoot, "engine");
	for (const required of [
		"vite.config.mjs",
		"package.json",
		"src",
		"node_modules/vite/bin/vite.js",
	]) {
		if (!existsSync(join(source, required)))
			throw new Error(
				`packaged engine resource is missing: engine/${required}`,
			);
	}
	const workspaces = join(projectRoot, ".forgeax", "runtime");
	mkdirSync(workspaces, { recursive: true });
	const destination = mkdtempSync(join(workspaces, "engine-"));
	try {
		for (const entry of [
			"index.html",
			"vite.config.mjs",
			"package.json",
			"tsconfig.json",
			"rhi-debug-config.ts",
		]) {
			const input = join(source, entry);
			const output = join(destination, entry);
			rmSync(output, { recursive: true, force: true });
			if (existsSync(input)) copyFileSync(input, output);
		}
		for (const entry of ["src", "public"]) {
			const input = join(source, entry);
			const output = join(destination, entry);
			rmSync(output, { recursive: true, force: true });
			if (existsSync(input))
				cpSync(input, output, {
					recursive: true,
					dereference: true,
					force: true,
				});
		}
		mkdirSync(join(projectRoot, ".forgeax", "games"), { recursive: true });
		// Dependencies and immutable assets stay in the signed application resource
		// tree. Vite receives that root explicitly and writes only source mounts and
		// caches below this user-owned workspace. This avoids Windows junctions
		// between Program Files/resources and the user project drive.
		rmSync(join(destination, "node_modules"), { recursive: true, force: true });
		rmSync(join(destination, "forgeax-editor-assets"), {
			recursive: true,
			force: true,
		});
		rmSync(join(destination, "forgeax-engine-assets"), {
			recursive: true,
			force: true,
		});
		rmSync(join(destination, ".forgeax"), { recursive: true, force: true });
		rmSync(join(destination, "shared-assets"), {
			recursive: true,
			force: true,
		});
		rmSync(join(destination, "engine-assets"), {
			recursive: true,
			force: true,
		});
		// The packaged Vite config also repairs these links, but the runtime scope
		// controller can receive a project bind before that config-side effect has
		// completed. Materialize the immutable asset roots up front so every bind
		// sees existing roots and cannot fail with `plugin-root-missing`.
		symlinkSync(
			join(source, "forgeax-editor-assets"),
			join(destination, "shared-assets"),
			process.platform === "win32" ? "junction" : "dir",
		);
		symlinkSync(
			join(source, "forgeax-engine-assets"),
			join(destination, "engine-assets"),
			process.platform === "win32" ? "junction" : "dir",
		);
		return destination;
	} catch (error) {
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { platformTargets as sourceTargets } from "./desktop-platforms";
import { assertTargetExecutable } from "./executable-identity";
import { gitValue, submoduleRevision } from "./release-artifact-identity";

export { platformTargets as sourceTargets } from "./desktop-platforms";
export type SourcePlatform = keyof typeof sourceTargets;
export const DESKTOP_SOURCE_CONTEXT_PATH =
	"release-work/desktop-source-context.json";
export type SourceSidecarContext = {
	schema: "forgeax-server-source-build/v1";
	serviceVersion: string;
	platform: SourcePlatform;
	targetTriple: string;
	sourceRevisions: Record<string, string>;
	bunVersion: string;
	dependencyLockSha256: string;
	sha256: string;
	size: number;
};
export function assertSourceHost(
	platform: SourcePlatform,
	os = process.platform,
	arch = process.arch,
): void {
	const target = sourceTargets[platform];
	if (!target || target.os !== os || target.arch !== arch)
		throw new Error(`native build host mismatch: ${platform} on ${os}/${arch}`);
}
export function validateSourceBinary(
	context: SourceSidecarContext,
	bytes: Uint8Array,
	platform: SourcePlatform,
	version: string,
): void {
	if (
		context.schema !== "forgeax-server-source-build/v1" ||
		context.platform !== platform ||
		context.targetTriple !== sourceTargets[platform].triple ||
		context.serviceVersion !== version
	)
		throw new Error("source sidecar identity mismatch");
	if (
		context.size !== bytes.byteLength ||
		context.size < 1_048_576 ||
		createHash("sha256").update(bytes).digest("hex") !== context.sha256
	)
		throw new Error("source sidecar digest or size mismatch");
	assertTargetExecutable(bytes, platform);
}

export function assertSourceIntegration(root: string): void {
	const integration = JSON.parse(
		readFileSync(
			join(root, "packages/ide/product/integration-inputs.json"),
			"utf8",
		),
	).studio;
	const actual = gitValue(root, "rev-parse", "HEAD");
	if (
		integration.repository !== "ForgeaX-Games/forgeax-studio" ||
		actual !== integration.revision
	) {
		throw new Error(
			`Desktop build requires Studio ${integration.revision}; current checkout is ${actual}. Use a separate checkout matching product/integration-inputs.json before installing desktop dependencies.`,
		);
	}
}

export async function buildSourceSidecar(
	output: string,
	platform: SourcePlatform,
): Promise<SourceSidecarContext> {
	assertSourceHost(platform);
	const ide = resolve(import.meta.dirname, "..");
	const root = resolve(ide, "../..");
	const server = join(root, "packages/server");
	assertSourceIntegration(root);
	const target = sourceTargets[platform];
	const snapshot = (): Record<string, string> => {
		const result: Record<string, string> = {
			studio: gitValue(root, "rev-parse", "HEAD"),
		};
		for (const name of [
			"server",
			"orchestrator",
			"agent-host",
			"cli",
			"platform-io",
		]) {
			const path = join(root, "packages", name);
			result[name] = submoduleRevision(root, `packages/${name}`);
			if (gitValue(path, "status", "--porcelain", "--untracked-files=all"))
				throw new Error(`source checkout is dirty: ${name}`);
		}
		return result;
	};
	const revisions = snapshot();
	const version = JSON.parse(
		readFileSync(join(server, "package.json"), "utf8"),
	).version;
	const expectedVersion = JSON.parse(
		readFileSync(join(ide, "product/forgeax-product.json"), "utf8"),
	).services.find((s: { id: string }) => s.id === "forgeax-server")?.version;
	if (!/^\d+\.\d+\.\d+$/.test(version) || version !== expectedVersion)
		throw new Error("server source version does not match product");
	const expectedBun = JSON.parse(
		readFileSync(join(ide, "package.json"), "utf8"),
	).packageManager;
	if (`bun@${Bun.version}` !== expectedBun)
		throw new Error(`source compilation requires ${expectedBun}`);
	const destination = resolve(output);
	const temporary = `${destination}.build-${process.pid}`;
	if (existsSync(destination) || existsSync(temporary))
		throw new Error("source sidecar output already exists");
	mkdirSync(join(temporary, "sidecars"), { recursive: true });
	try {
		const file = join(
			temporary,
			"sidecars",
			`forgeax-server-${target.triple}${target.extension}`,
		);
		const entry = join(temporary, "entry.ts");
		writeFileSync(
			entry,
			`import ${JSON.stringify(join(ide, "scripts/server-native-preload.ts"))};
if (process.argv.includes('--verify-runtime-imports')) {
  const { chromium } = await import(${JSON.stringify(join(ide, "scripts/server-playwright-runtime.ts"))});
  console.log(JSON.stringify({code:'SERVER_RUNTIME_IMPORTS_OK', browser:chromium.name()}));
} else await import(${JSON.stringify(join(server, "src/main.ts"))});\n`,
		);
		const result = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			env: "disable",
			compile: { outfile: file, autoloadPackageJson: true },
			plugins: [
				{
					name: "packaged-server-playwright",
					setup(builder) {
						builder.onResolve({ filter: /^playwright$/ }, () => ({
							path: join(ide, "scripts/server-playwright-runtime.ts"),
						}));
					},
				},
			],
		});
		if (!result.success)
			throw new Error(
				`server source compilation failed: ${result.logs.join("\n")}`,
			);
		rmSync(entry);
		if (JSON.stringify(snapshot()) !== JSON.stringify(revisions))
			throw new Error("server source changed during compilation");
		const bytes = readFileSync(file);
		const context: SourceSidecarContext = {
			schema: "forgeax-server-source-build/v1",
			serviceVersion: version,
			platform,
			targetTriple: target.triple,
			sourceRevisions: revisions,
			bunVersion: Bun.version,
			dependencyLockSha256: createHash("sha256")
				.update(readFileSync(join(ide, ".ci/desktop-source.bun.lock")))
				.digest("hex"),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
		};
		validateSourceBinary(context, bytes, platform, version);
		if (!target.extension) chmodSync(file, 0o755);
		writeFileSync(
			join(temporary, "source-context.json"),
			`${JSON.stringify(context, null, 2)}\n`,
		);
		renameSync(temporary, destination);
		return context;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}
if (import.meta.main) {
	const argument = (name: string) => {
		const index = Bun.argv.indexOf(name);
		return index < 0 ? undefined : Bun.argv[index + 1];
	};
	const platform = argument("--platform") as SourcePlatform;
	const output = argument("--output");
	if (!output || !Object.hasOwn(sourceTargets, platform))
		throw new Error("--output and a supported --platform are required");
	console.log(JSON.stringify(await buildSourceSidecar(output, platform)));
}

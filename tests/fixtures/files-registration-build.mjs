import { resolve } from "node:path";
import { build } from "vite";
import {
	createIdeRuntimeAliases,
	IDE_RUNTIME_DEDUPE,
} from "../../scripts/vite-runtime-contract.ts";

const ideRoot = resolve(import.meta.dirname, "../..");
const interfaceRoot = resolve(ideRoot, "../interface");
function outputChunks(output) {
	const outputs = Array.isArray(output) ? output : [output];
	return outputs
		.flatMap((entry) => ("output" in entry ? entry.output : []))
		.filter((entry) => entry.type === "chunk");
}
const output = await build({
	configFile: false,
	logLevel: "silent",
	resolve: {
		alias: [
			...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
			{
				find: /^@forgeax\/interface\/(.+)$/,
				replacement: `${resolve(interfaceRoot, "src")}/$1`,
			},
			{
				find: /^@\/(.+)$/,
				replacement: `${resolve(interfaceRoot, "src")}/$1`,
			},
		],
		dedupe: [...IDE_RUNTIME_DEDUPE],
	},
	build: {
		write: false,
		minify: false,
		lib: {
			entry: resolve(import.meta.dirname, "files-registration.ts"),
			formats: ["iife"],
			name: "FilesRegistrationFixture",
		},
	},
});
const entry = outputChunks(output).find((chunk) => chunk.isEntry);
if (!entry) throw new Error("Files registration build produced no entry");
process.stdout.write(
	`FILES_REGISTRATION_BUNDLE:${JSON.stringify(entry.code)}\n`,
	() => process.exit(0),
);

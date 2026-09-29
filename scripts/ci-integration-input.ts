import { appendFileSync, readFileSync } from "node:fs";

export function resolveStudioIntegrationInput(value: unknown): {
	repository: string;
	revision: string;
} {
	if (
		!value ||
		typeof value !== "object" ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("studio" in value) ||
		!value.studio ||
		typeof value.studio !== "object"
	) {
		throw new Error("An explicit Studio CI input is required");
	}
	const studio = value.studio;
	if (
		!("repository" in studio) ||
		studio.repository !== "ForgeaX-Games/forgeax-studio" ||
		!("revision" in studio) ||
		typeof studio.revision !== "string" ||
		studio.revision.length !== 40 ||
		!/^[a-f0-9]{40}$/.test(studio.revision)
	) {
		throw new Error(
			"Studio CI input must name the canonical repository and an exact commit",
		);
	}
	return { repository: studio.repository, revision: studio.revision };
}

if (import.meta.main) {
	const input = resolveStudioIntegrationInput(
		JSON.parse(
			readFileSync(
				new URL("../product/integration-inputs.json", import.meta.url),
				"utf8",
			),
		),
	);
	if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
	appendFileSync(process.env.GITHUB_OUTPUT, `revision=${input.revision}\n`);
	console.log(JSON.stringify(input));
}

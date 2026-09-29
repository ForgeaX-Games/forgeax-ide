/** Built-in game templates exposed by the game service. */
export interface GameTemplate {
	readonly slug: string;
	readonly name: string;
}

function isGameTemplate(value: unknown): value is GameTemplate {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { slug?: unknown; name?: unknown };
	return (
		typeof candidate.slug === "string" &&
		candidate.slug.length > 0 &&
		typeof candidate.name === "string" &&
		candidate.name.length > 0
	);
}

/** Read the engine-owned template catalog used by both onboarding and New Game. */
export async function listGameTemplates(): Promise<GameTemplate[]> {
	const response = await fetch("/api/projects/templates");
	if (!response.ok)
		throw new Error(`listGameTemplates → HTTP ${response.status}`);
	const body = (await response.json()) as { templates?: unknown };
	return Array.isArray(body.templates)
		? body.templates.filter(isGameTemplate)
		: [];
}

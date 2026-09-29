import { Box, type LucideIcon, icons as LucideIcons } from "lucide-react";

/** kebab / snake / spaced → Lucide registry PascalCase key. */
function toPascalCase(name: string): string {
	return name
		.trim()
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join("");
}

/** Resolve only explicit Lucide declarations; emoji and arbitrary text are invalid. */
export function declaredLucideIcon(name?: string): LucideIcon | undefined {
	if (!name || !/^[A-Za-z][A-Za-z0-9_\-\s]*$/.test(name.trim()))
		return undefined;
	return (LucideIcons as Record<string, LucideIcon | undefined>)[
		toPascalCase(name)
	];
}

/** Missing or invalid declarations receive the neutral product fallback. */
export function lucideIconOrBox(name?: string): LucideIcon {
	return declaredLucideIcon(name) ?? Box;
}

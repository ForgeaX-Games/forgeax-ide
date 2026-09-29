export function sanitizeReleaseSourceCode(text: string): string {
	return text
		.replaceAll("packages/marketplace/extensions/", "marketplace/extensions/")
		.replaceAll("packages/marketplace/plugins/", "marketplace/plugins/")
		.replaceAll("packages/marketplace/src/", "marketplace/src/");
}

export function sanitizeReleaseSourcePaths(
	text: string,
	integrationRoot: string,
): string {
	const normalizedRoot = integrationRoot
		.replaceAll("\\", "/")
		.replace(/\/$/, "");
	// Cached shader metadata can originate in another checkout or CI worker.
	// Rewrite only its JSON path field; shader source and Vite module ids stay intact.
	const manifestPaths = text.replace(
		/("sourcePath"\s*:\s*)("(?:[^"\\]|\\.)*")/g,
		(field, key, value) => {
			const path = (JSON.parse(value) as string).replaceAll("\\", "/");
			const productPath = path.match(
				/(?:^|\/)(editor\/(?:packages|src)\/.*)$/,
			)?.[1];
			return productPath ? `${key}${JSON.stringify(productPath)}` : field;
		},
	);
	return sanitizeReleaseSourceCode(manifestPaths)
		.replaceAll(`${normalizedRoot}/packages/editor/`, "editor/")
		.replaceAll(`${normalizedRoot}/packages/`, "")
		.replaceAll("forgeax-studio/packages/", "")
		.replaceAll("packages/editor/", "editor/");
}

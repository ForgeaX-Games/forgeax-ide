export function isBunEmbeddedPath(value: string): boolean {
	let normalized = value.replaceAll("\\", "/");
	try {
		normalized = decodeURIComponent(normalized);
	} catch {
		return false;
	}

	return (
		normalized.startsWith("/$bunfs/root/") ||
		normalized.startsWith("file:///$bunfs/root/") ||
		/^[a-z]:\/~bun\/root(?:\/|$)/i.test(normalized) ||
		/^file:\/\/\/[a-z]:\/~bun\/root(?:\/|$)/i.test(normalized)
	);
}

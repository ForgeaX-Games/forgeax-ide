type DocumentLocation = Pick<Location, "hostname" | "protocol">;

/**
 * The bundled Tauri document is only a startup surface. Relative `/api/*`
 * requests on this origin resolve to packaged frontend assets, not the local
 * runtime. Rust navigates to the runtime's loopback HTTP origin after every
 * required service reports ready.
 */
export function isDesktopStartupDocument(location: DocumentLocation): boolean {
	return (
		location.protocol === "tauri:" || location.hostname === "tauri.localhost"
	);
}

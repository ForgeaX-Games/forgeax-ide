declare module "@forgeax/engine-vite-plugin-shader" {
	interface ForgeaXShaderOptions {
		readonly engineEntries?: boolean;
	}

	export function forgeaxShader(options?: ForgeaXShaderOptions): unknown;
}

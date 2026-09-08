export type WgpuWasm = Record<string, never>;

export function ensureReady(): Promise<WgpuWasm> {
  return Promise.reject(
    new Error(
      '@forgeax/engine-wgpu-wasm is unavailable in the source-integrated IDE bundle; use the browser WebGPU backend instead.',
    ),
  );
}

export function __resetForTests(): void {
  // No module-level state is kept in the unavailable source-integration shim.
}

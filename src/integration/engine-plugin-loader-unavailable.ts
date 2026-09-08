export function unavailableEnginePluginLoader(): never {
  throw new Error(
    '@forgeax/engine-plugin/loader is unavailable in the browser source-integrated IDE bundle.',
  );
}

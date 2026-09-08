import packageJson from '../../package.json';
import productManifest from '../../product/forgeax-product.json';

export type BuiltinExtension = {
  id: string;
  version: string;
  required: boolean;
};

export function selectBuiltinExtensions(): BuiltinExtension[] {
  const dependencies = packageJson.dependencies as Record<string, string>;
  const optionalDependencies = packageJson.optionalDependencies as Record<string, string>;

  return productManifest.extensions.map(({ id, required }) => {
    const version = (required ? dependencies : optionalDependencies)[id];
    if (typeof version !== 'string') {
      throw new Error(`${id} must be declared in ${required ? 'dependencies' : 'optionalDependencies'}`);
    }
    return { id, version, required };
  });
}

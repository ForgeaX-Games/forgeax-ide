import productManifest from '../../product/forgeax-product.json';

export type ProductManifest = typeof productManifest;

export function getProductManifest(): ProductManifest {
  return productManifest;
}

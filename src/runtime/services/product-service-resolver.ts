import productManifest from '../../../product/forgeax-product.json';

export type ProductService = (typeof productManifest.services)[number];

export function resolveProductService(serviceId: string): ProductService {
  const service = productManifest.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new Error(`IDE_SERVICE_NOT_DECLARED:${serviceId}`);
  return service;
}

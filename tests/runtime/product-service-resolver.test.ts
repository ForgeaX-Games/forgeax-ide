import { describe, expect, test } from 'bun:test';
import { resolveProductService } from '../../src/runtime/services/product-service-resolver';

describe('product service resolver', () => {
  test('derives the released service contract from the product manifest', () => {
    expect(resolveProductService('forgeax-server')).toEqual({
      id: 'forgeax-server',
      version: '0.1.0',
      source: 'released-service',
      required: true,
    });
  });

  test('fails closed for services outside the product manifest', () => {
    expect(() => resolveProductService('unknown')).toThrow('IDE_SERVICE_NOT_DECLARED:unknown');
  });
});

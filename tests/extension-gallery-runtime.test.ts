import { describe, expect, test } from 'bun:test';
import type { AppHost } from '@forgeax/app-shell/application';
import {
  extensionGalleryText,
  extensionGalleryIcon,
  openExtensionGalleryPage,
} from '../packages/extension-gallery/src/runtime';

function hostWithPages(pages: ReadonlyMap<string, unknown>) {
  const opened: string[] = [];
  const host = {
    pageRegistry: { getSnapshot: () => ({ pageTypes: pages }) },
    pages: { open: async ({ typeId }: { readonly typeId: string }) => { opened.push(typeId); } },
  } as unknown as AppHost;
  return { host, opened };
}

describe('@forgeax/extension-gallery App Shell runtime', () => {
  test('opens the matching available singleton page through the host', async () => {
    const typeId = '@forgeax-extension/reel#page/main';
    const { host, opened } = hostWithPages(new Map([
      ['@forgeax-extension/other#page/main', {
        status: 'available', owner: '@forgeax-extension/other', definition: { cardinality: 'singleton' },
      }],
      [typeId, {
        status: 'available', owner: '@forgeax-extension/reel', definition: { cardinality: 'singleton' },
      }],
    ]));

    await openExtensionGalleryPage(host, '@forgeax/reel');

    expect(opened).toEqual([typeId]);
  });

  test('rejects unavailable and non-singleton pages', async () => {
    const unavailable = hostWithPages(new Map([
      ['@forgeax-extension/reel#page/main', {
        status: 'unavailable', owner: '@forgeax-extension/reel',
      }],
    ])).host;
    await expect(openExtensionGalleryPage(unavailable, '@forgeax-extension/reel')).rejects.toThrow(
      'contributes no available singleton page',
    );

    const resource = hostWithPages(new Map([
      ['@forgeax-extension/reel#page/main', {
        status: 'available', owner: '@forgeax-extension/reel', definition: { cardinality: 'resource' },
      }],
    ])).host;
    await expect(openExtensionGalleryPage(resource, '@forgeax-extension/reel')).rejects.toThrow(
      'has no default singleton page',
    );
  });

  test('owns Lucide resolution and the neutral fallback', () => {
    expect(extensionGalleryIcon('circle').displayName).toBe('Circle');
    expect(extensionGalleryIcon('not-an-icon').displayName).toBe('Box');
    expect(extensionGalleryIcon('🧪').displayName).toBe('Box');
  });

  test('owns localized catalog text selection and fallback order', () => {
    expect(extensionGalleryText('Plain', 'zh', 'Fallback')).toBe('Plain');
    expect(extensionGalleryText({ ja: '日本語', zh: '中文', en: 'English' }, 'ja', 'Fallback')).toBe('日本語');
    expect(extensionGalleryText({ zh: '中文', en: 'English' }, 'fr', 'Fallback')).toBe('中文');
    expect(extensionGalleryText({ en: 'English' }, 'fr', 'Fallback')).toBe('English');
    expect(extensionGalleryText(undefined, 'en', 'Fallback')).toBe('Fallback');
  });
});

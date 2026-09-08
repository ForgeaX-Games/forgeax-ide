import { describe, expect, test } from 'bun:test';
import { defineToolPlugin, isToolPlugin } from '../src/integration/engine-plugin-browser';

describe('browser engine plugin compatibility', () => {
  test('preserves the Cordis plugin and copies tool contributions', () => {
    const plugin = { apply() {} };
    const tools = [{ descriptor: { id: 'preview' } }];
    const result = defineToolPlugin(plugin, tools);

    expect(result.plugin).toBe(plugin);
    expect(result.tools).toEqual(tools);
    expect(result.tools).not.toBe(tools);
    expect(isToolPlugin(result)).toBe(true);
    expect(isToolPlugin({ tools: [] })).toBe(false);
  });
});

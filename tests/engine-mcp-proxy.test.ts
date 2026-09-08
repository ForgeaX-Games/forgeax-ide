import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(import.meta.dir, '../vite.config.ts');

describe('Engine MCP gateway proxy', () => {
  test('publishes only the scoped MCP path through the IDE origin', () => {
    const source = readFileSync(configPath, 'utf8');

    expect(source).toContain("process.env.FORGEAX_MCP_URL?.trim()");
    expect(source).toContain("'/engine/mcp'");
    expect(source).toContain("path.replace(/^\\/engine\\/mcp");
    expect(source).toContain("proxyTimeout: 600_000");
    expect(source).not.toContain("'/engine':");
  });
});

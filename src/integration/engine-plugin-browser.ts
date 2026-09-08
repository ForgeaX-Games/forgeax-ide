export interface EngineContextServices {
  readonly [key: string]: unknown;
}

export interface Fiber {
  dispose(): Promise<void>;
}

export interface EffectMeta {
  readonly name?: string;
}

export type Effect = () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
export type Inject = readonly string[];

export type Plugin =
  | ((ctx: Context, config?: unknown) => void | Promise<void>)
  | {
    readonly name?: string;
    readonly inject?: Inject;
    apply(ctx: Context, config?: unknown): void | Promise<void>;
  };

/** Browser-safe envelope shared by Engine preview consumers. */
export interface ToolPlugin {
  readonly plugin: Plugin;
  readonly tools: readonly unknown[];
}

export function defineToolPlugin(plugin: Plugin, tools: readonly unknown[]): ToolPlugin {
  return { plugin, tools: [...tools] };
}

export function isToolPlugin(value: unknown): value is ToolPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolPlugin>;
  return candidate.plugin !== undefined && Array.isArray(candidate.tools);
}

export class Context {
  readonly registry = new Map<string, unknown>();
  readonly fiber: Fiber = {
    dispose: async () => {
      const cleanups = [...this.cleanups].reverse();
      this.cleanups.length = 0;
      for (const cleanup of cleanups) await cleanup();
    },
  };

  private readonly cleanups: Array<() => void | Promise<void>> = [];

  provide(name: string, value: unknown): void {
    this.registry.set(name, value);
    Object.defineProperty(this, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  async plugin(plugin: Plugin, config?: unknown): Promise<Fiber> {
    if (typeof plugin === 'function') {
      await plugin(this, config);
      return this.fiber;
    }
    await plugin.apply(this, config);
    return this.fiber;
  }

  effect(effect: Effect, _meta?: string | EffectMeta): void {
    void Promise.resolve(effect()).then((cleanup) => {
      if (typeof cleanup === 'function') this.cleanups.push(cleanup);
    });
  }
}

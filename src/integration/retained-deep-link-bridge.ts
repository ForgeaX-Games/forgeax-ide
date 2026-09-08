export type IdeDeepLinkTopic = 'bus:filter-kind' | 'bus:expand-plugin';

export interface RetainedDeepLinkBus {
  publish(topic: string, payload: unknown, options?: { retain?: boolean }): void;
  clearRetained(topic: string): void;
}

/**
 * Owns IDE's product-level retained deep-link semantics while the injected bus
 * keeps the shared subscriber and retained-state singleton in Interface.
 */
export function createRetainedDeepLinkBridge(bus: RetainedDeepLinkBus) {
  return {
    emitDeepLink(topic: IdeDeepLinkTopic, payload: string): void {
      bus.publish(topic, payload, { retain: true });
    },
    clearDeepLink(topic: IdeDeepLinkTopic): void {
      bus.clearRetained(topic);
      bus.publish(topic, null);
    },
  };
}

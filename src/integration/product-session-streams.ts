import {
  emitForgeaXMessage,
  onSessionEvent,
} from '@forgeax/chat/session-store';
import {
  createProductSessionStreams,
  type NarrativeHistoryEntry,
} from './product-session-stream-lifecycle';

export const PERCEPTION_QUERY_EVENT = 'forgeax:perception-query';

async function fetchNarrativeHistory(): Promise<readonly NarrativeHistoryEntry[]> {
  try {
    const response = await fetch('/api/narrative/history');
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return Array.isArray(payload) ? payload as NarrativeHistoryEntry[] : [];
  } catch {
    return [];
  }
}

const productSessionStreams = createProductSessionStreams({
  onSessionEvent,
  emitMessage: emitForgeaXMessage,
  fetchNarrativeHistory,
  now: Date.now,
  setInterval(callback, delay) {
    return globalThis.setInterval(callback, delay);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
  dispatchPerception(detail) {
    window.dispatchEvent(new CustomEvent(PERCEPTION_QUERY_EVENT, { detail }));
  },
});

export const subscribeNarrativeCopilot = productSessionStreams.subscribeNarrativeCopilot;
export const subscribePerceptionStream = productSessionStreams.subscribePerceptionStream;

import { useSyncExternalStore } from 'react';

export interface BusSnapshotReader {
  peek(topic: string): unknown;
  subscribe(topic: string, listener: (payload: unknown) => void): () => void;
}

export function createBusSnapshotBinding(bus: BusSnapshotReader, topic: string) {
  const getSnapshot = () => bus.peek(topic);
  return {
    subscribe(onChange: () => void): () => void {
      return bus.subscribe(topic, () => onChange());
    },
    getSnapshot,
    getServerSnapshot: getSnapshot,
  };
}

/** Assemble React's read-side adapter without copying the injected bus state. */
export function createUseBusSnapshot(bus: BusSnapshotReader) {
  return function useBusSnapshot(topic: string): unknown {
    const binding = createBusSnapshotBinding(bus, topic);
    return useSyncExternalStore(
      binding.subscribe,
      binding.getSnapshot,
      binding.getServerSnapshot,
    );
  };
}

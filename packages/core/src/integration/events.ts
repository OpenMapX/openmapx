export type IntegrationEvent =
  | { type: "integration.loaded"; integrationId: string }
  | { type: "integration.unloaded"; integrationId: string }
  | { type: "integration.error"; integrationId: string; error: Error }
  | { type: "data.updated"; integrationId: string; domain: string }
  | {
      type: "config.changed";
      integrationId: string;
      config: Record<string, unknown>;
    };

type EventHandler<T> = (event: T) => void;

export class IntegrationEventBus {
  private handlers = new Map<string, Set<EventHandler<IntegrationEvent>>>();

  emit(event: IntegrationEvent): void {
    const listeners = this.handlers.get(event.type);
    if (!listeners) return;
    for (const handler of listeners) {
      try {
        handler(event);
      } catch {
        // event handlers should not throw
      }
    }
  }

  on<T extends IntegrationEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<IntegrationEvent, { type: T }>>,
  ): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    const h = handler as EventHandler<IntegrationEvent>;
    this.handlers.get(type)?.add(h);
    return () => {
      this.handlers.get(type)?.delete(h);
    };
  }

  removeAll(): void {
    this.handlers.clear();
  }
}

/**
 * Game event bus (ADR-003): the typed backbone that lets destruction,
 * audio, HUD, and future systems (AI, physics, scripting, replay) react
 * to the same world events without tight coupling. Handlers are called
 * synchronously in emission order; subscribe returns an unsubscribe fn.
 */

export type GameEvent =
  | {
      type: 'explosion';
      x: number;
      y: number;
      z: number;
      radius: number;
      /** Voxel cells the blast removed. */
      destroyed: number;
    }
  | {
      type: 'structureCollapsed';
      /** Centroid of the falling component (world voxel coords). */
      x: number;
      y: number;
      z: number;
      /** Voxel cells that detached. */
      cells: number;
    }
  | {
      type: 'fireIgnited';
      x: number;
      y: number;
      z: number;
    }
  | {
      type: 'fireExtinguished';
      x: number;
      y: number;
      z: number;
      /** Why the fire died (steam puff on water/rain, nothing on smothering). */
      cause: 'water' | 'smothered' | 'rain';
    }
  | {
      type: 'npcDied';
      x: number;
      y: number;
      z: number;
      /** What killed the figure (swept away = landed in water). */
      cause: 'explosion' | 'drowned';
    }
  | {
      type: 'powerLost';
      /** The lamp cell that went dark. */
      x: number;
      y: number;
      z: number;
    }
  | {
      type: 'powerRestored';
      /** The lamp cell that lit up. */
      x: number;
      y: number;
      z: number;
    };

export type GameEventType = GameEvent['type'];

type Handler<T extends GameEventType> = (event: Extract<GameEvent, { type: T }>) => void;

type AnyHandler = (event: GameEvent) => void;

export class EventBus {
  private readonly handlers = new Map<GameEventType, Set<AnyHandler>>();
  private readonly anyHandlers = new Set<AnyHandler>();

  /** Subscribe to one event type; returns an unsubscribe function. */
  on<K extends GameEventType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped = handler as unknown as AnyHandler;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  /**
   * Subscribe to every event type (scenario engine, replay, statistics —
   * consumers that count rather than react to one kind). Returns an
   * unsubscribe function.
   */
  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /** Dispatch synchronously; a throwing handler does not block the others. */
  emit(event: GameEvent): void {
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Event handler threw', error);
      }
    }
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event);
      } catch (error) {
        console.error(`Event handler for "${event.type}" threw`, error);
      }
    }
  }

  listenerCount(type: GameEventType): number {
    return (this.handlers.get(type)?.size ?? 0) + this.anyHandlers.size;
  }
}

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
      /** Why the fire died (steam puff on water, nothing on smothering). */
      cause: 'water' | 'smothered';
    };

export type GameEventType = GameEvent['type'];

type Handler<T extends GameEventType> = (event: Extract<GameEvent, { type: T }>) => void;

type AnyHandler = (event: GameEvent) => void;

export class EventBus {
  private readonly handlers = new Map<GameEventType, Set<AnyHandler>>();

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

  /** Dispatch synchronously; a throwing handler does not block the others. */
  emit(event: GameEvent): void {
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
    return this.handlers.get(type)?.size ?? 0;
  }
}

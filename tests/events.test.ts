import { describe, expect, it, vi } from 'vitest';
import { EventBus, type GameEvent } from '../src/sim/events';

describe('EventBus', () => {
  it('delivers events to subscribers of the same type only', () => {
    const bus = new EventBus();
    const explosions = vi.fn();
    const collapses = vi.fn();
    bus.on('explosion', explosions);
    bus.on('structureCollapsed', collapses);

    bus.emit({ type: 'explosion', x: 1, y: 2, z: 3, radius: 4, destroyed: 5 });
    expect(explosions).toHaveBeenCalledTimes(1);
    expect(explosions).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'explosion', radius: 4, destroyed: 5 }),
    );
    expect(collapses).not.toHaveBeenCalled();
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on('explosion', handler);
    bus.emit({ type: 'explosion', x: 0, y: 0, z: 0, radius: 1, destroyed: 0 });
    off();
    bus.emit({ type: 'explosion', x: 0, y: 0, z: 0, radius: 1, destroyed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('explosion')).toBe(0);
  });

  it('multiple handlers fire in insertion order; a throw does not block others', () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('structureCollapsed', () => {
      order.push('first');
    });
    bus.on('structureCollapsed', () => {
      order.push('throws');
      throw new Error('handler bug');
    });
    bus.on('structureCollapsed', () => order.push('last'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.emit({ type: 'structureCollapsed', x: 0, y: 0, z: 0, cells: 3 });
    consoleSpy.mockRestore();

    expect(order).toEqual(['first', 'throws', 'last']);
    expect(bus.listenerCount('structureCollapsed')).toBe(3);
  });

  it('events without listeners are fine', () => {
    const bus = new EventBus();
    expect(() =>
      bus.emit({ type: 'explosion', x: 0, y: 0, z: 0, radius: 2, destroyed: 1 } as GameEvent),
    ).not.toThrow();
  });
});

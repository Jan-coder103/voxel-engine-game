import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DebrisSystem } from '../src/render/debris';
import { DustSystem } from '../src/render/dust';
import { GRASS, STONE, getMaterial } from '../src/voxel/materials';
import { explode } from '../src/voxel/damage';

/**
 * The Phase 8 gate's stability requirement: debris is capped and pooled,
 * and a 100-event destruction stress test never grows the pool.
 */
describe('debris pool under stress', () => {
  it('100 explosions stay inside the pool capacity', () => {
    const scene = new THREE.Scene();
    const debris = new DebrisSystem(scene, 512);
    const colorFor = (material: number) => getMaterial(material).color;

    // A solid world to blast.
    const voxels = new Uint16Array(48 * 48 * 48).fill(STONE);
    const query = (x: number, y: number, z: number) => {
      if (x < 0 || y < 0 || z < 0 || x >= 48 || y >= 48 || z >= 48) return 0;
      return voxels[x + z * 48 + y * 48 * 48];
    };

    let spawned = 0;
    for (let event = 0; event < 100; event++) {
      const center = {
        x: 8 + (event % 8) * 4 + 0.5,
        y: 8.5,
        z: 8 + Math.floor(event / 8) * 4 + 0.5,
      };
      const result = explode(center, 4, query, { seed: event, maxDebris: 24 });
      debris.spawn(result.debris, colorFor);
      spawned += result.debris.length;
      expect(debris.activeCount).toBeLessThanOrEqual(512);
    }
    expect(spawned).toBeGreaterThan(1000); // the test actually exercised it
    expect(debris.activeCount).toBeLessThanOrEqual(512);

    // Old pieces were recycled, not leaked.
    debris.update(5, () => false); // one long step expires every piece
    expect(debris.activeCount).toBe(0);
    debris.dispose(scene);
  });

  it('update steps never resurrect pieces or move them once expired', () => {
    const scene = new THREE.Scene();
    const debris = new DebrisSystem(scene, 8);
    debris.spawn(
      [{ x: 0, y: 40, z: 0, vx: 0, vy: 0, vz: 0, material: GRASS, scale: 0.5 }],
      (m) => getMaterial(m).color,
    );
    expect(debris.activeCount).toBe(1);
    const isSolid = () => false;
    for (let i = 0; i < 300; i++) debris.update(1 / 60, isSolid);
    expect(debris.activeCount).toBe(0);
    for (let i = 0; i < 60; i++) debris.update(1 / 60, isSolid);
    expect(debris.activeCount).toBe(0);
    debris.dispose(scene);
  });

  it('dust puffs recycle within capacity', () => {
    const scene = new THREE.Scene();
    const dust = new DustSystem(scene, 128);
    for (let i = 0; i < 50; i++) dust.puff(0, 0, 0, { count: 12 });
    expect(dust.activeCount).toBeLessThanOrEqual(128);
    dust.update(3);
    expect(dust.activeCount).toBe(0);
    dust.dispose(scene);
  });

  it('debris bounces and settles on solid ground instead of falling forever', () => {
    const scene = new THREE.Scene();
    const debris = new DebrisSystem(scene, 4);
    debris.spawn(
      [{ x: 2, y: 10, z: 2, vx: 1, vy: 0, vz: 0, material: STONE, scale: 0.5 }],
      (m) => getMaterial(m).color,
    );
    const isSolid = (x: number, y: number, _z: number) => y <= 3 && x >= 0;
    let low = 11;
    for (let i = 0; i < 240; i++) {
      debris.update(1 / 60, isSolid);
    }
    // Piece must have landed on the floor surface (y=4) + half scale.
    const state = debris['states'][0];
    low = state.y;
    expect(low).toBeGreaterThan(3.9);
    expect(low).toBeLessThan(4.6);
    expect(debris.activeCount).toBe(1); // still alive within its lifetime
    debris.dispose(scene);
  });
});

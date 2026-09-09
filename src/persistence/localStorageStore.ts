import type { SaveStore } from '../voxel/persistence';

/**
 * Browser SaveStore backed by localStorage. Lives outside `src/voxel/` so
 * the persistence core stays DOM-free; failures (quota, privacy mode,
 * serialization) surface as console warnings and read as "no save"
 * instead of crashing the game loop.
 */
export class LocalStorageSaveStore implements SaveStore {
  constructor(private readonly prefix = 'microworld.') {}

  get(key: string): string | undefined {
    try {
      return window.localStorage.getItem(this.prefix + key) ?? undefined;
    } catch (error) {
      console.warn('Save store read failed', error);
      return undefined;
    }
  }

  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(this.prefix + key, value);
    } catch (error) {
      console.warn('Save store write failed', error);
    }
  }

  delete(key: string): void {
    try {
      window.localStorage.removeItem(this.prefix + key);
    } catch (error) {
      console.warn('Save store delete failed', error);
    }
  }
}

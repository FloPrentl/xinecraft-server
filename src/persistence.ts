import type { World } from './model.js';

/** Phase 3 will supply a durable adapter with atomic world/epoch/revision commits. */
export interface WorldPersistence {
  readonly durable: boolean;
  load(worldId: string): Promise<unknown | null>;
  save(world: World): Promise<void>;
}

export class MemoryPersistence implements WorldPersistence {
  readonly durable = false;
  readonly #worlds = new Map<string, World>();

  async load(worldId: string): Promise<unknown | null> {
    return structuredClone(this.#worlds.get(worldId) ?? null);
  }

  async save(world: World): Promise<void> {
    this.#worlds.set(world.worldId, structuredClone(world));
  }
}

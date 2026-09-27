import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { entitySchema, identifierSchema, MAX_MESSAGE_BYTES, revisionSchema, worldSchema } from './model.js';
import type { World } from './model.js';
import type { WorldPersistence } from './persistence.js';
import type { Change, Operation } from './protocol.js';

export const entityAttributesSchema = entitySchema.omit({ id: true, kind: true });
export const entityWriteSchema = z.strictObject({
  expectedEpoch: identifierSchema,
  expectedRevision: revisionSchema,
  attributes: entityAttributesSchema,
});
export type EntityWrite = z.infer<typeof entityWriteSchema>;

export class ManagementError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Serializes compare-and-save so simultaneous editors cannot both commit the same revision. */
export class WorldManager {
  #world: World;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(world: World, private readonly persistence: WorldPersistence,
    private readonly onCommit: (change: Change) => void) {
    this.#world = structuredClone(world);
  }

  snapshot(): World { return structuredClone(this.#world); }

  writeEntity(input: EntityWrite, entityId?: string) {
    return this.commit(input, () => {
      if (entityId !== undefined && !this.#world.state.entities.some(e => e.id === entityId)) {
        throw new ManagementError(404, 'ENTITY_NOT_FOUND', 'This entity no longer exists.');
      }
      const entity = entitySchema.parse({ id: entityId ?? randomUUID(), kind: 'minecraft:pig', ...input.attributes });
      return [{ op: 'PUT_ENTITY', entity }];
    }).then(result => ({ world: result.world, entity: result.operations[0]!.op === 'PUT_ENTITY' ? result.operations[0]!.entity : undefined }));
  }

  transact(input: { expectedEpoch: string; expectedRevision: number; operations: Operation[] }) {
    return this.commit(input, () => input.operations);
  }

  private commit(input: { expectedEpoch: string; expectedRevision: number }, operations: () => Operation[]) {
    const operation = this.#pending.then(async () => {
      const current = this.#world;
      if (input.expectedEpoch !== current.epoch || input.expectedRevision !== current.revision) {
        throw new ManagementError(409, 'REVISION_CONFLICT', 'The world changed. Reload the latest entity before saving again.');
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new ManagementError(409, 'REVISION_LIMIT', 'This world needs a new epoch before further changes.');
      }
      const next = structuredClone(current);
      const changes = operations();
      for (const change of changes) {
        if (change.op === 'SET_BLOCK') {
          const p = change.position;
          next.state.blocks = next.state.blocks.filter(b => b.position.x !== p.x || b.position.y !== p.y || b.position.z !== p.z);
          if (change.block !== 'minecraft:air') next.state.blocks.push({ position: p, block: change.block });
        } else {
          const id = change.op === 'PUT_ENTITY' ? change.entity.id : change.id;
          next.state.entities = next.state.entities.filter(e => e.id !== id);
          if (change.op === 'PUT_ENTITY') next.state.entities.push(change.entity);
        }
      }
      if (next.state.entities.length > 64) {
        throw new ManagementError(409, 'ENTITY_LIMIT', 'The test area supports up to 64 entities.');
      }
      next.state.blocks.sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z);
      next.state.entities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      next.revision++;
      worldSchema.parse(next);
      if (Buffer.byteLength(JSON.stringify({ protocolVersion: 1, type: 'SNAPSHOT', sessionId: randomUUID(), ...next })) > MAX_MESSAGE_BYTES) {
        throw new ManagementError(413, 'STATE_TOO_LARGE', 'The resulting world exceeds the snapshot limit.');
      }
      await this.persistence.save(next);
      this.#world = next;
      this.onCommit({ epoch: next.epoch, baseRevision: current.revision, revision: next.revision, operations: changes });
      return { world: this.snapshot(), operations: changes };
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }
}

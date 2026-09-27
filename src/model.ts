import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const blockPositionSchema = z.strictObject({
  x: z.number().int().min(0).max(15),
  y: z.number().int().min(1).max(16),
  z: z.number().int().min(0).max(15),
});
const blockSchema = z.strictObject({
  position: blockPositionSchema,
  block: z.enum(['minecraft:stone', 'minecraft:dirt', 'minecraft:glass']),
});
export const entitySchema = z.strictObject({
  id: uuidSchema,
  kind: z.literal('minecraft:pig'),
  position: z.strictObject({
    x: z.number().min(1).max(15),
    y: z.number().min(1).max(15),
    z: z.number().min(1).max(15),
  }),
  yaw: z.number().min(0).lt(360),
  pitch: z.number().min(-90).max(90),
});

export const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('above-ground-v1'),
  scope: z.strictObject({
    dimension: z.literal('minecraft:overworld'),
    coordinates: z.literal('ground-relative'),
    min: z.strictObject({ x: z.literal(0), y: z.literal(1), z: z.literal(0) }),
    max: z.strictObject({ x: z.literal(15), y: z.literal(16), z: z.literal(15) }),
  }),
  defaultBlock: z.literal('minecraft:air'),
  blocks: z.array(blockSchema).max(4096),
  entities: z.array(entitySchema).max(64),
  environment: z.strictObject({ timeOfDay: z.literal(6000), weather: z.literal('clear') }),
  viewer: z.strictObject({
    mode: z.literal('spectator'),
    spawn: z.strictObject({ x: z.literal(8), y: z.literal(6), z: z.literal(8) }),
  }),
}).superRefine((state, context) => {
  const positions = state.blocks.map(({ position: p }) => `${p.x},${p.y},${p.z}`);
  if (new Set(positions).size !== positions.length) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'Duplicate block position' });
  }
  const ids = state.entities.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['entities'], message: 'Duplicate entity ID' });
  }
});

export const worldSchema = z.strictObject({
  worldId: identifierSchema,
  epoch: identifierSchema,
  revision: revisionSchema,
  state: stateSchema,
});
export type World = z.infer<typeof worldSchema>;
export type Entity = z.infer<typeof entitySchema>;

export function createWorld(worldId: string): World {
  return worldSchema.parse({
    worldId,
    epoch: randomUUID(),
    revision: 0,
    state: {
      schemaVersion: 1,
      profile: 'above-ground-v1',
      scope: {
        dimension: 'minecraft:overworld',
        coordinates: 'ground-relative',
        min: { x: 0, y: 1, z: 0 },
        max: { x: 15, y: 16, z: 15 },
      },
      defaultBlock: 'minecraft:air',
      blocks: [],
      entities: [],
      environment: { timeOfDay: 6000, weather: 'clear' },
      viewer: { mode: 'spectator', spawn: { x: 8, y: 6, z: 8 } },
    },
  });
}

import { z } from 'zod';
import { blockPositionSchema, entitySchema, identifierSchema, revisionSchema } from './model.js';

export const operationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('SET_BLOCK'), position: blockPositionSchema,
    block: z.enum(['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:glass']) }),
  z.strictObject({ op: z.literal('PUT_ENTITY'), entity: entitySchema }),
  z.strictObject({ op: z.literal('REMOVE_ENTITY'), id: entitySchema.shape.id }),
]);
export type Operation = z.infer<typeof operationSchema>;
export interface Change { epoch: string; baseRevision: number; revision: number; operations: Operation[] }
export const transactionSchema = z.strictObject({
  expectedEpoch: identifierSchema, expectedRevision: revisionSchema,
  operations: z.array(operationSchema).min(1).max(4160),
}).superRefine((transaction, context) => {
  const keys = transaction.operations.map(op => op.op === 'SET_BLOCK'
    ? `block:${op.position.x},${op.position.y},${op.position.z}`
    : `entity:${op.op === 'PUT_ENTITY' ? op.entity.id : op.id}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate transaction targets' });
});

export const errorCodeSchema = z.enum([
  'INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'WORLD_NOT_FOUND',
  'UNAUTHORIZED', 'STATE_UNSUPPORTED', 'APPLY_FAILED',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// Strict shapes are the upload boundary. Never accept free-form diagnostics.
export const modMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    protocolVersion: z.literal(1), type: z.literal('HELLO'), worldId: identifierSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1), type: z.literal('ACK'),
    sessionId: identifierSchema, epoch: identifierSchema, revision: revisionSchema,
  }),
  z.strictObject({
    protocolVersion: z.literal(1), type: z.literal('RESYNC_REQUEST'),
    sessionId: identifierSchema, reason: z.enum(['REVISION_GAP', 'APPLY_FAILED']),
  }),
  z.strictObject({
    protocolVersion: z.literal(1), type: z.literal('ERROR'), code: errorCodeSchema,
  }),
]);

export function parseModMessage(text: string):
  { ok: true; message: z.infer<typeof modMessageSchema> } |
  { ok: false; code: ErrorCode } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  if (typeof value === 'object' && value !== null &&
      'protocolVersion' in value && value.protocolVersion !== 1) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' };
  }
  const parsed = modMessageSchema.safeParse(value);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, code: 'INVALID_MESSAGE' };
}

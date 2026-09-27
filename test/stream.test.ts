import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import type { Operation } from '../src/protocol.js';

async function setup(t: TestContext, options: AppOptions = {}) {
  const app = await buildApp(options);
  const socket = await app.injectWS('/replication/v1');
  t.after(async () => { socket.terminate(); await app.close(); });
  const messages: any[] = [];
  const waiters: ((message: any) => void)[] = [];
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  });
  const next = () => new Promise<any>(resolve => {
    if (messages.length) resolve(messages.shift()); else waiters.push(resolve);
  });
  const read = async () => (await app.inject('/api/world')).json();
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const ack = (message: any) => send({ protocolVersion: 1, type: 'ACK', sessionId: message.sessionId, epoch: message.epoch, revision: message.revision });
  const barrier = async () => { const pong = once(socket, 'pong'); socket.ping(); await pong; };
  const transaction = async (operations: unknown[]) => {
    const { world, managementToken } = await read();
    return app.inject({ method: 'POST', url: '/api/transactions',
      headers: { 'x-xinecraft-management': managementToken },
      payload: { expectedEpoch: world.epoch, expectedRevision: world.revision, operations },
    });
  };
  send({ protocolVersion: 1, type: 'HELLO', worldId: 'demo' });
  assert.equal((await next()).type, 'WELCOME');
  const snapshot = await next();
  return { app, socket, next, messages, read, send, ack, barrier, transaction, snapshot };
}
const id = '00000000-0000-4000-8000-000000000001';
const put: Operation = { op: 'PUT_ENTITY', entity: { id, kind: 'minecraft:pig', position: { x: 8, y: 1, z: 8 }, yaw: 0, pitch: 0 } };
const block: Operation = { op: 'SET_BLOCK', position: { x: 3, y: 1, z: 4 }, block: 'minecraft:glass' };

test('pushes ordered transactions after snapshot ACK, including changes made while an ACK is pending', { timeout: 5000 }, async t => {
  const c = await setup(t);
  assert.deepEqual(c.snapshot.state.blocks, []);
  assert.equal((await c.transaction([block, put])).statusCode, 200);
  assert.equal((await c.transaction([{ op: 'REMOVE_ENTITY', id }, { ...block, block: 'minecraft:air' }])).statusCode, 200);
  await c.barrier();
  assert.equal(c.messages.length, 0, 'No patch may overtake the snapshot ACK');
  c.ack(c.snapshot);
  const first = await c.next();
  assert.equal(first.type, 'PATCH');
  assert.equal(first.sessionId, c.snapshot.sessionId);
  assert.equal(first.baseRevision, 0);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.operations, [block, put]);
  await c.barrier();
  assert.equal(c.messages.length, 0, 'Only one unacknowledged state message is in flight');
  assert.equal((await c.app.inject('/health')).json().synchronizedViewers, 0);
  c.ack(first);
  const second = await c.next();
  assert.equal(second.baseRevision, 1);
  assert.equal(second.revision, 2);
  c.ack(second); c.ack(second);
  await c.barrier();
  assert.equal((await c.app.inject('/health')).json().synchronizedViewers, 1);
  assert.deepEqual((await c.read()).world.state.blocks, []);
  assert.deepEqual((await c.read()).world.state.entities, []);
  const { world, managementToken } = await c.read();
  const created = await c.app.inject({ method: 'POST', url: '/api/entities', headers: { 'x-xinecraft-management': managementToken },
    payload: { expectedEpoch: world.epoch, expectedRevision: world.revision, attributes: { position: { x: 8, y: 1, z: 8 }, yaw: 0, pitch: 0 } } });
  assert.equal(created.statusCode, 201);
  const third = await c.next();
  assert.equal(third.sessionId, first.sessionId);
  assert.deepEqual(third.operations, [{ op: 'PUT_ENTITY', entity: created.json().entity }]);
});

test('ground edits, duplicate targets, unsupported content, and mixed invalid transactions are atomic failures', { timeout: 5000 }, async t => {
  const c = await setup(t); c.ack(c.snapshot); await c.barrier();
  for (const operations of [
    [put, { ...block, position: { x: 3, y: 0, z: 4 } }],
    [{ ...block, position: { x: 3, y: -1, z: 4 } }], [block, block],
    [put, { op: 'REMOVE_ENTITY', id }], [{ ...block, block: 'minecraft:tnt' }], [],
  ]) assert.equal((await c.transaction(operations)).statusCode, 400);
  assert.equal((await c.read()).world.revision, 0);
  await c.barrier(); assert.equal(c.messages.length, 0);
});

test('bounded slow-consumer queue forces a fresh snapshot without losing authoritative changes', { timeout: 5000 }, async t => {
  const c = await setup(t, { maxQueuedPatches: 1 });
  const closed = once(c.socket, 'close');
  assert.equal((await c.transaction([block])).statusCode, 200);
  assert.equal((await c.transaction([put])).statusCode, 200);
  assert.equal((await closed)[0], 1012);
  const socket = await c.app.injectWS('/replication/v1');
  t.after(() => socket.terminate());
  const received = new Promise<any>(resolve => socket.on('message', data => {
    const message = JSON.parse(data.toString()); if (message.type === 'SNAPSHOT') resolve(message);
  }));
  socket.send(JSON.stringify({ protocolVersion: 1, type: 'HELLO', worldId: 'demo' }));
  const latest = await received;
  assert.notEqual(latest.sessionId, c.snapshot.sessionId);
  assert.equal(latest.epoch, c.snapshot.epoch);
  assert.equal(latest.revision, 2);
  assert.equal(latest.state.blocks.length, 1);
  assert.equal(latest.state.entities.length, 1);
});

test('ACK cannot jump to a queued revision that has not been sent', { timeout: 5000 }, async t => {
  const c = await setup(t);
  await c.transaction([block]);
  c.ack({ ...c.snapshot, revision: 1 });
  assert.equal((await c.next()).code, 'INVALID_MESSAGE');
});

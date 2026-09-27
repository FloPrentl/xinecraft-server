import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import { createWorld, stateSchema } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { parseModMessage } from '../src/protocol.js';

type Message = Record<string, unknown>;

// Listen before sending HELLO: WELCOME and SNAPSHOT can arrive back-to-back.
function inbox(socket: WebSocket) {
  const messages: Message[] = [];
  const waiters: ((message: Message) => void)[] = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Message;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  return () => new Promise<Message>((resolve) => {
    const message = messages.shift();
    if (message) resolve(message);
    else waiters.push(resolve);
  });
}

async function connect(t: TestContext, options: AppOptions = {}) {
  const app = await buildApp(options);
  const socket = await app.injectWS('/replication/v1');
  t.after(async () => { socket.terminate(); await app.close(); });
  const next = inbox(socket);
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  return { app, socket, next, send };
}

async function hello(client: Awaited<ReturnType<typeof connect>>) {
  client.send({ protocolVersion: 1, type: 'HELLO', worldId: 'demo' });
  const welcome = await client.next();
  const snapshot = await client.next();
  assert.equal(welcome.type, 'WELCOME');
  assert.equal(snapshot.type, 'SNAPSHOT');
  assert.equal(snapshot.sessionId, welcome.sessionId);
  assert.equal(snapshot.epoch, welcome.epoch);
  return snapshot;
}

test('bootstrap owns only empty space above the shared ground, with independent persistence copies', async () => {
  const world = createWorld('demo');
  assert.equal(world.revision, 0);
  assert.equal(world.state.blocks.length, 0);
  assert.equal(world.state.scope.min.y, 1);
  assert.equal(world.state.scope.coordinates, 'ground-relative');
  assert.deepEqual(world.state.entities, []);
  const store = new MemoryPersistence();
  world.state.blocks.push({ position: { x: 0, y: 1, z: 0 }, block: 'minecraft:stone' });
  await store.save(world);
  world.state.blocks.length = 0;
  const restored = await store.load('demo') as typeof world;
  assert.equal(restored.state.blocks.length, 1);
  restored.state.blocks.length = 0;
  assert.equal((await store.load('demo') as typeof world).state.blocks.length, 1);
});

test('state rejects unsupported content, scope changes, duplicate identities, and local extra data', () => {
  const seed = createWorld('demo').state;
  const invalidStates: unknown[] = [
    { ...seed, localSave: 'anything' },
    { ...seed, scope: { ...seed.scope, dimension: 'minecraft:the_nether' } },
    { ...seed, blocks: [{ position: { x: 16, y: 1, z: 0 }, block: 'minecraft:stone' }] },
    { ...seed, blocks: [{ position: { x: 0.5, y: 1, z: 0 }, block: 'minecraft:stone' }] },
    { ...seed, blocks: [{ position: { x: 0, y: 1, z: 0 }, block: 'minecraft:chest' }] },
    { ...seed, blocks: [{ position: { x: 0, y: 1, z: 0 }, block: 'minecraft:air' }] },
    { ...seed, blocks: Array(2).fill({ position: { x: 0, y: 1, z: 0 }, block: 'minecraft:stone' }) },
    ...[0, -1].map(y => ({ ...seed, blocks: [{ position: { x: 0, y, z: 0 }, block: 'minecraft:stone' }] })),
  ];
  const entity = {
    id: '00000000-0000-4000-8000-000000000001', kind: 'minecraft:pig',
    position: { x: 1.5, y: 1, z: 1.5 }, yaw: 90, pitch: 0,
  };
  invalidStates.push(
    { ...seed, entities: [entity, entity] },
    { ...seed, entities: [{ ...entity, position: { ...entity.position, x: Infinity } }] },
    { ...seed, entities: [{ ...entity, position: { ...entity.position, x: 0 } }] },
    { ...seed, entities: [{ ...entity, nbt: {} }] },
  );
  for (const value of invalidStates) assert.equal(stateSchema.safeParse(value).success, false);
});

test('README JSON examples parse and the complete snapshot matches the implemented schema', async () => {
  const readme = await readFile('README.md', 'utf8');
  const examples = [...readme.matchAll(/```json\s*([\s\S]*?)```/g)].map(match =>
    JSON.parse(match[1]!) as Message);
  const snapshot = examples.find(example => example.type === 'SNAPSHOT');
  assert.ok(snapshot);
  assert.equal(stateSchema.safeParse(snapshot.state).success, true);
  for (const example of examples.filter(item => ['HELLO', 'ACK', 'RESYNC_REQUEST'].includes(String(item.type)))) {
    assert.equal(parseModMessage(JSON.stringify(example)).ok, true);
  }
  const patch = examples.find(example => example.type === 'PATCH');
  assert.ok(patch);
  assert.equal(patch.baseRevision, snapshot.revision);
});

test('bad saved state fails startup without silently replacing authoritative data', async () => {
  let saves = 0;
  await assert.rejects(buildApp({ persistence: {
    durable: true,
    load: async () => ({ invalid: true }),
    save: async () => { saves++; },
  } }));
  assert.equal(saves, 0);
});

test('status and handshake expose server state; ACK changes progress, never the world', { timeout: 5000 }, async t => {
  const client = await connect(t);
  const before = (await client.app.inject('/health')).json();
  assert.equal(before.persistence, 'memory');
  assert.equal(before.runtime, 'single-player-integrated-only');
  const page = await client.app.inject('/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /resets when this process restarts/);
  const snapshot = await hello(client);
  assert.equal(snapshot.revision, 0);
  assert.equal(stateSchema.parse(snapshot.state).blocks.length, 0);
  assert.equal((await client.app.inject('/health')).json().synchronizedViewers, 0);
  const ack = {
    protocolVersion: 1, type: 'ACK', sessionId: snapshot.sessionId,
    epoch: snapshot.epoch, revision: snapshot.revision,
  };
  client.send(ack);
  client.send(ack);
  // Ping/pong is ordered after the ACK on the socket, without arbitrary sleeps.
  const pong = once(client.socket, 'pong');
  client.socket.ping();
  await pong;
  const after = (await client.app.inject('/health')).json();
  assert.equal(after.synchronizedViewers, 1);
  assert.equal(after.revision, before.revision);
  assert.equal(after.epoch, before.epoch);
});

for (const [name, raw, code] of [
  ['local world data in HELLO', JSON.stringify({ protocolVersion: 1, type: 'HELLO', worldId: 'demo', blocks: [] }), 'INVALID_MESSAGE'],
  ['world snapshot upload', JSON.stringify({ protocolVersion: 1, type: 'SNAPSHOT', state: {} }), 'INVALID_MESSAGE'],
  ['diagnostics containing world data', JSON.stringify({ protocolVersion: 1, type: 'ERROR', code: 'APPLY_FAILED', details: { blocks: [] } }), 'INVALID_MESSAGE'],
  ['malformed JSON', '{', 'INVALID_MESSAGE'],
  ['unsupported version', JSON.stringify({ protocolVersion: 2, type: 'HELLO', worldId: 'demo' }), 'UNSUPPORTED_VERSION'],
  ['unknown world', JSON.stringify({ protocolVersion: 1, type: 'HELLO', worldId: 'missing' }), 'WORLD_NOT_FOUND'],
  ['ACK before handshake', JSON.stringify({ protocolVersion: 1, type: 'ACK', sessionId: 'other', epoch: 'other', revision: 0 }), 'INVALID_MESSAGE'],
] as const) {
  test(`rejects ${name} without mutating authority`, { timeout: 5000 }, async t => {
    const client = await connect(t);
    const before = (await client.app.inject('/health')).json();
    const closed = once(client.socket, 'close');
    client.socket.send(raw);
    assert.deepEqual(await client.next(), { protocolVersion: 1, type: 'ERROR', code });
    assert.equal((await closed)[0], 1008);
    const after = (await client.app.inject('/health')).json();
    assert.equal(after.revision, before.revision);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.connectedViewers, 0);
  });
}

for (const [field, value] of [['revision', 1], ['sessionId', 'old-session'], ['epoch', 'old-epoch']] as const) {
  test(`rejects ACK with wrong ${field}`, { timeout: 5000 }, async t => {
    const client = await connect(t);
    const snapshot = await hello(client);
    client.send({
      protocolVersion: 1, type: 'ACK', sessionId: snapshot.sessionId,
      epoch: snapshot.epoch, revision: snapshot.revision, [field]: value,
    });
    assert.equal((await client.next()).code, 'INVALID_MESSAGE');
    assert.equal((await client.app.inject('/health')).json().synchronizedViewers, 0);
  });
}

test('resync reconnect sends a full snapshot with a new session, unchanged authoritative epoch', { timeout: 5000 }, async t => {
  const client = await connect(t);
  const original = await hello(client);
  const closed = once(client.socket, 'close');
  client.send({ protocolVersion: 1, type: 'RESYNC_REQUEST', sessionId: original.sessionId, reason: 'APPLY_FAILED' });
  assert.equal((await closed)[0], 1012);
  const second = await client.app.injectWS('/replication/v1');
  t.after(() => second.terminate());
  const next = inbox(second);
  second.send(JSON.stringify({ protocolVersion: 1, type: 'HELLO', worldId: 'demo' }));
  const welcome = await next();
  const snapshot = await next();
  assert.notEqual(welcome.sessionId, original.sessionId);
  assert.equal(snapshot.epoch, original.epoch);
  assert.deepEqual(snapshot.state, original.state);
});

test('rejects browser-origin upgrades and missing or incorrect replication tokens', { timeout: 5000 }, async t => {
  const token = 'test-only-replication-token';
  const app = await buildApp({ replicationToken: token });
  t.after(() => app.close());
  await assert.rejects(app.injectWS('/replication/v1'), /401/);
  await assert.rejects(app.injectWS('/replication/v1', { headers: { authorization: 'Bearer wrong' } }), /401/);
  await assert.rejects(app.injectWS('/replication/v1', {
    headers: { authorization: `Bearer ${token}`, origin: 'https://example.org' },
  }), /403/);
  const socket = await app.injectWS('/replication/v1', { headers: { authorization: `Bearer ${token}` } });
  t.after(() => socket.terminate());
  const next = inbox(socket);
  socket.send(JSON.stringify({ protocolVersion: 1, type: 'HELLO', worldId: 'demo' }));
  assert.equal((await next()).type, 'WELCOME');
  assert.equal((await next()).type, 'SNAPSHOT');
});

test('missing snapshot ACK disconnects the consumer without advancing its progress', { timeout: 5000 }, async t => {
  const client = await connect(t, { ackTimeoutMs: 100 });
  const closed = once(client.socket, 'close');
  await hello(client);
  await closed;
  const status = (await client.app.inject('/health')).json();
  assert.equal(status.synchronizedViewers, 0);
  assert.equal(status.revision, 0);
});

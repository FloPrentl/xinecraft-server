import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import type { Entity, World } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';

const attributes = { position: { x: 8, y: 1, z: 8 }, yaw: 0, pitch: 0 };
async function setup(t: TestContext, options: AppOptions = {}) {
  const app = await buildApp(options);
  t.after(async () => {
    for (const client of app.websocketServer.clients) client.terminate();
    await app.close();
  });
  const read = async () => (await app.inject('/api/world')).json() as { world: World; managementToken: string };
  const initial = await read();
  const headers = { 'x-xinecraft-management': initial.managementToken };
  const payload = (world = initial.world) => ({ expectedEpoch: world.epoch, expectedRevision: world.revision, attributes });
  return { app, read, headers, payload, initial };
}

test('dashboard assets are served with all three panels and a strict content policy', async t => {
  const { app } = await setup(t);
  const page = await app.inject('/');
  assert.equal(page.statusCode, 200);
  for (const id of ['block-rows', 'entity-list', 'new-entity', 'entity-form', 'save-entity']) assert.ok(page.body.includes(`id="${id}"`));
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
  for (const url of ['/dashboard.css', '/dashboard.js']) assert.equal((await app.inject(url)).statusCode, 200);
});

test('create and edit assign stable identity and advance the authoritative revision', async t => {
  const { app, read, headers, payload } = await setup(t);
  const created = await app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload() });
  assert.equal(created.statusCode, 201);
  const { world, entity } = created.json() as { world: World; entity: Entity };
  assert.equal(world.revision, 1);
  assert.equal(entity.kind, 'minecraft:pig');
  assert.match(entity.id, /^[a-f0-9-]{36}$/);
  const edited = await app.inject({ method: 'PUT', url: `/api/entities/${entity.id}`, headers,
    payload: { ...payload(world), attributes: { position: { x: 4.5, y: 6, z: 12 }, yaw: 135, pitch: -25 } },
  });
  assert.equal(edited.statusCode, 200);
  const final = (await read()).world;
  assert.equal(final.revision, 2);
  assert.equal(final.state.entities[0]?.id, entity.id);
  assert.deepEqual(final.state.entities[0]?.position, { x: 4.5, y: 6, z: 12 });
  assert.equal(final.state.entities[0]?.yaw, 135);
  assert.equal(final.state.entities[0]?.pitch, -25);
  assert.deepEqual(final.state.blocks, world.state.blocks);
});

test('invalid attributes and attempts to modify entity identity leave world unchanged', async t => {
  const { app, read, headers, payload } = await setup(t);
  for (const bad of [
    { ...attributes, position: { x: 0, y: 1, z: 8 } },
    { ...attributes, position: { x: 8, y: 16, z: 8 } },
    { ...attributes, position: { x: '8', y: 1, z: 8 } },
    { ...attributes, yaw: 360 },
    { ...attributes, pitch: -91 },
    { ...attributes, kind: 'minecraft:cow' },
    { ...attributes, id: 'spoofed' },
    { ...attributes, nbt: {} },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/entities', headers,
      payload: { ...payload(), attributes: bad },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal((await read()).world.revision, 0);
  assert.equal((await read()).world.state.entities.length, 0);
});

test('stale and simultaneous edits cannot overwrite a newer world revision', async t => {
  const { app, read, headers, payload } = await setup(t);
  const results = await Promise.all([
    app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload() }),
    app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload() }),
  ]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [201, 409]);
  const current = (await read()).world;
  assert.equal(current.revision, 1);
  assert.equal(current.state.entities.length, 1);
  const response = await app.inject({ method: 'PUT', url: `/api/entities/${current.state.entities[0]!.id}`, headers, payload: payload() });
  assert.equal(response.statusCode, 409);
  assert.deepEqual((await read()).world, current);
});

test('unknown entity and stale epoch are rejected', async t => {
  const { app, headers, payload } = await setup(t);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/entities/missing', headers, payload: payload() })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/entities', headers,
    payload: { ...payload(), expectedEpoch: 'previous-process' },
  })).statusCode, 409);
});

test('management writes reject missing token, foreign origins, and replication credentials', async t => {
  const { app, headers, payload } = await setup(t);
  for (const requestHeaders of [
    {},
    { ...headers, origin: 'https://untrusted.example' },
    { ...headers, authorization: 'Bearer replication-credential' },
    { ...headers, host: 'untrusted.example' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/entities', headers: requestHeaders, payload: payload() });
    assert.equal(response.statusCode, 403);
  }
  assert.equal((await app.inject({ url: '/api/world', headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
});

test('failed persistence never publishes a changed world and does not poison future writes', async t => {
  const memory = new MemoryPersistence();
  let failSave = false;
  const { app, read, headers, payload } = await setup(t, { persistence: {
    durable: false, load: id => memory.load(id),
    save: async world => { if (failSave) throw new Error('unavailable'); await memory.save(world); },
  } });
  failSave = true;
  assert.equal((await app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload() })).statusCode, 503);
  assert.equal((await read()).world.revision, 0);
  failSave = false;
  assert.equal((await app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload() })).statusCode, 201);
});

test('entity limit is enforced without changing revision', async t => {
  const { app, read, headers, payload } = await setup(t);
  let world = (await read()).world;
  for (let i = 0; i < 64; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload(world) });
    assert.equal(response.statusCode, 201);
    world = response.json().world;
  }
  const overflow = await app.inject({ method: 'POST', url: '/api/entities', headers, payload: payload(world) });
  assert.equal(overflow.statusCode, 409);
  assert.equal(overflow.json().code, 'ENTITY_LIMIT');
  assert.equal((await read()).world.revision, 64);
});


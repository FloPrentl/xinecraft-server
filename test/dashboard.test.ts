import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildApp } from '../src/app.js';
import { createWorld } from '../src/model.js';
import type { World } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('Dashboard did not reach the expected state');
    await delay(5);
  }
}

async function dashboard(t: TestContext, seed?: World) {
  const persistence = new MemoryPersistence();
  if (seed) await persistence.save(seed);
  const app = await buildApp({ persistence });
  const page = await app.inject('/');
  const dom = new JSDOM(page.body, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await app.close(); });
  const css = dom.window.document.createElement('style');
  css.textContent = await readFile('public/dashboard.css', 'utf8');
  dom.window.document.head.append(css);
  // Exercise actual management handlers without launching or controlling a browser.
  dom.window.fetch = (async (url: string, options?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(options?.headers).entries());
    const response = await app.inject({
      method: (options?.method ?? 'GET') as 'GET' | 'POST' | 'PUT',
      url, headers,
      ...(typeof options?.body === 'string' ? { payload: options.body } : {}),
    });
    return new Response(response.body, { status: response.statusCode });
  }) as typeof fetch;
  dom.window.eval(await readFile('public/dashboard.js', 'utf8'));
  const element = (id: string) => dom.window.document.getElementById(id) as HTMLElement;
  const input = (id: string, value: string) => {
    (element(id) as HTMLInputElement).value = value;
    element(id).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const submit = () => element('entity-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => element('block-total').textContent === String(seed?.state.blocks.length ?? 0));
  return { app, dom, element, input, submit };
}

test('dashboard shows 20 blocks, creates an entity, selects it, and saves editable attributes', { timeout: 5000 }, async t => {
  const seed = createWorld('demo');
  seed.state.blocks = Array.from({ length: 24 }, (_, i) => ({
    position: { x: Math.floor(i / 16), y: 1, z: i % 16 }, block: 'minecraft:glass',
  }));
  const { app, dom, element, input, submit } = await dashboard(t, seed);
  assert.equal(dom.window.document.querySelectorAll('#block-rows tr').length, 20);
  assert.equal(element('entity-total').textContent, '0');
  assert.equal(element('entity-form').hidden, true);
  element('new-entity').click();
  assert.equal(element('entity-form').hidden, false);
  assert.equal(element('save-entity').textContent, 'Create entity');
  submit();
  await until(() => element('entity-total').textContent === '1');
  const id = (element('entity-id') as HTMLInputElement).value;
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal((element('entity-id') as HTMLInputElement).readOnly, true);
  assert.equal(dom.window.document.querySelector('.entity-item')?.getAttribute('aria-pressed'), 'true');
  input('position-x', '4.5');
  input('position-y', '6');
  input('rotation-yaw', '120');
  input('rotation-pitch', '-30');
  submit();
  await until(() => element('revision').textContent === '2');
  const world = (await app.inject('/api/world')).json().world as World;
  assert.equal(world.state.entities[0]?.id, id);
  assert.equal(world.state.entities[0]?.position.x, 4.5);
  assert.equal(world.state.entities[0]?.yaw, 120);
  assert.equal(world.state.entities[0]?.pitch, -30);
  assert.match(element('entity-list').textContent!, /X 4.5/);
  assert.equal(dom.window.document.querySelectorAll('#block-rows tr').length, 20);
  element('new-entity').click();
  submit();
  await until(() => element('entity-total').textContent === '2');
  const first = [...dom.window.document.querySelectorAll<HTMLButtonElement>('.entity-item')].find(button => button.dataset.entityId === id)!;
  first.click();
  assert.equal((element('entity-id') as HTMLInputElement).value, id);
  assert.equal((element('position-x') as HTMLInputElement).value, '4.5');
  assert.equal((element('rotation-pitch') as HTMLInputElement).value, '-30');
});

test('invalid input is not submitted and discarding a draft restores saved values', { timeout: 5000 }, async t => {
  const { app, element, input, submit } = await dashboard(t);
  element('new-entity').click();
  submit();
  await until(() => element('entity-total').textContent === '1');
  input('position-x', '0');
  assert.equal((element('position-x') as HTMLInputElement).validity.rangeUnderflow, true);
  submit();
  assert.equal((await app.inject('/api/world')).json().world.revision, 1);
  element('new-entity').click();
  assert.match(element('notice').textContent!, /Save or discard/);
  element('discard').click();
  assert.equal((element('position-x') as HTMLInputElement).value, '8');
  assert.equal(element('draft-badge').hidden, true);
});

test('all entities remain selectable inside a scrollable list', { timeout: 5000 }, async t => {
  const seed = createWorld('demo');
  seed.state.entities = Array.from({ length: 24 }, (_, index) => ({
    id: randomUUID(), kind: 'minecraft:pig', position: { x: 8, y: 1, z: 8 }, yaw: index * 10, pitch: 0,
  }));
  const { dom, element } = await dashboard(t, seed);
  const rows = dom.window.document.querySelectorAll<HTMLButtonElement>('.entity-item');
  assert.equal(rows.length, 24);
  assert.equal(dom.window.getComputedStyle(element('entity-list')).overflowY, 'auto');
  assert.equal(element('entities-empty').hidden, true);
  const last = rows[23]!;
  last.click();
  assert.equal((element('entity-id') as HTMLInputElement).value, last.dataset.entityId);
  assert.equal(dom.window.document.querySelectorAll('.entity-item[aria-pressed=true]').length, 1);
});

test('refresh preserves an unsaved draft and a stale save cannot overwrite another editor', { timeout: 5000 }, async t => {
  const { app, element, input, submit } = await dashboard(t);
  element('new-entity').click();
  submit();
  await until(() => element('entity-total').textContent === '1');
  input('position-x', '5');
  const state = (await app.inject('/api/world')).json();
  const entityId = state.world.state.entities[0].id;
  await app.inject({ method: 'PUT', url: `/api/entities/${entityId}`,
    headers: { 'x-xinecraft-management': state.managementToken },
    payload: { expectedEpoch: state.world.epoch, expectedRevision: state.world.revision,
      attributes: { position: { x: 12, y: 1, z: 8 }, yaw: 0, pitch: 0 },
    },
  });
  element('refresh').click();
  await until(() => element('revision').textContent === '2');
  assert.equal((element('position-x') as HTMLInputElement).value, '5');
  submit();
  await until(() => !element('form-error').hidden);
  assert.match(element('form-error').textContent!, /world changed/i);
  assert.equal((await app.inject('/api/world')).json().world.state.entities[0].position.x, 12);
  element('discard').click();
  assert.equal((element('position-x') as HTMLInputElement).value, '12');
});

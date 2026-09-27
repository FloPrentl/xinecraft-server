'use strict';

const $ = id => document.getElementById(id);
const fields = ['position-x', 'position-y', 'position-z', 'rotation-yaw', 'rotation-pitch'];
let world;
let managementToken;
let selectedId = null;
let creating = false;
let dirty = false;
let busy = false;
let loading = false;
let draftVersion;
let online = false;

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = !message;
}
function connection(connected) {
  online = connected;
  $('connection').replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $('connection').append(dot, document.createTextNode(connected ? 'Server connected' : 'Server unavailable'));
  $('connection').classList.toggle('offline', !connected);
  controls();
}
function controls() {
  $('new-entity').disabled = busy || loading || !world || !online || world.state.entities.length >= 64;
  $('save-entity').disabled = busy || loading || !online || (!creating && !dirty);
  $('discard').disabled = busy;
  $('refresh').disabled = busy || loading;
  fields.forEach(id => { $(id).disabled = busy; });
  document.querySelectorAll('.entity-item').forEach(button => { button.disabled = busy; });
  $('draft-badge').hidden = !dirty;
  $('save-entity').textContent = busy ? 'Saving…' : creating ? 'Create entity' : 'Save changes';
}
function attributes() {
  return {
    position: { x: $('position-x').valueAsNumber, y: $('position-y').valueAsNumber, z: $('position-z').valueAsNumber },
    yaw: $('rotation-yaw').valueAsNumber, pitch: $('rotation-pitch').valueAsNumber,
  };
}
function showEditor(entity) {
  $('inspector-empty').hidden = !!entity;
  $('entity-form').hidden = !entity;
  dirty = false;
  $('form-error').hidden = true;
  $('inspector-heading').textContent = creating ? 'New entity' : 'Entity inspector';
  if (entity) {
    $('entity-id').value = entity.id ?? 'Assigned when created';
    $('entity-title').textContent = creating ? 'Create a pig' : 'Pig';
    const values = [entity.position.x, entity.position.y, entity.position.z, entity.yaw, entity.pitch];
    fields.forEach((id, i) => { $(id).value = values[i]; });
    draftVersion = { expectedEpoch: world.epoch, expectedRevision: world.revision };
  }
  controls();
}
function selectEntity(id) {
  if (busy) return;
  if (dirty) { notice('Save or discard your changes before selecting another entity.', true); return; }
  selectedId = id;
  creating = false;
  notice('');
  renderEntities();
  showEditor(world.state.entities.find(entity => entity.id === id));
}
function renderEntities() {
  const list = $('entity-list');
  const scrollTop = list.scrollTop;
  const focusId = document.activeElement?.dataset?.entityId;
  list.replaceChildren();
  for (const entity of world.state.entities) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entity-item';
    button.dataset.entityId = entity.id;
    button.setAttribute('aria-pressed', String(entity.id === selectedId && !creating));
    const icon = document.createElement('span'); icon.className = 'pig-mark'; icon.textContent = '▣'; icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span'); text.className = 'entity-item-text';
    const title = document.createElement('strong'); title.textContent = `Pig · ${entity.id.slice(0, 8)}`;
    const location = document.createElement('small'); location.textContent = `X ${entity.position.x}  ·  Y ${entity.position.y}  ·  Z ${entity.position.z}`;
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    text.append(title, location); button.append(icon, text, arrow);
    button.addEventListener('click', () => selectEntity(entity.id));
    list.append(button);
    if (focusId === entity.id) button.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
  $('entities-empty').hidden = world.state.entities.length > 0;
}
function renderWorld() {
  $('world-name').textContent = world.worldId;
  $('block-total').textContent = world.state.blocks.length.toLocaleString();
  $('entity-total').textContent = world.state.entities.length;
  $('entities-count').textContent = world.state.entities.length;
  $('revision').textContent = world.revision;
  const blocks = [...world.state.blocks].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z).slice(0, 20);
  $('blocks-count').textContent = blocks.length;
  $('block-summary').textContent = `Showing ${blocks.length} of ${world.state.blocks.length} non-air blocks`;
  $('blocks-empty').hidden = blocks.length > 0;
  $('blocks-empty').textContent = 'No non-air blocks in this area.';
  $('block-rows').replaceChildren();
  for (const block of blocks) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const name = document.createElement('span'); name.className = 'block-name';
    const kind = block.block.replace('minecraft:', '');
    const icon = document.createElement('span'); icon.className = `block-icon ${kind}`; icon.setAttribute('aria-hidden', 'true');
    name.title = block.block;
    name.append(icon, document.createTextNode(kind[0].toUpperCase() + kind.slice(1)));
    nameCell.append(name); row.append(nameCell);
    for (const value of [block.position.x, block.position.y, block.position.z]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    $('block-rows').append(row);
  }
  renderEntities();
  controls();
}
async function loadWorld(manual = false) {
  if (loading || busy) return;
  loading = true;
  controls();
  try {
    const response = await fetch('/api/world', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load the world. Check the server and try Refresh.');
    const data = await response.json();
    const changed = !world || world.epoch !== data.world.epoch || world.revision !== data.world.revision;
    world = data.world;
    managementToken = data.managementToken;
    const wasOffline = !online;
    connection(true);
    if (wasOffline) notice('');
    $('storage-note').textContent = data.durable ? 'State saved by the server.' : 'In-memory preview · State resets when this process restarts.';
    if (changed) {
      renderWorld();
      if (dirty) notice('The world changed. Your draft is preserved. Discard it to load the latest values before saving.', true);
      else if (!creating) {
        const selected = world.state.entities.find(entity => entity.id === selectedId);
        if (!selected) selectedId = null;
        showEditor(selected);
      } else {
        draftVersion = { expectedEpoch: world.epoch, expectedRevision: world.revision };
      }
    }
    if (manual && !(changed && dirty)) notice('World refreshed.');
  } catch (error) {
    connection(false);
    notice(error.message || 'Unable to reach the server. Your draft is preserved.', true);
  } finally {
    loading = false;
    controls();
  }
}
$('new-entity').addEventListener('click', () => {
  if (dirty) { notice('Save or discard your changes before creating another entity.', true); return; }
  creating = true;
  selectedId = null;
  notice('');
  renderEntities();
  showEditor({ position: { x: 8, y: 1, z: 8 }, yaw: 0, pitch: 0 });
  $('position-x').focus();
});
$('entity-form').addEventListener('input', () => { dirty = true; $('form-error').hidden = true; controls(); });
$('discard').addEventListener('click', () => {
  const wasCreating = creating;
  creating = false;
  if (wasCreating) selectedId = null;
  showEditor(world.state.entities.find(entity => entity.id === selectedId));
  renderEntities();
  notice('Draft discarded.');
});
$('entity-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || loading || !online || !$('entity-form').reportValidity()) return;
  // Keep the epoch/revision from when editing began; never overwrite a newer server edit.
  const payload = { ...draftVersion, attributes: attributes() };
  const wasCreating = creating;
  busy = true;
  controls();
  $('form-error').hidden = true;
  try {
    const response = await fetch(wasCreating ? '/api/entities' : `/api/entities/${encodeURIComponent(selectedId)}`, {
      method: wasCreating ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Xinecraft-Management': managementToken },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to save this entity.');
    world = result.world;
    selectedId = result.entity.id;
    creating = false;
    dirty = false;
    renderWorld();
    showEditor(result.entity);
    notice(wasCreating ? 'Entity created. Select it any time to edit its attributes.' : 'Entity changes saved.');
  } catch (error) {
    $('form-error').textContent = error.message || 'Unable to save. Your draft is preserved.';
    $('form-error').hidden = false;
  } finally {
    busy = false;
    controls();
  }
});
$('refresh').addEventListener('click', () => { void loadWorld(true); });
void loadWorld();
setInterval(() => { if (!document.hidden) void loadWorld(); }, 5000);

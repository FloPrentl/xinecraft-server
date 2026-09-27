# Xinecraft Server: Vision and Design

## Vision

The web server owns the Minecraft world state. `xinecraft-server` provides the authoritative state, management UI, and push stream. The mod in `xinecraft-mod` connects to it and applies that state to a single-player integrated Minecraft server.

Replication is strictly one-way: **web server → mod → Minecraft world**. The mod never uploads blocks, entities, player state, local changes, or observations. It only identifies the requested world, acknowledges applied revisions, or requests resynchronization. Local state never initializes, merges into, or overrides server state.

The system assumes an initially empty **Superflat** client world: the flat ground already exists, with no blocks or entities above it. The server manages **only space above ground level**. Ground and everything below it are outside replication scope and are never included in snapshots or cleared by the adapter.

The first milestone controls a small fixed area; expansion toward the full above-ground world comes later. Minecraft acts as a viewer: camera movement and rendering are allowed; local editing and autonomous simulation in the controlled area are prevented. Dedicated servers, LAN guests, and multiplayer hosting are permanently outside product scope.

```text
Management UI / API → Web server (single source of truth)
                              │
                              │ snapshot, then ordered patches
                              ▼
                     Single-player Minecraft mod
                              │
                              ▼
                     Above-ground viewer area
```

## Start and stop

Use Node.js 24 and npm. In this repository, run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd start
```

Open **http://127.0.0.1:3000/**. Stop with **Ctrl+C** in the server terminal. After source edits, run `npm.cmd run build` (or `npm.cmd test`) before restarting: `npm start` runs compiled files.

This workspace has an ignored portable Node installation. If Node is not on PATH, enable it for the current terminal first:

```powershell
$env:PATH = "$PWD\.tools\node-v24.21.0-win-x64;$env:PATH"
```

A fresh clone needs Node installed separately. The server binds only to `127.0.0.1`.

| Environment setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port, 1–65535. |
| `WORLD_ID` | `demo` | 1–64 letters, digits, underscores, or hyphens. |
| `REPLICATION_TOKEN` | Unset | Optional bearer token, at least 16 characters; also configure it in the mod. |

**State is currently in memory. Restarting the server resets edits, creates a new epoch, and gives reconnecting viewers an empty above-ground scene.** Minecraft's saved copy is never a recovery source. The persistence interface validates loaded data and fails startup on invalid data rather than silently discarding it. Durable storage remains future work.

## Connect Minecraft

1. Build/install the mod and Fabric API for Minecraft 26.3; see [the mod README](../xinecraft-mod/README.md).
2. Create a single-player **Superflat** viewer world with a solid top layer, structures disabled, and cheats enabled. Start with no above-ground blocks or entities. Keep it unshared.
3. Start this server, enter the world, and run `/xine connect`.
4. The mod creates `xinecraft-replication.json` inside that save and connects to `ws://127.0.0.1:3000/replication/v1`, world `demo`. The binding reconnects automatically when the save reopens. `/xine status` reports progress.
5. Create a pig in the web UI and change its position or rotation. Accepted edits are pushed directly to Minecraft without polling or reconnecting.

For another port, world ID, or token, close the world, edit its binding file, and reopen it. The mod accepts loopback WebSocket URLs only. A disconnected viewer keeps its restrictions and last applied scene while retrying. It never uploads its save.

## Coordinates and state profile

`above-ground-v1` uses **ground-relative Y**. Y = 0 denotes the existing top ground block; Y = 1 is the first block position above it. Entity Y = 1 places its feet on the surface. X and Z are Minecraft world coordinates. The mod derives ground height from its Superflat generator configuration and translates `minecraftY = groundY + serverY`. The height is never uploaded.

| Property | Current contract |
| --- | --- |
| Dimension | `minecraft:overworld` |
| Block coverage, inclusive | X/Z 0–15, relative Y 1–16; one 16×16×16 area |
| Ground and underground | Not managed, transmitted, created, or removed |
| Initial state | No stored blocks or entities; air throughout coverage |
| Block types | Air, stone, dirt, glass; snapshots store only non-air entries |
| Entities | Up to 64 static pigs with server UUID, position, yaw, pitch |
| Entity bounds | X/Y/Z 1–15; yaw 0 ≤ value < 360; pitch −90…90 |
| Presentation | Clear weather, time 6000; spectator spawn `(8, 6, 8)` |

An omitted block means air **inside coverage only**. A full snapshot removes local-only blocks and non-player entities in that area. Every connection gets a complete replacement snapshot. Ground and other parts of the save remain outside this milestone. The old `test-area-v1` profile with its generated floor is incompatible and rejected.

Players are cameras, not replicated entities. Pigs have no AI, gravity, damage, or autonomous movement. The mod holds the covered chunk loaded, blocks local block writes and scheduled block/fluid ticks in coverage, suppresses covered entity ticks/spawns, and restricts commands in the bound viewer save. LAN publishing is blocked. Random ticks, mob spawning, weather progression, and time progression are disabled for the viewer world; these game rules are saved by Minecraft. This profile excludes block entities, inventories, arbitrary NBT, fluids, redstone, and active entities.

Entity identities remain stable across updates. If a server UUID collides with a player or an entity outside coverage, application fails rather than taking ownership of it. Previously managed entities are restored or removed by ID even if moved outside coverage. No player identity, inventory, statistics, or camera movement is uploaded.

## Dashboard

The first panel lists the first 20 stored above-ground blocks ordered by X/Y/Z; it starts empty. Blocks are read-only in the UI. The second panel lists all entities in a scrollable list with a **New entity** control. Selecting an entity opens its inspector. Position, yaw, and pitch are editable; UUID and type are fixed. A new pig defaults to `(8, 1, 8)`.

**Save changes** commits to the server and publishes a patch. **Discard** restores saved values. The dashboard refreshes every five seconds while visible and has a manual Refresh button. Drafts survive refresh; stale edits are rejected instead of overwriting newer state. Loading, empty, offline, validation, and save-error states are shown.

## Local management API

| Route | Behavior |
| --- | --- |
| `GET /health` | Epoch/revision, persistence mode, connected/synchronized viewer counts. |
| `GET /api/world` | `{world, managementToken, durable}`. |
| `POST /api/entities` | Create a pig with a server-generated UUID; `{world, entity}` (201). |
| `PUT /api/entities/:id` | Edit an existing pig; `{world, entity}` (200). |
| `POST /api/transactions` | Apply block/entity operations atomically; `{world, operations}` (200). |

All writes require the `X-Xinecraft-Management` token from the read route, `expectedEpoch`, and `expectedRevision`. Entity routes take `attributes: {position: {x, y, z}, yaw, pitch}`. Transactions take `operations` using the patch shapes below. This API is for the UI/local administration; the mod never calls it.

Writes are serialized: validate the entire transaction and resulting world, save, install the revision, then publish. Unknown fields, unsupported content, duplicate targets, and positions at/below ground are rejected. Invalid input returns 400; missing entities 404; conflicts/entity limit 409; failed saves 503. Failed transactions do not change state or publish patches.

Management routes require a loopback Host and reject foreign origins, cross-site requests, and Authorization headers. Replication credentials cannot authorize management. This is a local development boundary, not production authentication. Keep the server loopback-only.

Example block edit in PowerShell:

```powershell
$state = Invoke-RestMethod http://127.0.0.1:3000/api/world
$body = @{
  expectedEpoch = $state.world.epoch
  expectedRevision = $state.world.revision
  operations = @(@{ op = 'SET_BLOCK'; position = @{ x = 4; y = 1; z = 4 }; block = 'minecraft:glass' })
} | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:3000/api/transactions -Method Post -ContentType application/json -Headers @{ 'X-Xinecraft-Management' = $state.managementToken } -Body $body
```

Use `minecraft:air` to remove it. The Superflat ground beneath it stays intact.

## Replication protocol v1

Endpoint: `/replication/v1`. UTF-8 JSON text messages only, maximum 1 MiB each; compression disabled. Browser Origin headers are rejected. When configured, upgrade requires `Authorization: Bearer <REPLICATION_TOKEN>`. Credentials never appear in URLs/world payloads.

Every envelope has `protocolVersion: 1`. `worldId`, `epoch`, and `sessionId` are opaque 1–64 character identifiers (`A–Z`, `a–z`, digits, `_`, `-`). Revisions are non-negative JavaScript-safe integers. Epoch identifies a history; session identifies a connection. Never compare revisions across epochs.

| Message | Direction | Other fields |
| --- | --- | --- |
| `HELLO` | Mod → server | `worldId` |
| `WELCOME` | Server → mod | `worldId`, `sessionId`, `epoch` |
| `SNAPSHOT` | Server → mod | `worldId`, `sessionId`, `epoch`, `revision`, `state` |
| `PATCH` | Server → mod | `worldId`, `sessionId`, `epoch`, `baseRevision`, `revision`, `operations` |
| `ACK` | Mod → server | `sessionId`, `epoch`, `revision` |
| `RESYNC_REQUEST` | Mod → server | `sessionId`, `reason`: `REVISION_GAP` or `APPLY_FAILED` |
| `ERROR` | Either | Enumerated `code` only |

1. The mod sends HELLO. The server sends WELCOME and a complete snapshot, capturing state and subscribing to subsequent commits without a gap.
2. The mod validates the complete state, applies it on the integrated server thread, then acknowledges. Receipt alone never earns an ACK.
3. Changes during synchronization are queued. After snapshot ACK, contiguous patches are sent one unacknowledged revision at a time: `baseRevision = currentRevision`, `revision = currentRevision + 1`.
4. The mod validates all operations before application. Duplicate/stale patches do not reapply state. A gap requests resynchronization. Application failure never advances revision or sends an ACK.
5. Resynchronization closes with code 1012; reconnect creates a fresh session and snapshot. Old-session callbacks are discarded. There is no resume-from-local-save path.
6. The server accepts only the pending revision ACK (or a duplicate latest ACK), with matching session/epoch. ACK changes progress, never authority. A failed viewer cannot roll back a commit.

Strict inbound shapes reject extra fields, uploads, arbitrary diagnostics, and unknown types. The implemented mod sends only HELLO, ACK, and RESYNC_REQUEST; WebSocket ping/pong contains no world data. Error codes are `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `WORLD_NOT_FOUND`, `UNAUTHORIZED`, `STATE_UNSUPPORTED`, `APPLY_FAILED`.

Handshake timeout: 10 seconds. Application ACK timeout: 30 seconds. Ping every 15 seconds; disconnect after 30 seconds without pong. Pending queues: maximum 128 patches or 8 MiB; overflow disconnects the slow viewer for a new snapshot rather than dropping changes. The mod retries with 1–30 second exponential backoff plus jitter. Authentication, policy rejection, unsupported state, or repeated application failure require correction and reopening the world. Failed application is retried once through a new snapshot.

### Replacement and viewer behavior

Snapshots replace all represented state within coverage, including removals. Patches replace/delete explicit targets. Local data is never used to fill missing values. Application is idempotent: no loot on block removal, no death drops on entity removal, no duplicate UUIDs on replay. Metadata/environment/viewer settings are fixed in this profile.

Before initial synchronization and after partial application failure, the client masks the world while retaining usable menus. The server-thread application runs as one task for this bounded area. There is no engine rollback on failure; restrictions stay active and recovery uses a full snapshot. After disconnection, the last successfully applied scene stays visible with a status indicator. Reconnecting resets the camera to the viewer spawn; patches do not. Updates continue while the game menu is open, so switching to the browser does not pause replication.

### Control examples

```json
{"protocolVersion":1,"type":"HELLO","worldId":"demo"}
```

```json
{"protocolVersion":1,"type":"ACK","sessionId":"session-1","epoch":"epoch-1","revision":0}
```

```json
{"protocolVersion":1,"type":"RESYNC_REQUEST","sessionId":"session-1","reason":"REVISION_GAP"}
```

### Complete initial snapshot

```json
{
  "protocolVersion": 1,
  "type": "SNAPSHOT",
  "worldId": "demo",
  "sessionId": "session-1",
  "epoch": "epoch-1",
  "revision": 0,
  "state": {
    "schemaVersion": 1,
    "profile": "above-ground-v1",
    "scope": {
      "dimension": "minecraft:overworld",
      "coordinates": "ground-relative",
      "min": {"x": 0, "y": 1, "z": 0},
      "max": {"x": 15, "y": 16, "z": 15}
    },
    "defaultBlock": "minecraft:air",
    "blocks": [],
    "entities": [],
    "environment": {"timeOfDay": 6000, "weather": "clear"},
    "viewer": {"mode": "spectator", "spawn": {"x": 8, "y": 6, "z": 8}}
  }
}
```

### Patch operations

`SET_BLOCK` replaces a block; air removes the stored entry. `PUT_ENTITY` creates or fully replaces a UUID. `REMOVE_ENTITY` removes a UUID (missing is a no-op). Each nonempty accepted transaction advances revision once, even if values already match. Reject duplicate block/entity targets, including put+remove for the same UUID. Allow 1–4160 operations and at most 64 resulting entities.

```json
{
  "protocolVersion": 1,
  "type": "PATCH",
  "worldId": "demo",
  "sessionId": "session-1",
  "epoch": "epoch-1",
  "baseRevision": 0,
  "revision": 1,
  "operations": [
    {"op":"SET_BLOCK","position":{"x":4,"y":1,"z":4},"block":"minecraft:glass"},
    {"op":"PUT_ENTITY","entity":{"id":"00000000-0000-4000-8000-000000000001","kind":"minecraft:pig","position":{"x":8,"y":1,"z":8},"yaw":90,"pitch":0}},
    {"op":"REMOVE_ENTITY","id":"00000000-0000-4000-8000-000000000002"}
  ]
}
```

## Implementation and verification

The server uses TypeScript, Fastify, Zod, and WebSockets, with plain HTML/CSS/JavaScript for the UI. `model.ts` defines state, `management.ts` serializes commits, `protocol.ts` validates messages/transactions, and `app.ts` serves HTTP and streams. The mod separates transport, strict protocol state, and Minecraft application. Network callbacks schedule application on the server thread; no Minecraft state is serialized for upload.

`npm.cmd test` covers initialization, schemas/README examples, validation/conflicts, save failures, patch ordering, queue overflow, reconnect snapshots, upload rejection, and dashboard DOM behavior. The mod build runs permission/protocol regression checks. See its README for the cross-repository transport check. Automated tests do not substitute for a Minecraft launch to verify rendering, mixin behavior, and gameplay boundaries.

Manual acceptance: connect a fresh Superflat save; create/move/rotate a pig from the UI; add/remove a block through the transaction API; verify unchanged ground and blocked local commands/edits; verify updates with the menu open; stop/restart the server and verify automatic empty-snapshot replacement. Verify local-only above-ground state disappears, pigs remain static, LAN publishing is blocked, initial/recovery masking works, and offline status remains visible.

## Next milestones

- Durable authoritative storage and restart recovery.
- In-game acceptance testing and boundary/mixin hardening as Minecraft versions change.
- Expanded above-ground coverage, richer state types, scalable snapshots/patches.
- Richer management tools and production authentication if deployment extends beyond loopback.

Expansion must preserve one-way authority, full replacement semantics, integrated single-player scope, and exclusion of shared Superflat ground.

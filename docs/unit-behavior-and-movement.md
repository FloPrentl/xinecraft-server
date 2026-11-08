# Unit Behavior, Smooth Movement, and Server-Side Pathfinding

## 1. Context and Architectural Constraints

In the Xinecraft architecture, `xinecraft-server` is the **single source of truth** for the above-ground world (`above-ground-v1`), and replication is strictly **one-way** (`xinecraft-server → xinecraft-mod → Minecraft client`):

- **Authoritative Server State**: [`World`](../src/model.ts) stores all above-ground blocks (`state.blocks`) and entities (`state.entities`), serialized through [`WorldManager`](../src/management.ts).
- **Ordered Replication Stream**: Viewers receive an initial `SNAPSHOT` followed by ordered, unacknowledged-one-at-a-time `PATCH` messages (`SET_BLOCK`, `PUT_ENTITY`, `REMOVE_ENTITY`) and respond with `ACK` after applying changes on the integrated server thread.
- **No Client-to-Server State Uploads**: The Fabric mod (`xinecraft-mod`) never uploads entity positions, terrain observations, or local simulation state back to `xinecraft-server`.

When introducing autonomous **unit behavior** on `xinecraft-server` (for example, a wandering algorithm that moves a `minecraft:pig` around the world), two core engineering challenges arise:

1. **Visual Teleportation ("Jumping") under Low-Frequency Updates**: How to make units walk smoothly in the Minecraft viewer without flooding the replication stream with high-frequency position patches.
2. **Obstacle Avoidance and Pathfinding**: How to navigate around world obstacles (such as trees, walls, or other blocks) while preserving strict server-side authority.

---

## 2. Problem 1: Low-Frequency Updates and Visual "Jumping"

### 2.1 Root Cause in the Current Mod Implementation

Currently, `xinecraft-mod` treats every replicated entity as a frozen, static object:

1. **Instant Snapping**: In `WorldReplica.configure` (`xinecraft-mod/src/main/java/dev/xinecraft/replication/WorldReplica.java`), whenever an entity's coordinates or rotation differ from `ReplicaState.VisualEntity`, the mod executes:
   ```java
   pig.snapTo(data.x(), groundY + data.y(), data.z(), data.yaw(), data.pitch());
   pig.setYHeadRot(data.yaw());
   pig.setYBodyRot(data.yaw());
   ```
   `Entity.snapTo(...)` immediately overwrites both the current position (`x, y, z`) and the previous-tick position (`xo, yo, zo`), causing an instantaneous teleport with zero frame interpolation.
2. **Suppressed Entity Ticking**: In `ServerLevelMixin` (`xinecraft-mod/src/main/java/dev/xinecraft/mixin/ServerLevelMixin.java`), `tickNonPassenger` and `tickPassenger` are cancelled for all frozen entities (`ReplicationRuntime.freezes(entity)`). Because the entity never ticks on the integrated server:
   - Minecraft's built-in client lerp (`lerpTo`) and tick-to-frame interpolation (`xo → x` over `partialTick`) never advance.
   - `WalkAnimationState` (`walkAnimation`) is never updated, so the pig's legs remain completely rigid even when its coordinates change.
3. **Lockstep ACK Cadence**: Because the replication protocol sends one unacknowledged `PATCH` at a time and waits for an `ACK` after integrated-server application, pushing raw 20–60 Hz coordinate ticks over the transactional state stream is unnecessary overhead.

### 2.2 Solution Options for Smooth Movement

#### Option A: Client-Side Target Interpolation in `WorldReplica.tick()` (Recommended Baseline)

**Requires zero changes to the replication wire protocol.**

Instead of teleporting immediately on `PATCH`, `WorldReplica` treats incoming `PUT_ENTITY` coordinates as a **target pose** and smoothly steps the entity toward that target across integrated server ticks (20 TPS = 50 ms per tick), while Minecraft's renderer interpolates between ticks at the monitor's refresh rate (60–144+ FPS).

- **On `SNAPSHOT` (or initial spawn)**:
  - Snap the entity directly to `(targetX, groundY + targetY, targetZ, targetYaw, targetPitch)` so initial placement is immediate.
- **On `PATCH` (`PUT_ENTITY`)**:
  - Record an interpolation segment per entity UUID:
    - `startPos = currentRenderPos`, `endPos = (data.x(), groundY + data.y(), data.z())`
    - `startYaw = currentYaw`, `endYaw = data.yaw()` (using shortest-angle wraparound across `0°/360°`)
    - `startTick = server.getTickCount()`, `durationTicks = N` (e.g., `5` to `20` ticks, matching the server's behavior tick interval, or derived from a movement speed such as `2.0 blocks/sec`).
    - If `distance(startPos, endPos) > TELEPORT_THRESHOLD` (e.g., `> 8` blocks), snap immediately instead of interpolating.
- **On each integrated server tick (`WorldReplica.tick()`)**:
  1. Copy current coordinates/angles into `pig.xo`, `pig.yo`, `pig.zo`, `pig.yRotO`, `pig.xRotO`, `pig.yHeadRotO`, `pig.yBodyRotO` **before** updating the new tick position. This enables Minecraft's native sub-tick frame interpolation (`partialTick`) at 60+ FPS.
  2. Compute normalized progress $t = \min\left(1, \frac{\text{currentTick} - \text{startTick}}{\text{durationTicks}}\right)$ and set `pig.setPos(lerp(startPos, endPos, t))` plus interpolated yaw/pitch.
  3. Advance limb swing (`pig.walkAnimation.update(...)`) proportional to the horizontal step distance $\Delta d = \sqrt{\Delta x^2 + \Delta z^2}$ so the pig's legs animate naturally while moving and settle to rest when $t = 1$.

**Result**: Even if `xinecraft-server` only commits a new entity position every **500 ms – 1000 ms** (1–2 Hz), the viewer renders continuous 60+ FPS walking with animated legs and smooth turning.

#### Option B: Trajectory / Waypoint Intent in the Protocol (Recommended for Multi-Step Paths)

When a unit plans a multi-block walk (e.g., wandering 6 blocks around a tree), sending a separate `PATCH` for every intermediate step is optional. Instead, `entitySchema` in [`src/model.ts`](../src/model.ts) can be extended (or versioned) with an optional movement plan:

```ts
movement?: {
  waypoints: Array<{ x: number; y: number; z: number }>;
  speedBlocksPerSecond: number;
}
```

- **How it works**:
  - When a unit starts moving from `(8, 1, 8)` to `(12, 1, 10)`, the server commits a single patch containing the waypoint list and speed (or updates `position` at major waypoints / completion).
  - The mod steps the pig along the polyline of waypoints at `speedBlocksPerSecond`.
- **Trade-off**:
  - Drastically reduces revision churn and `PATCH` traffic when many units move simultaneously.
  - However, because `state.entities[i].position` in `World` should reflect the authoritative position for new snapshots and the web dashboard inspector, the server simulation loop should still periodically advance `entity.position` (or compute it deterministically). Combining **Option A** (client interpolation in `WorldReplica`) with a **2–4 Hz server simulation step** (or waypoint segments) gives both accurate dashboard state and smooth in-game visuals.

---

## 3. Problem 2: Obstacles (Trees, Structures) and Server-Side Pathfinding

### 3.1 Does Pathfinding Belong on `xinecraft-server`?

**Yes.** Because replication is strictly one-way (`server → mod`), delegating pathfinding or obstacle avoidance to Minecraft's built-in `PathNavigation` / mob AI on the client would violate core architectural invariants:

- If the client steered the pig around a tree locally, `xinecraft-server` would not know the pig's actual position unless the mod uploaded entity coordinates back to the server.
- Two connected viewers (or the web dashboard and the Minecraft client) could diverge.

Therefore, `xinecraft-server` must compute obstacle-free paths itself.

### 3.2 Why Server-Side Pathfinding Is Practical and Lightweight Here

In many external-controller architectures, server-side pathfinding is difficult because the external server lacks an accurate representation of the game world's geometry. **In Xinecraft, `xinecraft-server` already owns the complete block map in memory (`world.state.blocks`) and the ground is a known flat plane (`Y = 0`).**

1. **Complete Obstacle Knowledge**:
   - Every tree trunk, leaf block, wall, or structure inside the controlled scope exists as an entry in `world.state.blocks` (with omitted coordinates guaranteed to be `minecraft:air` above the solid `Y = 0` ground layer).
   - No terrain scraping or client raycasting is required.
2. **Discrete Grid Topology**:
   - Minecraft blocks occupy integer grid coordinates $(x, y, z)$.
   - For a `minecraft:pig` (bounding box $0.9 \times 0.9 \times 0.9$ blocks, fitting within a $1 \times 1 \times 1$ cell when centered at integer/half-integer coordinates), walkability of a grid cell $(x, y, z)$ is a simple lookup over `state.blocks`:
     - **In bounds**: $1 \le x \le 15$, $1 \le y \le 15$, $1 \le z \le 15$.
     - **Supported underneath**: Either $y = 1$ (standing on the untouched Superflat ground at $y = 0$), or `hasSolidBlock(x, y - 1, z)` is true.
     - **Headroom / Body clearance**: `isPassable(x, y, z)` is true (no solid block at $(x, y, z)$). If stepping up 1 block ($y \to y + 1$), $(x, y + 1, z)$ above both the current cell and destination cell must also be passable.
     - **Diagonal corner-cutting prevention**: Moving diagonally from $(x, z)$ to $(x + \Delta x, z + \Delta z)$ is allowed only if both cardinal neighbors $(x + \Delta x, y, z)$ and $(x, y, z + \Delta z)$ are also passable, preventing the pig's hitbox from clipping block corners.

### 3.3 Grid A* Pathfinding Design for `xinecraft-server`

A self-contained **A* (A-Star)** pathfinder in TypeScript requires ~70–100 lines of code with zero external dependencies:

```text
┌───────────────────────────────────────────────────────────────────┐
│                         xinecraft-server                          │
│                                                                   │
│  ┌──────────────────────┐      ┌───────────────────────────────┐  │
│  │   World.state.blocks │───►  │ NavigationGrid / Walkability  │  │
│  └──────────────────────┘      │  - O(1) Set<"x,y,z"> lookup   │  │
│                                │  - Standable & clearance test │  │
│                                └──────────────┬────────────────┘  │
│                                               │                   │
│                                               ▼                   │
│  ┌──────────────────────┐      ┌───────────────────────────────┐  │
│  │  Unit Behavior Loop  │◄────►│        A* Pathfinder          │  │
│  │  (Wander / Goal AI)  │      │  - 4 or 8 cardinal/diagonal   │  │
│  └──────────┬───────────┘      │  - Step up/down (±1 Y)        │  │
│             │                  └───────────────────────────────┘  │
│             ▼                                                     │
│  ┌──────────────────────┐                                         │
│  │  WorldManager.commit │ ──► PATCH (PUT_ENTITY) ──► Mod Lerp     │
│  └──────────────────────┘                                         │
└───────────────────────────────────────────────────────────────────┘
```

#### Key Algorithm Details

1. **Fast Block Lookup Index**:
   - Build a `Set<string>` of solid block keys (`"${x},${y},${z}"`) from `world.state.blocks` whenever blocks change (or per tick). Lookup is $O(1)$.
2. **Neighbor Generation**:
   - From node $(x, y, z)$, evaluate the 4 cardinal directions $(\pm 1, 0)$, $(0, \pm 1)$ (and optionally 4 diagonals if both adjacent cardinals are clear).
   - Optionally allow vertical step-ups ($\Delta y = +1$) and step-downs ($\Delta y = -1$) when terrain blocks are placed on the ground.
3. **Heuristic and Cost**:
   - Orthogonal step cost: $1.0$; diagonal step cost: $\sqrt{2} \approx 1.414$; vertical step cost: $1.5$.
   - Heuristic $h(n, \text{goal})$: Octile distance in $(x, z)$ plus $|\Delta y|$.
4. **Yaw Calculation**:
   - Whenever a unit moves from $(x_0, z_0)$ to $(x_1, z_1)$, compute Minecraft yaw automatically so the pig faces its direction of travel:
     $$\text{yaw} = \left(\text{atan2}(-(x_1 - x_0), z_1 - z_0) \cdot \frac{180}{\pi} + 360\right) \bmod 360$$
5. **Dynamic Re-validation on Block Edits**:
   - Before advancing a unit to its next queued waypoint, check if that waypoint is still walkable in the latest `world.state.blocks` (in case a user or transaction placed a block or tree in its path mid-walk). If blocked, recompute A* or pick a new wander target.

---

## 4. End-to-End Wander Behavior Lifecycle

Putting both solutions together produces a clean, modular simulation loop:

1. **Behavior State Machine (Server-Side Only)**:
   - Each simulated entity maintains lightweight runtime AI state in a `BehaviorEngine` service on `xinecraft-server`:
     - `IDLE`: Wait for a random pause (`1.5s – 4.0s`), then pick a random walkable cell within radius $R$ (e.g., $3 \le R \le 6$ blocks).
     - `MOVING`: Hold the A* waypoint queue `[wp_1, wp_2, ..., wp_k]`.
2. **Simulation Tick (`BehaviorEngine.tick`, e.g., every `250 ms`–`500 ms`)**:
   - For each moving unit, pop or advance along the next waypoint at the unit's speed (e.g., `2.0 blocks/sec` $\Rightarrow$ `0.5` or `1.0` block per tick) and compute the facing `yaw`.
   - Batch all entity position/yaw updates for that tick into a **single atomic transaction** (`operations: [{ op: 'PUT_ENTITY', entity: ... }, ...]`) via [`WorldManager`](../src/management.ts).
3. **Conflict Handling with Manual Edits**:
   - Because `WorldManager` serializes commits, manual edits from the web UI or `/api/transactions` and AI behavior ticks never corrupt state. If a user manually edits an entity in the UI, the behavior engine can pause or reset that entity's current path.
4. **Client Visual Application (`xinecraft-mod`)**:
   - `WorldReplica` receives the `PATCH` on the integrated server thread.
   - Instead of calling `snapTo` directly, `WorldReplica.tick()` interpolates `x, y, z, yaw` over the tick window and drives `pig.walkAnimation`, producing smooth 60+ FPS walking and turning in Minecraft.

---

## 5. Recommended Implementation Phases

### Phase 1: Smooth Client Interpolation in `xinecraft-mod`
- Update `WorldReplica` (`xinecraft-mod/src/main/java/dev/xinecraft/replication/WorldReplica.java`) to maintain per-entity interpolation state (`startX/Y/Z`, `targetX/Y/Z`, `startYaw`, `targetYaw`, `startTick`, `durationTicks`).
- In `WorldReplica.tick()`, update `xo/yo/zo` and `yRotO/yHeadRotO/yBodyRotO`, interpolate position/rotation per tick, and advance `pig.walkAnimation` based on horizontal delta.
- **Verification**: Drag or change a pig's coordinates in the web dashboard (`http://127.0.0.1:3000/`) by 1–5 blocks and verify it walks and turns smoothly to the new location instead of teleporting.

### Phase 2: Server-Side Walkability & Grid A* Pathfinder
- Create `src/navigation.ts` in `xinecraft-server` with:
  - `isWalkable(blocks, x, y, z)` and `canStep(blocks, from, to)`
  - `findPath(blocks, start, goal)` returning an array of `{ x, y, z }` waypoints
  - `headingYaw(from, to)` helper for Minecraft yaw convention
- Add unit tests in `test/navigation.test.ts` covering open ground, obstacles/trees, L-shaped walls, unreachable goals, and corner-cutting prevention.

### Phase 3: Server-Side Unit Behavior Engine (Wandering Pigs)
- Create `src/behavior.ts` in `xinecraft-server` that ticks periodically, selects random reachable destinations for idle pigs, computes A* paths around `world.state.blocks`, and commits batched `PUT_ENTITY` updates through `WorldManager`.
- Expose a simple toggle or status control in the management API/UI (e.g., enable/disable autonomous wandering per entity or globally) so manual inspector testing and automated tests remain deterministic when needed.

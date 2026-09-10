# Known Issues

Living list of accepted limitations and sharp edges. Anything blocking a
milestone goes here before it goes to the backlog.

## Engine / gameplay

- **Water: no pressure or up-flow.** Water can never rise above its
  source level — u-tubes don't equalize, and a source floods exactly
  every reachable cell at or below its own level (place a source above
  a basin rim and the shore floods; that is the rule working, not a
  leak). Pressure is a deferred Phase 9 item.
- **Water is not raycast-targetable.** You edit through lakes (the
  ghost/placement path still allows placing _into_ water cells, which
  displaces them). Intended.
- **Flowing water equalizes in integer steps** (`diff >> 1` per cell
  pair when `diff ≥ 2`), so puddle surfaces can rest slightly uneven —
  a cellular look, accepted by design.
- **LOD1 water renders full cubes.** The flow-height query is not
  passed at distance, so partial levels render as full blocks; the
  surface drop only shows near the player.
- **Undo turns flowed water into sources.** A forward edit deletes the
  fluid's sparse level for that cell (the `onVoxelChanged` hook);
  undoing restores the WATER material, which reads as a source (255) —
  not the original partial level. Believable, but undo is not a
  fluid-state time machine. If unwanted later: capture levels in
  `EditCommand`.
- **Unloaded-chunk water writes fail silently.** Water waits at the
  streaming frontier until `onChunkReady` wakes it (tested). A source
  whose neighborhood is not loaded holds its level rather than leaking.
- **Terrain lakes wake once on generation.** Chunks carrying lake water
  churn briefly when they stream in, then sleep (sources against full
  cells settle in a tick; a failed frontier write re-activates nothing
  — regression-tested). No persistent per-frame cost.
- **Void fall.** Outrunning stream generation (or falling off
  steep unloaded edges) drops the player into the void; respawn at
  y < −32 recovers. A "freeze physics in unloaded chunks" guard is a
  cheap future fix if it annoys.
- **Stale meshes at the unload edge.** A meshed chunk can briefly keep
  faces built against a since-unloaded neighbor at the render edge
  (self-heals on remesh when revisited). Invisible in practice — those
  chunks are behind the player.
- **Instant-acceleration movement.** Horizontal velocity snaps to the
  wish direction; no acceleration/deceleration/air control yet. The
  plan's "deliberate feel" pass (§35) is intentionally deferred.
- **No step-up assist.** One-voxel ledges require jumping (by design —
  jump apex is tuned to ~1.08 voxel). Automatic step climb is a §35
  feature.
- **No sprint/crouch.** Listed for the full controller (§35).
- **Bedrock floor is protected.** The y = 0 layer cannot be removed or
  painted (prevents accidental world-floor holes); brushes, explosions,
  and cuts all skip it, and collapse never collects it.
- **Editing is brush-granular.** Since Phase 7 one stroke (brush, cut,
  paste, explosion, collapse) is one undoable command; hold-to-paint
  continuous strokes are still one command per click.

## Creator mode (Phase 7)

- **Selections are capped at 32³.** A corner pair defining a bigger box
  is refused (the click is a no-op) rather than truncated; the HUD keeps
  the previous selection.
- **Paste is non-solid by default.** Air cells inside a copied volume do
  not overwrite terrain on paste (pasting never gouges holes). Solid
  paste exists in the API but is not bound to a key.
- **Prefab load failure is silent-ish.** A corrupt prefab JSON logs a
  console warning and is skipped by the P-cycle; there is no HUD toast.
- **No gizmos.** Translate/rotate/snap gizmos from the Phase 7 checklist
  were deferred — first-person clipboard transforms (rotate/mirror keys)
  cover the common cases. Tracked for a later creator-mode pass.

## Destruction (Phase 8)

- **Support anchoring is a local approximation.** `checkSupport` scans a
  bounded region (edit bounds ±12, full height) and treats cells at the
  region's horizontal edge as grounded. Structures wider/taller than the
  scan region can be mis-judged: a cut-off top may collapse (believable),
  and a component touching the scan edge stays standing even if floating.
  The Phase 11 structural graph replaces this.
- **Support check cost is bounded but real.** Snapshot + flat-index BFS
  over the region: ~10 ms worst case for a fully-solid house-scale
  region (was 18.5 ms before the snapshot pass and the World chunk
  memo). It runs synchronously after destructive edits; a frame spike on
  huge edits is possible. Regions above 150k cells are skipped entirely
  (`checked: false`).
- **Debris is visual, not material.** Collapsed voxels become pooled
  InstancedMesh boxes that bounce, settle, and shrink away — they do not
  re-materialize as voxels where they land (undo is the restoration
  path). Debris pool: 512 pieces, ring-buffer recycling; dust: 1024.
- **Explosions vaporize water.** Water cells inside the blast are
  edited to air (no debris, not counted as destroyed); surrounding
  sources then re-flood the crater. Since Phase 10 the blast also dumps
  heat on flammable crater-rim survivors, so explosions can start fires.
- **No NPC reaction yet.** The explosion pipeline stops at edits +
  debris + dust + sound (+ fire since Phase 10); NPC reactions are
  Phase 12/13.
- **Collapse debris ignores the player.** Falling pieces don't push or
  damage the player; there is no physics body for the player-debris
  interaction (deliberately — believable first).
- **Sound is procedural WebAudio.** Thud/crack/boom are filtered-noise
  envelopes, not samples; the context starts on the first pointer-lock
  gesture and N mutes. No spatialization yet.

## Fire (Phase 10)

- **Fires do not survive save/load.** Burning cells and heat are
  transient sim state (the save format stays at v2); a reload starts
  with no active fire. The _consequences_ persist — burn-out holes are
  real journaled edits. If persistence is ever wanted: a v3 section
  mirroring `waterLevels`, plus a fire→v3 migration.
- **Burn-out does not trigger the support check.** A burned-through
  pillar leaves its roof floating until the next edit near it runs the
  check. Structural response to fire arrives with Phase 11's structural
  graph (replacing the edit-time support approximation), per plan.
- **No wind, no rain coupling.** The Phase 10 checklist items are
  deferred until a weather system exists (Phase 15/16); fire currently
  spreads isotropically via 6-neighbor heat.
- **Burning voxels keep their material look.** A burning wood block
  renders as wood; embers + smoke particles carry the fire reading. No
  emissive tint, no charring texture, no burn-spread decal yet.
- **Smoke is particle puffs, not volumetric.** Pooled instanced boxes
  with buoyancy and growth; volumetric ray-marched smoke stays a
  research item (plan §24).
- **No fire audio loop.** Ignition plays the procedural crack burst;
  there is no sustained crackle (audio system is Phase 17).
- **Oxygen is a 6-neighbor check, not a field.** A fully-enclosed
  burning cell smothers instantly (fuel survives); partially-enclosed
  spaces burn normally. Enough for believability; not an air-volume
  simulation.
- **Fire is creator-mode-only to start.** The ignite tool and the
  explosion (heat) path are creator gestures; there is no natural
  ignition (lightning, lava) yet.

## GUI verification (headless)

- **Automated browser runs have input races.** Under SwiftShader
  (~10 fps) Playwright can drop keydowns, and Ctrl-combos must be held
  across a game frame (the Session-003 caveat). `.verify/run.mjs`
  (gitignored, local) drives the game through the dev-only `__mw` hook
  with state-verified retries; manual playtesting does not hit these.
  The in-app Electron pane had no WebGL in this session's environment —
  verification used Playwright's bundled Chromium headless.

## Storage / meshing / LOD

- **Packed reads are ~4× dense.** Palette + bit unpacking costs reads
  (~0.25 ms per 4096 sequential reads vs ~0.06 ms dense) but meshing
  stays mesh-bound (greedy terrain chunk: 2.46 ms through packed vs
  3.15 ms naive through dense). Fine at the 3-chunks/frame budget;
  revisit if profiling says otherwise. See `docs/voxel-storage.md`.
- **LOD1 erodes up to one voxel.** The downsample's air-wins-ties rule
  guarantees LOD never adds terrain (the inflation bug from playtest),
  at the cost of shaving odd-height surface blocks. Correct-by-design;
  visible only as slightly lower distant silhouettes.
- **LOD1 seam culling is approximate.** The LOD boundary query reads
  one representative voxel of each neighboring 2³ block, so a rare
  culled face can leave a pinhole at chunk seams in LOD1 — far away,
  cosmetic, self-heals when the chunk returns to LOD0.
- **No worker meshing / transferable buffers.** Phase 6 checklist item
  deferred: greedy meshing is ~2.5 ms/chunk and the frame budget
  absorbs it; revisit when chunk size or radius grows.
- **Bundle size.** The three.js chunk exceeds Vite's 500 kB warning
  (~545 kB minified, ~140 kB gzipped). Harmless for a local demo;
  revisit if it ever matters (code-splitting or a WebGPU-only path).

## Rendering

- **Flat-shaded faces, no AO.** Lighting is hemisphere ambient + one sun
  with per-voxel variation; per-face ambient occlusion (the cheap
  winner for voxel readability) is deferred to Phase 16 polish.
- **Fog band.** Fog is tuned to the render radius; terrain silhouettes
  still pop in slightly at the edge when chunks finish streaming.
  Acceptable until meshing is fast enough for a bigger radius.

## Platform

- **exFAT is unsupported for development.** `npm install` fails on
  exFAT (no symlinks for `node_modules/.bin`). The repository now lives
  on ext4; see session logs in `MICRO_WORLD_PROGRESS.md` for history.
- **Pointer lock requires a user gesture** and can be denied by browser
  hardening (e.g. rapid re-lock after Esc). The overlay click handles
  the normal case.
- **Autosave saves the edit journal + seed only.** Terrain regeneration
  is part of the save contract; a future terrain-parameter change would
  alter regenerated ground under old saves (the material table and edits
  still load — the schema carries terrain params to make drift
  detectable).

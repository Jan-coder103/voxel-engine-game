# Known Issues

Living list of accepted limitations and sharp edges. Anything blocking a
milestone goes here before it goes to the backlog.

## Engine / gameplay

- **Water is a placeholder.** It renders translucently but has no
  collision or buoyancy — players walk on lake beds. Swimming/fluid
  simulation arrives in Phase 9. Water is also not targetable by the
  edit raycast (you edit through it, which is intended for now).
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
  painted (prevents accidental world-floor holes); everything above is
  fair game.
- **Editing is single-voxel.** Brushes/box tools are Phase 7; undo
  groups per click, not per stroke.

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

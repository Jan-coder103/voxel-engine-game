# Known Issues

Living list of accepted limitations and sharp edges. Anything blocking a
milestone goes here before it goes to the backlog.

## Engine / gameplay

- **Naive mesher, one draw call per chunk pass.** ~226 meshes at render
  radius 6 run fine; greedy meshing + cache improvements are Phase 6.
- **Water is a placeholder.** It renders translucently but has no
  collision or buoyancy — players walk on lake beds. Swimming/fluid
  simulation arrives in Phase 9.
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
- **No interaction raycast yet.** Lands with Phase 5 editing, its first
  real consumer.
- **No sprint/crouch.** Listed for the full controller (§35).

## Rendering

- **Flat-shaded faces, no AO.** Lighting is hemisphere ambient + one sun
  with per-voxel variation; per-face ambient occlusion (the cheap
  winner for voxel readability) is deferred to Phase 16 polish.
- **Fog band.** Fog is tuned to the render radius; terrain silhouettes
  still pop in slightly at the edge when chunks finish streaming.
  Acceptable until meshing is fast enough for a bigger radius.
- **Bundle size.** The three.js chunk exceeds Vite's 500 kB warning
  (~526 kB minified, ~133 kB gzipped). Harmless for a local demo;
  revisit if it ever matters (code-splitting or a WebGPU-only path).

## Platform

- **exFAT is unsupported for development.** `npm install` fails on
  exFAT (no symlinks for `node_modules/.bin`). The repository now lives
  on ext4; see session logs in `MICRO_WORLD_PROGRESS.md` for history.
- **Pointer lock requires a user gesture** and can be denied by browser
  hardening (e.g. rapid re-lock after Esc). The overlay click handles
  the normal case.

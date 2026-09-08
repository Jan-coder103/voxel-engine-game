# Known Issues

Living list of accepted limitations and sharp edges. Anything blocking a
milestone goes here before it goes to the backlog.

## Engine / gameplay

- **Naive mesher, one draw call per volume.** Fine at Phase 1 scale;
  greedy meshing + chunk caching scheduled for Phase 6 / Phase 2
  respectively.
- **Single-volume world.** The demo level is one 16³ `VoxelVolume`;
  walking off the edge drops you into the void (respawn at y < −32).
  Chunking (Phase 2) replaces this.
- **Instant-acceleration movement.** Horizontal velocity snaps to the
  wish direction; no acceleration/deceleration/air control yet. The
  plan's "deliberate feel" pass (§35) is intentionally deferred until
  after the world is chunked.
- **No step-up assist.** One-voxel ledges require jumping (by design —
  jump apex is tuned to ~1.08 voxel). Automatic step climb is a §35
  feature.
- **No interaction raycast yet.** The Phase 1 checklist item lands with
  Phase 5 editing, which is its first real consumer.
- **No sprint/crouch.** Listed for the full controller (§35), not
  needed for the Phase 1 milestone.

## Rendering

- **Vertical faces read dark.** Lighting is a hemisphere + single sun;
  faces away from the sun get only ambient bounce. Cheap fix (fill
  light or per-face AO) deferred to Phase 16 polish.
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

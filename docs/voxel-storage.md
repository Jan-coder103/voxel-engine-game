# Voxel Storage — Representations Considered

Phase 6 outcome. Candidate representations for chunk voxel data, with the
measurements behind the decisions. All numbers: Node 22, Linux x64,
2026-09-09 (`npm run bench`, `benchmarks/storage.bench.ts`), 16³ volumes
with terrain-like content (stone core, grass/sand caps, water fill).

## Adopted: palette compression + occupancy bitsets (`PackedVolume`)

Each chunk stores:

- a **palette**: the distinct materials actually present (`Uint16Array`),
- **bit-packed palette indices** in a `Uint32Array` (1/2/4/8 bits per
  voxel, no word straddling — 32/16/8/4 voxels per word),
- an **occupancy bitset** (1 bit per voxel, plus a running count) so
  reads of air and "is this volume empty" are O(1) without touching the
  packed payload.

The palette widens automatically (1→2→4 bits) as materials appear and
throws past 256 distinct materials (16³ terrain uses 3–5; the envelope
is deliberate — see "Dense fallback" below).

| Metric (16³ chunk)           | Dense `Uint16Array` | Packed (4-bit) |
| ---------------------------- | ------------------- | -------------- |
| Payload memory               | 8192 B              | 2048 B         |
| + occupancy grid             | —                   | 512 B          |
| Typical terrain chunk (real) | 8192 B              | 1536 B         |
| Fill, terrain-like content   | 0.078 ms            | 0.275 ms       |
| Sequential read ×4096        | 0.061 ms            | 0.252 ms       |
| Random mixed ops ×4096       | 0.061 ms            | 0.252 ms       |
| Greedy mesh through it       | —                   | 2.46 ms/chunk  |

Reading the numbers: packed reads cost ~4× dense (bit extract +
palette indirection). That is acceptable because the frame is mesh-bound,
not read-bound — the end-to-end greedy mesh of a terrain chunk through
`PackedVolume` (2.46 ms) is still faster than the naive mesher ever was
(3.15 ms through dense), and the streaming budget is 3 chunks/frame.
Memory wins ~5.3× on real terrain; at 226 loaded chunks that is
1.8 MB → 0.35 MB, and the win compounds with any future resolution or
radius increase (the actual goal of Phase 6).

Adoption: `Chunk.volume` is a `PackedVolume`; `VoxelVolume` (dense) stays
as the correctness baseline, the LOD path, and the escape hatch. Both
satisfy the `VoxelData` interface, so nothing above storage can tell.

## Investigated, not adopted (yet)

- **Sparse per-voxel hash (Map per chunk).** Only wins when fill rates
  are very low. Measured terrain chunks are 40–90% filled and even "air"
  chunks near sea level have water columns; a hash entry costs ~50 B vs
  0.25 B/voxel packed. The occupancy grid already gives the cheap
  all-air answer (`isEmpty`) that sparse storage was meant to optimize.
  Revisit if large volumes of genuinely empty space appear (deep
  underworlds, huge air boxes).
- **RLE per column/layer.** Terrain columns compress well (long
  material runs), but RLE decodes randomly-accessed voxels to O(run)
  and edits to O(layer); palette-packed indices keep O(1) random
  access at comparable size for our content. RLE remains interesting
  as a _save-format_ codec (the journal is already sparse; bulk chunk
  snapshots are not needed yet).
- **Sparse Voxel DAG/SVO.** Pointer/node overhead wins only at high
  resolution with large homogeneous regions (think 256³+ microvoxel
  chunks). At 16³ the node table would dwarf the payload (a full 16³
  packed chunk is 2.5 KB). Revisit together with any real voxel-size
  reduction (Phase 6's original "microvoxels" goal): the natural
  checkpoint is when a chunk edge goes to 32+ voxels.
- **Dense fallback above 256 materials.** `PackedVolume` refuses to
  grow past an 8-bit palette; a chunk that somehow holds more distinct
  materials should be rebuilt as dense `VoxelVolume` by its owner.
  Nothing in the current material registry (7 materials) comes close.

## Decision log

- 2026-09-09 — adopt palette + occupancy as chunk storage (ADR-006 in
  spirit: "storage is behind `VoxelData`; representations are
  interchangeable"). Dense remains the reference implementation for
  tests and benchmarks.

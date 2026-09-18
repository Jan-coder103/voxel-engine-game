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

- **Structural anchoring is still a local approximation (now by
  design).** The Phase 11 analysis scans ±12 cells horizontally around
  the disturbance (full height) and treats solid cells at the region's
  horizontal edge as grounded: a component touching the scan edge stays
  standing even if truly floating. Structures wider than ~24 voxels
  across a disturbance can be mis-judged at the fringes. (Phase 11's
  cantilever/stress model replaced the Phase 8 flood fill; see the
  Structures section below.)
- **Debris is visual, not material.** Collapsed voxels become pooled
  InstancedMesh boxes that bounce, settle, and shrink away — they do not
  re-materialize as voxels where they land (undo is the restoration
  path). Debris pool: 512 pieces, ring-buffer recycling; dust: 1024.
- **Explosions vaporize water.** Water cells inside the blast are
  edited to air (no debris, not counted as destroyed); surrounding
  sources then re-flood the crater. Since Phase 10 the blast also dumps
  heat on flammable crater-rim survivors, so explosions can start fires.
- **NPCs take blast damage with caveats.** Since Phase 13 the explosion
  event also hurts figures (distance falloff, lethal in the crater's
  inner half, quarter damage behind walls) and scares them into
  fleeing. There is no shrapnel/physics, no player damage from collapse
  debris, and wounded figures do not regenerate (see the NPCs section).
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
- **Burn-out triggers structural analysis.** Since Phase 11 a
  burned-through pillar drops its roof (the collapse is undoable, the
  burn-out holes are journaled). Resolved — listed here because older
  session notes say otherwise.
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

## Structures (Phase 11)

- **No lateral load distribution.** Stress is vertical stack load only:
  a wide roof's weight does not pile onto its pillars (each column
  carries just its own stack), so spanning structures are held or
  dropped purely by the cantilever rule, not by load math. A real
  "slab overload" model needs support-share distribution — a later
  pass if the feel demands it.
- **Cantilever support is a tuned constant** (`MAX_CANTILEVER = 6`
  groundless hops). Rooms up to ~12 voxels across hold their floors
  from the walls; longer spans need a mid pier or drop when disturbed.
  This replaces Minecraft's "everything floats forever" with something
  stricter — building a 20-plank bridge out from a shore will drop its
  far half on the next nearby disturbance.
- **Placements never trigger structural analysis.** Only removals
  (tools, explosions, collapse, fire burn-out) queue regions: building
  stays Minecraft-style free, floating builds stand until something is
  disturbed nearby, and undoing a collapse re-materializes the roof
  without a re-check. Deliberate trade — otherwise mid-build bridges
  would collapse under the builder.
- **Stress exempts natural terrain.** Only cells with journaled edits
  can fracture under load (a generator-written 30-tall stone cliff is
  "at rest"); load still counts all overlying mass, so propping up
  terrain with wood posts fails believably. Quirk: a cell you merely
  painted counts as "disturbed" and can then fracture.
- **Collapse caps.** One analysis removes at most 4096 cells
  (`MAX_COLLAPSE_CELLS`); bigger failures truncate and finish via the
  cascade (next ticks). Regions above 150k cells skip analysis
  entirely. Pending regions fold into one box past 32 entries (then
  likely exceed the scan budget and skip — same graceful degradation
  as before).
- **Detached pieces go through the debris pipeline**, not a rigid-body
  engine: pooled visual chunks with gravity/bounce (Rapier stays
  deferred, per the Phase 8 note). Collapsed cells do not re-materialize
  where they land; undo is the restoration path.
- **Structural analyses cost a few ms each** (house-scale ≈ 2 ms on the
  dev VM; see `docs/performance.md`) and run at most one per fixed step
  — a large multi-stage collapse spreads across ticks by design.

## NPCs (Phases 12–13)

- **Vision is a 130° horizontal cone with binary range** (24 cells) and
  DDA occlusion: no peripheral gradients, no light level (figures see
  at night), no motion detection. Sleepers "see" nothing — they wake
  only for threats within 5 cells or blast panic.
- **Hearing is a radius check, not propagation**: every figure inside
  the event's hear radius perceives it fully; walls do not muffle
  sound, and there is no delay (a blast at 40 cells is heard the same
  tick it happens).
- **Fear is a single scalar** with one threshold (`PANIC_THRESHOLD`
  50): no per-threat memories, no personality beyond hash-gated
  curiosity, no herd behavior (nearby panicked figures do not alarm
  each other), and no exhaustion from fleeing.
- **Explosion damage is a radius falloff with a quarter-through-wall
  factor** — no shrapnel, no fall/impact damage, no debris hits.
  Health does not regenerate; a wounded figure stays wounded until it
  despawns (population is transient anyway).
- **Flood response is proximity only**: water at/beside the feet scares
  figures off, but they do not avoid a rising lake in their path
  beyond the normal re-path (nav treats water as impassable), and
  drowned figures are simply despawned ("swept away") — no corpse, no
  `npcDied` viz beyond the bus event.
- **Investigation is a single stop-short anchor**: figures path to
  within ~4 cells of a heard site, look for a moment, then resume.
  They do not coordinate, report, or remember the site after the
  threat memory expires (≤ 600 ticks).
- **Grid-following movement, not physics**: figures glide between cell
  centers at a fixed speed with vertical easing. They cannot jump,
  climb more than one block per step, or path drops deeper than
  `MAX_DROP` (3). During the easing band a figure visually overlaps
  the block it is climbing — cosmetic, not a support violation. Fleeing
  figures run 1.6× speed but still cannot jump gaps.
- **The schedule clock is not the world clock**: a tick counter (40 s
  per game day) drives bed/work hours; there is no sun, no lighting
  change, no weather coupling. Phase 15/16 (atmosphere) should replace
  the counter's role with the real day/night cycle.
- **Needs are half-wired**: sleep gates behavior (bedtime + exhaustion
  both work); hunger rises and is read in tests/debug only — there is
  no food to eat and no consequence yet.
- **Population is transient**: NPCs are not in the save format
  (deliberate — they respawn deterministically around the player, and
  a reload repopulates identically). Home/work anchors are picked at
  spawn from nearby walkable cells, not from town data — there are no
  buildings to assign yet (Phase 14).
- **No figure-figure collision**: NPCs can overlap each other (and the
  player). Believable at population 16; revisit with the 200-NPC
  benchmark (Phase 25+).
- **NPCs avoid water entirely** — the nav query marks water cells not
  open, so lakes are walls. Wading/swimming for NPCs is unmodeled.
- **Sealed-in figures idle**: an unreachable home (walled in) ends the
  decision in a long idle wait and retry, not path-finding around the
  obstacle; the A\* budget (512 expansions) caps the wasted work at
  ~5 ms per attempt. A panicking figure with no valid flee target falls
  back to its home anchor, then cowers in place.

## Town (Phase 14)

- **Generated buildings are stress-exempt.** The structural sim only
  stress-fractures cells with journaled edits, and town buildings come
  from the generator — a player-built tower on a house roof will not
  fracture the house's walls until those cells are edited. Lost-support
  collapse still applies in full: burn or blast a load-bearing wall
  (or a bridge post) and the roof/deck it carried comes down.
- **Glass is a solid pale pane.** It culls faces and renders opaque —
  no transmission, reflections, or crack states yet (plan §29/§31).
- **Windows don't open and doors aren't doors.** A "door" is a 2-cell
  opening in the wall; there is no door entity, hinge, lock, or glass
  pane geometry — Phase 15/16 territory (machines, states).
- **Pads are concrete, interiors are sparse.** Lot leveling fills a
  foundation and cuts hills; furniture is a few blocks. No appliances,
  wiring, or plumbing inside buildings until the utilities phase — the
  "utility generation" checklist item is deliberately deferred there.
- **Roads are cosmetic + walkable, not a traffic graph.** No lanes,
  path nodes, or vehicles yet (Phase 14 traffic is plan §46, later).
- **NPC home/work anchors are position-only.** Anchors are validated
  for walkability when a figure picks one; a door can be dynamically
  blocked later (a walled-in house idles its resident, as before). Far
  from town the ring fallback resumes — figures met in the wilderness
  have hash homes, not doorsteps.
- **Two-story interiors have stairwell fall-through**: the slab
  openings above the top steps are 1-cell holes; a figure upstairs can
  path around them, a player can fall through them (believable, not
  guarded).

## Utilities (Phase 15)

- **No voltage, current, or resistance.** The power model is component
  membership + aggregate supply/demand: a generator lights up to
  `capacityPerGenerator` (1024) consumers, overload browns out lamps
  farthest from the plant in BFS order. No transformers, switches,
  batteries, or wire loss (plan §47 items deferred until a reason
  exists — there is no economy or machine set to feed).
- **Generators need no fuel and never wear out.** One intact block
  pair powers the whole town indefinitely; no economy exists to buy
  fuel for. Destroying both blocks orphans the grid instantly.
- **Pumps are self-powered.** A diesel pump by the lake pressurizes
  its whole pipe network with no wire in sight — the power→plumbing
  coupling (pump stalls in a blackout) is an obvious next step but
  kept out of this phase to keep the two systems independently
  testable.
- **Lamps don't illuminate anything.** Lit lamps get a warm glow shell
  (`powerViz`); the voxel shader has no point lights, so a lit street
  is no brighter than a dark one at night. Real lamp lighting needs the
  Phase 17 lighting pass (or a voxel light field, Phase 16+).
- **Leaks are refills, not jets.** A broken main re-fills its hole
  every `POUR_PERIOD` ticks with a small flowing level — the hole
  puddles rather than spraying, and a pipe broken while underwater or
  buried in solid ground stays dry until exposed. No pressure drop,
  flow rate, valves, drains, or sewer network (plan §48/§22 deferred;
  the §22 room-flooding chain works through the plain fluid sim).
- **The town grid is mesh-redundant.** Every road line crosses every
  other, so a single cable cut disconnects nothing — blackouts need a
  severed plant or a full line. Believable (real street grids have
  redundancy) but it means the "one shovel strike → dark street"
  fantasy needs the plant or a trench.
- **Utility states are transient.** The lit set and pressurized/leak
  sets rebuild from voxels on load (chunk scans + `rescan`); the save
  stores the blocks and the poured water (journaled), not the network
  state. A save mid-leak resumes leaking after the load.
- **Lampposts and standpipes are obstacles.** Poles occupy the road
  center column (NPCs path around; the two side lanes stay open) and
  the water main's riser blocks one lane cell. A pole cut at its base
  topples into the structural sim like any unsupported column.

## Atmosphere (Phase 16)

- **~~No voxel light field yet — lamps still don't illuminate.~~**
  Superseded in Phase 17: the light field landed and lit lamps cast real
  block light (see "Lighting (Phase 17)"). Night is still
  palette-ambient + moonlight outside lamp/fire reach, and NPC night
  sight keeps using the daylight proxy rather than sampling the field.
- **Rain does not accumulate.** Precip interacts with fire (wetting/
  dousing) but not with the fluid sim — no puddles, no rising lakes, no
  snow cover. The Phase 9 coupling (rain → `pour` at the surface) is
  deferred; the rain/snow particles are visual-only.
- **No wind→fire coupling.** The weather profile carries a wind vector
  (the clouds scroll with it, rain slants) but fire still spreads
  isotropically; wind-driven fire fronts are a later coupling.
- **Lightning fires usually self-extinguish.** A strike force-ignites
  the top cell, but while the storm's rain keeps falling the wetting
  out-races fuel burn-down, so storm fires typically douse in cause
  `'rain'` before spreading. The storm→fire→collapse chain exists but
  is rare by design; `forceWeather('clear')` + `strike()` is the
  reliable scenario path.
- **Seasons are sun/temp/color only.** No snow accumulation, no
  vegetation change, no seasonal fire risk — the season blends the sun
  arc, daylight fraction, and a °C-proxy temperature (which nothing
  consumes yet beyond the HUD-adjacent snapshot).
- **`forceWeather` breaks (seed, tick) purity until reset.** The debug
  override installs a synthetic segment; worlds resumed from a save
  taken mid-override continue the override chain (weather is transient
  and not saved, so a page reload is the clean reset).
- **Sky colors are palette lerps, not scattering.** Dawn/noon/dusk/night
  bands hand-tuned against hex targets; no Rayleigh/Mie model, no
  tonemapping interaction (the legacy renderer path is unlit custom
  shaders end to end).
- **Clouds are 2D fbm on a dome.** No volume, no cloud shadows, no
  coverage-dependent light dimming on the ground (the palette's
  `darkness` dims ambient only). Star field is hash noise, not a
  celestial map.
- **Temperature is a scalar proxy.** One global value per tick (season
  blend × daylight); no per-region climate, altitude lapse, or heat
  coupling to the fire sim's temperature accumulator.

## Lighting (Phase 17)

- **Light trails fire with a visible lag.** Burning cells become block
  sources through main's count-gated resync, and the BFS drains under a
  1200-pop/tick budget — a fast-spreading fire's light front lags a
  second or two behind the flames (SwiftShader: several). The HUD's
  `light qN` shows the backlog; a cell whose fire died before the BFS
  arrives self-corrects (the source map is re-read per pop).
- **Vertex AO is per quad corner, not per voxel.** A merged quad
  samples AO at its four corner cells, so interior AO variation across
  a wide quad (e.g. a long wall with a mid-pillar) is approximated by
  the corner values. The classic quad-diagonal flip (fixes anisotropy
  artifacts on corner gradients) is not implemented either.
- **Light is flat per face.** The merge signature carries one
  (sky, block) pair per face (sampled at the air cell it looks into) —
  no smooth per-vertex light interpolation, so large lit/dark
  boundaries are crisp rather than gradient-soft. AO supplies the soft
  corners.
- **Lamps are always on while powered.** The power sim has no time
  awareness — the town grid lights lamps day and night, so daytime
  lamp light pools (and glow shells) coexist with sunshine. A
  day/night switch on the grid is a power-sim feature, not a lighting
  one.
- **Leaves and glass are the only interesting transparencies.** Glass
  passes light at cost 1 (windows light interiors); water at 2 (pools
  dim with depth); leaves block (tree shade). There is no partial
  opacity for any other material, and light ignores fluid _flow_
  (flowing water attenuates like a source block).
- **Uninitialized chunks read as full sky.** The mesher default keeps
  streaming from rendering black, but a chunk whose columns are all
  cave (never open to the sky) renders bright for the ticks before its
  light initializes. Chunk init is synchronous with generation, so the
  window is only the BFS settle time.
- **No NPC/coupling consumers yet.** NPC night sight still uses the
  atmosphere daylight proxy (not the local field), fire's rain wetting
  still uses its own sky scan (not sky light), and the inspector shows
  no light values — all cheap follow-ups now that the field exists.
- **Save format untouched.** Light is derived state like the utility
  networks: loads `reset()` + `rescan()` the field and re-sync lamp and
  fire sources from the sims.

## Scenarios (Phase 18)

- **Session 014 probe findings — all three resolved (Session 015).**
  (1) **Rescue failed "the figure survives"**: root cause was target
  selection, not the victim — `pickNearest` compared stringified
  `"distance,x,z"` keys, so `"100,…"` sorted before `"8,…"` and the
  scenario staged on a house ~100 cells from spawn, _outside_ the
  NPCs' 80-cell despawn radius; `maintain()` silently distance-despawned
  the victim on tick 1 (insta-fail at `t=1`, no `npcDied` event).
  Selection is positional now (`scenarioTarget` = first suitable entry
  in array order, which also makes the rotation contract real). (2)
  **Fire failed "keep it off the neighbors"**: staging, not difficulty —
  `findFlammable` scanned the outer box, whose y-courses reach the grass
  apron, so the "house fire" ignited the _lawn_ (≈1 cell/tick across
  open grass; neighbor-box hits within ~10 ticks — unwinnable by
  construction). Setup now ignites the building body (footprint, floor
  up), and the neighbor guard watches neighbor _bodies_ rather than
  boxes that reach lawn level: verified winnable with a 4 s human-ish
  reaction delay. (3) **Demolition found no ready candidate**: a
  casualty of the same two bugs (wrong target, uncontained lawn fire) —
  with containment it starts and completes. All five scenarios verified
  end to end live, zero page errors.
- **Lawn fire spread is real and fast.** Grass carries fire at roughly
  a cell per tick; the fire/demolition guards now tolerate scorched
  lawns (they gate on neighbor _structures_ only), but an unattended
  blaze still cascades block-wide eventually (the plan §57 fire-ecology
  chain, arriving early). Slowing grass is a Phase 10 tuning question.
- **Scenario tuning is SwiftShader-relative.** Deadlines and hint
  ticks are calibrated against this VM's ~0.5× sim rate; they will
  need re-tuning on real hardware.
- **Conditions read unloaded chunks as air.** Box censuses and event
  geometry only see loaded chunks; main force-loads the stage at
  start, but a player who runs far away can blind a guard until the
  chunks stream back.
- **Guards are event-driven, not physical.** "Neighbors standing",
  "nobody hurt" and "keep water off the plant" trust `GameEvent`
  emissions and box censuses rather than tracking every cell; a player
  who deletes a neighbor by hand pickaxe stays under the demolition
  guard (the level-objective's collapse requirement is the real gate).
- **One scenario at a time, transient.** Starting a new scenario
  abandons the current run (its staged damage persists via the
  journal); there is no scenario save/restore, and `L` (load) stops
  the run.
- **No scenario UI beyond the HUD line.** Objectives render as one
  HUD line (`SCEN … [x]/[!]/[ ]` plus the latest announcement); a
  proper panel, scenario selection menu, and scoring are deferred.

## Scripting (Phase 19)

- **Programmatic surface only.** Scripts load through the
  `__mw.scripts` hook (or any code holding the engine); there is no
  in-game console, text format, or node UI yet — the plan §65 visual
  logic board is explicitly future work.
- **Variables are numbers only.** The shared store maps names to
  numbers (deterministic, save-free); scripts that need strings or
  structure encode them client-side.
- **Event triggers are fire-and-forget.** A false `if` gate swallows
  the triggering event (events are instantaneous); rules that must
  re-check later belong on `when` (rising edge). There is no event
  queue or retry.
- **Script announcements ride the scenario note channel**, which the
  HUD currently shows only while a scenario runs; a script-only run
  announces invisibly (the notes array still records it).
- **Scripts are not saved.** They are creator logic, not world state:
  `L` (load) does not stop them and they do not persist across page
  reloads; their world effects persist via the edit journal as usual.
- **Timer/unload asymmetry.** Unloading a script does not cancel the
  timers it created (engine-level by design); scripts must keep and
  cancel handles themselves.

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

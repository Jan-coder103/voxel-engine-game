# MICRO//WORLD — Detailed Game Development Plan

## 1. Project Vision

**MICRO//WORLD** is an experimental browser-based voxel simulation engine and sandbox built around extremely high-resolution editable environments.

The goal is not to reproduce a traditional voxel game, but to explore how much physical, procedural, interactive, and visual complexity can be simulated and rendered in real time using TypeScript, Three.js, and WebGPU.

### Core pillars

1. **Matter** — Everything is made from or interacts with material.
2. **Simulation** — Systems affect one another and produce emergent behavior.
3. **Creation** — The player can modify and construct the world.

### North-star experience

The player should not need to know where the abstraction boundaries are. They should experience consequences naturally:

- Break a pipe → water floods a basement.
- Flood electrical equipment → power fails.
- Remove structural support → a roof collapses.
- Start a fire → smoke, heat, NPC reactions, and structural damage follow.
- Redirect a river → terrain and downstream areas change.
- Cut power → lights go out and NPC behavior changes.

### Non-goals (explicit)

To protect the scope, the following are **out of scope for the first three months**:

- Multiplayer / networking
- Mobile / touch support
- Mobile-level hardware targets (desktop only)
- VR
- Modding API beyond the scripting layer
- Shipping a "game" with progression, progression UI, or monetization
- Engineering-accurate structural or fluid simulation — believable always wins over correct

---

## 2. Core Concept

Imagine a detailed coastal/industrial town containing:

- Roads
- Houses
- Apartments
- Shops
- Warehouses
- Construction sites
- Factories
- Bridges
- Rivers
- Forests
- Underground drainage
- Pipes
- Electrical infrastructure
- Furniture
- Vegetation
- Cars
- NPCs
- Animals
- Water
- Soil
- Concrete
- Glass
- Wood
- Metal

The world is built around very small logical voxels, potentially in the 2–5 cm range, but not every voxel is necessarily rendered as an individual cube.

The central technical challenge is to represent and simulate enormous numbers of logical voxels efficiently.

### Reality check: the raw numbers

Before designing anything, internalize the scale problem. At 2 cm resolution:

```text
1 m³          = 125,000 logical voxels
A house       ≈ 10 × 10 × 6 m   ≈ 75M voxels of space
A 500 m town  ≈ 500 × 500 × 50 m ≈ 390 G voxels of space
```

Three consequences drive every decision in this document:

1. **Dense storage is impossible at full scale.** Even at 1 byte per voxel, a town is ~400 GB. Only a tiny active working set can be dense; everything else must be procedurally regenerable or aggressively compressed.
2. **Only a small fraction is ever visible.** Interior voxels of a wall never need to exist until exposed by destruction. Lazy materialization ("shell now, interior on damage") is a core strategy, not an optimization.
3. **The world must be seed-generatable.** The save format should store _edits relative to procedural generation_ (delta encoding), not the world itself. This is the single most important architectural constraint for the 1 km² target.

### Risk register

| Risk                                                   | Likelihood | Impact | Mitigation                                                                                                   |
| ------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Microvoxel performance targets unreachable in browsers | High       | Fatal  | Prove the core loop early (Phase 6 is the go/no-go gate); design LOD so the game is still good at 8 cm       |
| Scope explosion (every system is a full project)       | High       | High   | Strict phase exit criteria; every system ships in a "believable, not accurate" version first                 |
| Structural/physics simulation too slow or unstable     | Medium     | High   | Graph-based approximation (Section 26), rigid bodies only for detached debris, hard caps on active fragments |
| Fluid/fire coupling explodes into unbounded work       | Medium     | High   | Simulation distance rings (Section 6) + activity budgets: only N active fire/fluid cells simulated per frame |
| WebGPU adoption/compatibility                          | Medium     | Medium | WebGL2 fallback path kept alive through Month 1, feature-detected at runtime                                 |
| Determinism drift breaks replay/saves                  | Medium     | Medium | Fixed-point or careful float usage in sim systems; determinism tests from Phase 1                            |
| Editor UX never becomes usable                         | Medium     | Medium | Creator mode gets a milestone demo (Phase 7) with a scripted task a stranger can complete                    |

### Performance budgets (target machine: mid-range desktop, 2024+)

The frame budget at 60 FPS is **16.6 ms**. Assign budgets up front so systems don't silently steal from each other:

```text
GPU total          10 ms
  geometry          5 ms
  shadows           2 ms
  postprocess       2 ms
  particles/fluids  1 ms

CPU (main thread)   4 ms
  input/UI/camera   1 ms
  scene submission  2 ms
  spare             1 ms

Workers          (parallel)
  voxel sim, meshing, AI, worldgen — must never touch the main thread
  mesh upload budget: ≤ 2 chunk remeshes uploaded per frame
```

Rules:

- Any system that exceeds its budget gets a lower-quality mode, not an exception.
- Measure from Phase 1 onward; the in-game profiler (Section 84) is a Month 1 deliverable, not a late addition.

---

## 3. Fundamental Architecture

Do not create one Three.js mesh per voxel.

Use a hierarchy:

```text
WORLD
│
├── Regions
│   └── Chunks
│       └── Voxel storage
│
├── Structures
├── Objects
├── Fluids
├── Vegetation
├── Characters
└── Simulation
```

### Chunk size must be defined in world space, not voxels

A fixed voxel-count chunk breaks at microvoxel resolution: a 32³ chunk at 2 cm per voxel is only **64 cm wide** — a single house would span hundreds of chunks, and chunk-management overhead would dominate. Instead, define chunks by **world-space extent** and let the voxel count per chunk follow from the current LOD:

```text
Chunk world size:  4 m  (fixed)
LOD 0 (2 cm):      200³ voxels per chunk   = 8M voxels — too many for dense storage
LOD 1 (4 cm):      100³ voxels per chunk
LOD 2 (8 cm):       50³ voxels per chunk
```

Even at LOD 0 a dense 4 m chunk is impractical (8M voxels × 2 bytes = 16 MB). The practical resolution is therefore:

- **Store densely only what is occupied.** Real interiors are mostly air and single-material runs; palette + RLE/sparse structures keep a typical 4 m chunk in the tens of KB.
- **Start development at 8 cm voxels with 32³ chunks** (a 2.56 m chunk) and only step down to 2 cm once sparse storage, greedy meshing, and LOD streaming are proven. 2 cm is a _target_, not a starting point.
- Keep chunk world size constant across LODs so chunk coordinates never change when detail changes.

Example:

```ts
interface VoxelChunk {
  coord: ChunkCoord;
  size: number;
  voxels: Uint16Array;
  palette: MaterialID[];
  dirty: boolean;
  meshDirty: boolean;
  physicsDirty: boolean;
  fluidDirty: boolean;
  lightingDirty: boolean;
}
```

---

## 4. Multiple Voxel Representations

### Dense representation

Use typed arrays for heavily occupied chunks:

```text
Uint16Array
```

Material IDs point into a chunk-local palette.

### Palette compression

Example:

```text
0 = air
1 = concrete
2 = steel
3 = glass
```

The voxel array stores compact IDs.

### Sparse representation

For large worlds, investigate:

- Sparse voxel octrees
- Occupancy bitsets
- Sparse bricks
- Hierarchical grids
- DAG-like compression

### Research/benchmark track

Implement and compare (canonical list maintained in Section "Research Tracks" near the end — avoid duplicating it here as it evolves):

- Dense grid vs palette-compressed vs RLE vs sparse chunks vs SVO

Measure memory, access speed, editing speed, and meshing speed. **Pick one winner per role by end of Month 1** — the comparison is a means, not a deliverable. A known trap: SVOs and DAG compression look great on paper but make random-access editing and remeshing slow. Prioritize edit latency over compression ratio.

---

## 5. World Coordinates and Chunking

Use a clear conversion pipeline:

```text
world coordinate
      ↓
chunk coordinate
      ↓
local voxel coordinate
```

Support negative coordinates correctly.

Create tests for:

- Positive coordinates
- Negative coordinates
- Chunk boundaries
- Exact boundary positions
- Large coordinates
- Round trips between coordinate systems

---

## 6. Chunk Streaming

Separate these concepts:

- View distance
- Simulation distance
- Physics distance
- AI distance
- Detail distance

Example:

```text
0–40 m
    Full simulation
    Full geometry
    NPC AI
    Fluids
    Destruction

40–100 m
    Simplified simulation
    Normal geometry

100–300 m
    Visual-only representation

300 m+
    Terrain/impostors
```

Implement predictive streaming based on:

- Player position
- Camera direction
- Player velocity
- Simulation importance

Use LRU-style memory eviction.

---

## 7. Level of Detail

Microvoxels do not need identical resolution at every distance.

Possible hierarchy:

```text
LOD 0 = 2 cm
LOD 1 = 4 cm
LOD 2 = 8 cm
LOD 3 = 16 cm
LOD 4 = 32 cm
LOD 5 = 64 cm
```

Eventually investigate:

- Hierarchical voxel representations
- LOD transition geometry
- Transvoxel-like transitions
- Sparse representations

---

## 8. Meshing

Start with naive face meshing:

```text
for each voxel:
    if neighbor == air:
        create face
```

Then implement:

### Greedy meshing

Merge adjacent coplanar faces.

### Other experimental meshers

Implement and compare:

- Greedy meshing
- Marching cubes
- Surface nets
- Dual contouring
- Hybrid block/smooth terrain meshing

Benchmark:

- Mesh generation time
- Triangle count
- Memory
- Visual quality
- Edit/remesh latency

---

## 9. Hybrid World Representation

Not everything should be voxelized.

Recommended:

```text
WORLD
│
├── Voxel Terrain
├── Voxel Structures
├── Conventional Mesh Props
├── Rigid Bodies
├── Particles
├── Fluids
├── NPCs
└── Vehicles
```

Use conventional meshes for objects where voxelization offers little benefit.

Use voxels where destructibility/editability matters.

---

## 10. Material System

Create a material registry.

```ts
interface VoxelMaterial {
  id: number;
  name: string;

  density: number;
  hardness: number;
  friction: number;
  restitution: number;

  thermalConductivity: number;
  ignitionTemperature: number;
  flammability: number;

  waterPermeability: number;
  absorption: number;

  roughness: number;
  metallic: number;
  baseColor: Color;
}
```

Initial materials:

- Air
- Dirt
- Grass
- Stone
- Sand
- Gravel
- Concrete
- Brick
- Wood
- Steel
- Glass
- Water
- Mud
- Snow

Later:

- Clay
- Asphalt
- Copper
- Iron
- Coal
- Moss
- Ice
- Organic matter
- Various concrete/wood/metal variants

---

## 11. Damage System

Track more than a single health value where useful:

- Compression
- Tension
- Shear
- Impact
- Heat
- Fracture
- Fatigue

Possible state:

```text
healthy
cracked
damaged
structurally compromised
fractured
collapsed
```

---

## 12. Destruction Pipeline

A destruction event should flow through multiple systems:

```text
Raycast / Tool
      ↓
Impact location
      ↓
Damage field
      ↓
Affected voxels
      ↓
Material response
      ↓
Fracture
      ↓
Chunk update
      ↓
Structural analysis
      ↓
Debris
      ↓
Physics
      ↓
Dust / particles
      ↓
Sound
      ↓
AI reaction
```

---

## 13. Destruction Tools

Creator mode tools:

- Pickaxe
- Single voxel removal
- Sphere delete
- Box delete
- Cylinder delete
- Plane cut
- Boolean subtract
- Noise brush
- Erosion brush
- Paint brush
- Material replacement
- Damage brush
- Explosion
- Fracture tool
- Smooth
- Flatten
- Raise terrain
- Lower terrain
- Copy
- Paste
- Rotate
- Mirror

---

## 14. Creator Mode

Creator mode should feel like:

**Minecraft + lightweight Unreal/Blender tooling**, specialized for microvoxels.

Possible HUD:

```text
MICRO//WORLD

[Tools]                     [Inspector]

                    WORLD

[Materials / Brush / Prefabs]
```

Controls:

```text
LMB  = primary action
RMB  = alternate action
MMB  = sample
SHIFT = precision
CTRL = snap
ALT = inverse
```

Add:

- Selection
- Gizmos
- Transform tools
- Voxel brushes
- Material painting
- Copy/paste
- Prefabs
- Blueprints
- Inspector
- Hierarchy
- Scripting

---

## 15. Undo / Redo

Do not snapshot the whole world for every edit.

Use command objects:

```ts
interface EditCommand {
  apply(world): void;
  undo(world): void;
}
```

Examples:

- VoxelEditCommand
- TerrainBrushCommand
- PasteCommand
- DeleteCommand
- EntityMoveCommand
- MaterialPaintCommand

Support:

- Undo
- Redo
- Command serialization
- Grouped edits
- Transactional operations

---

## 16. Clipboard / Copy-Paste

Define:

```ts
interface VoxelClipboard {
  dimensions;
  voxels;
  materials;
  entities;
  metadata;
}
```

Support:

- Copy
- Paste
- Rotate
- Mirror
- Material remapping
- Relative placement
- Blueprint conversion

---

## 17. World Serialization

Create a custom world format, for example:

```text
world.mw
```

Potential structure:

```text
metadata
 ├── world settings
 ├── seed
 ├── time
 ├── weather
 └── version

regions
entities
scripts
```

Decision (not optional): **the save format stores procedural parameters plus a delta of player edits**, never raw voxel dumps of generated terrain. A save should ideally be `seed + settings + edit log`, replayed through the world generator on load. Only fully hand-built creator-mode regions (which have no generator) get stored as compressed chunk data. This keeps saves small at any world size and pairs naturally with the undo/redo command log and deterministic simulation.

Investigate:

- Compression for the stored chunks (palette + RLE first; then Brotli via CompressionStream)
- Autosave (interval + on significant events)
- Crash recovery (journal the edit log before applying)
- Version migration
- Storage: IndexedDB for browser persistence, File System Access API for user-visible save files

Potential compression technologies:

- Gzip
- Brotli
- LZ4-style approaches
- Custom palette/RLE compression

---

## 18. Procedural Terrain

Generation pipeline:

```text
seed
 ↓
continental noise
 ↓
mountain noise
 ↓
hills
 ↓
erosion
 ↓
river generation
 ↓
biome classification
 ↓
soil generation
 ↓
vegetation
 ↓
settlements
 ↓
roads
 ↓
buildings
 ↓
props
```

Implement:

- Height generation
- Hydraulic erosion
- Thermal erosion
- River generation
- Lakes
- Coastlines
- Caves
- Geological layers

---

## 19. Biomes

Use parameters such as:

- Temperature
- Humidity
- Elevation
- Slope
- Soil

Initial biomes:

- Forest
- Grassland
- Desert
- Rocky
- Swamp
- Alpine
- Tundra
- Coast
- River
- Urban

---

## 20. Vegetation

Generate:

- Grass
- Flowers
- Bushes
- Trees
- Fallen branches
- Mushrooms
- Weeds
- Reeds

Eventually make trees physically interactive:

```text
axe
 ↓
tree damage
 ↓
structural instability
 ↓
tree falls
 ↓
branches/leaves react
```

---

## 21. Water / Fluid System

Start with a cellular or height-field approach.

Possible cell:

```ts
interface FluidCell {
  volume;
  velocity;
  pressure;
}
```

Implement progressively:

1. Water placement
2. Gravity
3. Horizontal spreading
4. Flow
5. Pressure
6. Conservation of mass
7. Absorption
8. Evaporation
9. Sediment
10. Buoyancy

Later experiment with GPU compute.

---

## 22. Flooding

Water should be able to move through actual spaces:

```text
pipe
 ↓
floor
 ↓
room
 ↓
hallway
 ↓
stairs
 ↓
basement
```

Use this as a major integration test.

---

## 23. Fire

Represent:

- Temperature
- Fuel
- Oxygen
- Humidity

Ignition condition:

```text
temperature > ignition point
AND
fuel > threshold
AND
oxygen > threshold
```

Fire should:

- Spread
- Heat nearby materials
- Produce smoke
- Consume fuel
- Weaken structures
- React to water
- React to wind
- React to rain

---

## 24. Smoke

Pipeline:

```text
smoke source
 ↓
velocity field
 ↓
temperature
 ↓
buoyancy
 ↓
turbulence
 ↓
density field
```

Start with particles/billboards.

Later investigate volumetric ray marching.

---

## 25. Heat

Implement a generalized heat system.

Sources:

- Fire
- Sun
- Machinery
- Engines
- Electrical failures

Track:

- Temperature
- Thermal conductivity
- Heat transfer

Eventually couple heat to:

- Fire
- Materials
- NPCs
- Weather
- Water
- Structural damage

---

## 26. Structural Simulation

Represent structural elements as a graph.

```text
foundation
   │
   ├── wall
   │    └── roof
   │
   └── wall
        └── roof
```

Nodes can track:

```ts
position
mass
supportStrength
connections[]
```

Connections can approximate:

- Compression
- Tension
- Shear

When support is removed:

```text
support graph
 ↓
affected component
 ↓
unstable
 ↓
stress accumulation
 ↓
fracture
 ↓
detachment
 ↓
rigid body
```

Prioritize believable behavior over perfect engineering.

---

## 27. Physics

Do not make every voxel a rigid body.

Use:

```text
intact voxel structure
 ↓
fracture
 ↓
debris cluster
 ↓
rigid body
```

Use a conventional rigid-body physics engine for detached objects if helpful.

Candidate:

- Rapier

---

## 28. Debris

Generate:

- Dust
- Chips
- Rocks
- Wood fragments
- Glass shards
- Metal fragments
- Large chunks

Different materials should have different behavior.

---

## 29. Glass

States:

```text
intact
 ↓
cracked
 ↓
fractured
 ↓
shattered
```

Investigate:

- Crack generation
- Fracture lines
- Transparency
- Reflections
- Shards
- Sound

---

## 30. Lighting

Start with:

- Sun
- Moon
- Ambient lighting
- Point lights
- Shadow maps

Then experiment with:

- Voxel AO
- Contact shadows
- Cascaded shadows
- Screen-space effects
- Voxel GI / cone tracing
- Dynamic lighting updates

---

## 31. Micro-detail Rendering

Do not store every visual detail as geometry.

Use shaders for:

```text
base material
+
procedural microtexture
+
edge wear
+
AO
+
roughness variation
+
dirt
```

Material examples:

### Concrete

- Pores
- Cracks
- Dirt
- Edge darkening

### Wood

- Grain
- Knots
- Cracks

### Metal

- Scratches
- Oxidation
- Roughness variation

### Glass

- Transmission
- Reflection
- Cracks

---

## 32. Decals

Support procedural or dynamic decals:

- Dirt
- Bullet holes
- Scorch marks
- Graffiti
- Water stains
- Cracks
- Moss

---

## 33. GPU Architecture

Primary target:

```text
TypeScript
 ↓
Three.js
 ↓
WebGPU
 ↓
TSL / WGSL
```

WebGL2 may be kept as a compatibility fallback.

Potential GPU tasks:

- Fluid simulation
- Particle simulation
- Voxel processing
- Lighting
- Terrain generation
- Destruction fields
- Ambient occlusion

Use storage buffers and compute workloads where appropriate.

---

## 34. GPU Particles

Generic particle representation:

```ts
position;
velocity;
life;
size;
rotation;
type;
```

Use for:

- Dust
- Rain
- Sparks
- Smoke
- Embers
- Debris
- Leaves
- Snow

---

## 35. First-Person Controller

Implement:

- WASD
- Mouse look
- Sprint
- Crouch
- Jump
- Climb
- Ladders
- Swimming
- Falling
- Slope handling
- Step-up
- Acceleration
- Deceleration
- Optional head bob
- Optional motion effects

Make movement feel deliberate rather than like a stock demo.

---

## 36. Interaction System

Raycast from the camera.

Show context information:

```text
CONCRETE WALL
Strength: 82%
Material: Concrete
```

Interaction key:

```text
E
```

Later support:

- Grab
- Push
- Pull
- Open
- Close
- Repair
- Activate
- Inspect

---

## 37. NPC Architecture

Each NPC can have:

```text
position
velocity
health
needs
inventory
schedule
memory
relationships
job
home
```

Use an ECS-like architecture if useful.

---

## 38. NPC Needs

Initial:

- Hunger
- Thirst
- Sleep
- Safety
- Social
- Work

Possible emotional state:

```ts
emotion = {
  fear,
  anger,
  happiness,
  curiosity,
  stress,
};
```

---

## 39. NPC Schedules

Example:

```text
07:00 wake
07:15 breakfast
08:00 leave home
08:30 work
12:00 lunch
13:00 work
17:00 leave
17:30 shopping
18:30 home
20:00 leisure
23:00 sleep
```

---

## 40. Navigation

Start with:

```text
walkable cells
 ↓
navigation graph
 ↓
A*
```

Do not rebuild the entire navigation structure after every edit.

Use local invalidation:

```text
changed chunk
 ↓
affected navigation region
 ↓
rebuild
```

---

## 41. NPC Perception

Implement:

### Vision

- Distance
- Field of view
- Line of sight

### Hearing

- Sound event
- Propagation
- NPC detection

---

## 42. NPC Reactions

Example:

```text
explosion
 ↓
sound propagation
 ↓
NPC hears it
 ↓
NPC investigates
 ↓
NPC sees destruction
 ↓
fear increases
 ↓
NPC flees
```

Other reactions:

- Fire
- Flooding
- Structural collapse
- Power outage
- Weather
- Traffic accidents

---

## 43. NPC Memory

Store structured memories such as:

- Event location
- Event type
- People involved
- Time
- Emotional significance

Example:

```text
"Explosion at warehouse."
"Observed player near bridge."
"House was flooded."
"Factory burned."
```

---

## 44. Optional LLM NPC Layer

Do not put an LLM into the real-time simulation loop for every NPC.

Use:

```text
simulation state
 ↓
event summary
 ↓
LLM
 ↓
high-level intention
 ↓
behavior system
```

Potential uses:

- Dialogue
- High-level intentions
- Scenario generation
- World descriptions
- Mission generation

The actual simulation remains deterministic and structured.

---

## 45. Vehicles

Start with:

- Cars
- Trucks
- Vans
- Boats

Implement:

- Steering
- Braking
- Collision
- Basic damage

Later:

- Wheel physics
- Engine
- Fuel
- Traffic
- Vehicle deformation
- Broken windows

---

## 46. Traffic

Road network:

```text
roads
 ↓
nodes
 ↓
lanes
 ↓
traffic graph
```

Vehicles follow routes.

NPCs can use vehicles to travel between locations.

---

## 47. Electricity

Build a simplified electrical graph.

Objects:

- Generator
- Transformer
- Wire
- Switch
- Lamp
- Motor
- Battery

Track:

- Voltage
- Current
- Power

Example:

```text
wire breaks
 ↓
power outage
 ↓
lights off
 ↓
NPC behavior changes
 ↓
security system fails
```

---

## 48. Plumbing

Model:

```text
water source
 ↓
pipes
 ↓
pressure
 ↓
fixtures
```

Break pipe:

```text
pressure loss
 ↓
water leak
```

Potentially add:

- Valves
- Pumps
- Drains
- Sewer network
- Wastewater

---

## 49. Machines

Generic machine component:

```text
machine
 ├── power
 ├── input
 ├── output
 ├── temperature
 └── state
```

Build:

- Pumps
- Fans
- Generators
- Conveyors
- Doors
- Elevators
- Lights

---

## 50. Doors

States:

```text
open
closed
locked
broken
jammed
```

NPCs and scripts can interact with them.

---

## 51. Elevators

Potential components:

```text
shaft
platform
motor
doors
buttons
cables
```

Possible failure states:

- Power failure
- Door obstruction
- Mechanical failure

---

## 52. Weather

States:

```text
clear
cloudy
overcast
rain
heavy rain
storm
fog
snow
```

Weather should transition rather than switch instantly.

Weather affects:

- Fire
- Water
- NPCs
- Visibility
- Movement
- Vegetation
- Lighting

---

## 53. Time

Implement full day/night cycle:

```text
06:00 sunrise
12:00 noon
18:00 sunset
00:00 midnight
```

Time affects:

- Lighting
- NPC schedules
- Traffic
- Weather
- Wildlife
- Businesses
- Simulation speed

---

## 54. Seasons

Optional:

```text
spring
summer
autumn
winter
```

Effects:

- Vegetation
- Snow
- Temperature
- Weather
- Fire risk
- Day length

---

## 55. Wildlife

Add simple:

- Birds
- Deer
- Dogs
- Cats
- Fish

Later experiment with simple ecosystems.

---

## 56. Ecosystem

Optional stretch:

```text
plants
 ↓
herbivores
 ↓
predators
```

Potential interactions:

- Food
- Water
- Reproduction
- Migration
- Fire recovery

---

## 57. Fire Ecology

Potential emergent chain:

```text
dry weather
 ↓
tree ignites
 ↓
wind
 ↓
fire spreads
 ↓
forest burns
 ↓
ash
 ↓
vegetation regrowth
```

---

## 58. Disasters

Scenario systems:

- Earthquake
- Flood
- Wildfire
- Storm
- Landslide
- Tornado-like wind event

### Earthquake

```text
ground acceleration
 ↓
structural stress
 ↓
objects shake
 ↓
building failure
```

### Landslide

```text
slope
+
water
+
material stability
 ↓
mass movement
```

---

## 59. Procedural City

Generation pipeline:

```text
terrain
 ↓
roads
 ↓
blocks
 ↓
lots
 ↓
buildings
 ↓
utilities
 ↓
NPC homes
 ↓
shops
 ↓
traffic
```

---

## 60. Building Generator

Parameterized:

```text
floors
width
depth
roof
windows
doors
stairs
materials
style
```

Example:

```ts
generateBuilding({
  floors: 3,
  width: 12,
  depth: 8,
  style: 'industrial',
});
```

---

## 61. Interior Generation

Generate actual interiors:

- Rooms
- Corridors
- Doors
- Stairs
- Furniture
- Lighting
- Pipes
- Electrical infrastructure

---

## 62. Furniture / Props

Use conventional meshes where appropriate:

- Tables
- Chairs
- Beds
- Shelves
- Lamps
- Cabinets
- Toilets
- Sinks
- Appliances
- Tools
- Signs

---

## 63. Event Bus

Use an event-driven architecture.

Example:

```ts
world.events.emit({
  type: 'BUILDING_COLLAPSED',
  position,
  buildingId,
});
```

Subscribers:

- Audio
- Particles
- AI
- Physics
- Statistics
- Quests
- Replay
- Scripting

Potential events:

```text
PLAYER_ENTERED
PLAYER_EXITED
VOXEL_CREATED
VOXEL_DESTROYED
VOXEL_DAMAGED
STRUCTURE_COLLAPSED
FIRE_STARTED
FIRE_EXTINGUISHED
WATER_FLOW
NPC_DIED
NPC_SAW_EVENT
VEHICLE_CRASH
POWER_LOST
POWER_RESTORED
DOOR_OPENED
DOOR_BROKEN
TREE_FELL
```

---

## 64. Scripting

Creator mode can expose an event/condition/action system.

Example conceptual script:

```js
on('playerEnter', 'warehouse', () => {
  trigger('alarm');
});
```

Or:

```js
on('fireStarted', 'factory', () => {
  spawn('firefighter');
});
```

Eventually expose:

- Triggers
- Conditions
- Actions
- Variables
- Timers
- Entity references
- Event subscriptions

---

## 65. Visual Logic

Optional node-based creator system:

```text
PLAYER ENTERS
      ↓
WAREHOUSE
      ↓
IF
      ↓
TIME > 18:00
      ↓
SPAWN
      ↓
NPC
```

Target:

**Minecraft command blocks + lightweight Blueprint-style logic.**

---

## 66. Mission / Scenario System

Sandbox is primary, but optional scenarios make systems useful.

Examples:

### The Flood

Prevent water from reaching an electrical room.

Possible solutions:

- Repair pipe
- Close valve
- Build barrier
- Destroy wall
- Redirect water
- Cut electricity

### The Collapse

Rescue NPCs from a damaged building.

Possible solutions:

- Remove debris
- Cut walls
- Build support
- Call firefighters
- Dig a tunnel

### Controlled Demolition

Collapse a target building while minimizing neighboring damage.

---

## 67. World Console

Add a developer/creator console:

```text
/weather rain
/time 18:30
/spawn npc
/give concrete 1000
/fill
/explode
/flood
/save
/load
```

Debug commands:

```text
/chunks
/physics
/ai
/fluid
/fire
/gpu
/benchmark
```

---

## 68. Debug Visualizations

Suggested hotkeys:

```text
F1 voxel bounds
F2 chunk bounds
F3 wireframe
F4 normals
F5 AO
F6 physics
F7 navigation
F8 NPC perception
F9 structural graph
F10 fluid velocity
F11 lighting
```

---

## 69. World Inspector

Voxel inspector:

```text
VOXEL

Coordinates:
X 104.28
Y 12.04
Z -38.11

Material:
CONCRETE

Density:
2400 kg/m³

Temperature:
22.1 °C

Damage:
7%

Moisture:
2%

Stress:
13%
```

Object/NPC inspector should expose relevant state.

---

## 70. World Statistics

Example:

```text
WORLD STATISTICS

Population           284
Structures           143
Trees                2843

Water volume         82,392 m³
Destroyed voxels     12.4M
Fire events          17
Collapsed buildings  3

Power consumption    4.2 MW
```

---

## 71. Audio System

Centralize physical interaction audio.

```ts
interface SoundEvent {
  source;
  materialA;
  materialB;
  impactVelocity;
  position;
  intensity;
}
```

Surface interactions:

- Wood + wood
- Metal + metal
- Glass + concrete
- Water + metal
- Foot + gravel
- Foot + grass

Add:

- Footsteps
- Wind
- Rain
- Traffic
- Machinery
- Birds
- Insects
- Electrical hum
- Building creaks
- Reverb

---

## 72. Sound Propagation

Sound events should optionally propagate through the environment.

NPCs can react to:

- Explosions
- Gunshots/tools
- Collapses
- Doors
- Machinery
- Vehicles

---

## 73. Reverb

Define acoustic zones:

```text
outside
room
hallway
warehouse
tunnel
basement
cave
```

Each gets different reverb characteristics.

---

## 74. Rendering Effects

Possible effects:

- SSAO
- SSR
- Bloom
- Motion blur
- Depth of field
- Vignette
- Chromatic aberration
- Film grain
- Tone mapping
- Color grading
- Volumetric fog
- Volumetric clouds

Use restraint; visual clarity matters.

---

## 75. Photo Mode

Expose:

- Free camera
- FOV
- Depth of field
- Exposure
- Focus
- Time of day
- Weather
- Camera speed

---

## 76. Cinematic Camera

Support:

- Camera paths
- Look targets
- Bezier/easing curves
- Camera cuts
- Slow motion
- Time control

---

## 77. Time Manipulation

Possible simulation speed:

```text
0.1x
0.25x
0.5x
1x
2x
5x
10x
```

Useful for destruction demonstrations.

---

## 78. Replay System

Record:

- Player movement
- Editing actions
- Tool usage
- Explosions
- Scenario events

Then replay deterministically.

---

## 79. Determinism

Aim for deterministic simulation where practical.

Given:

```text
seed
world state
time
inputs
```

the simulation should reproduce the same result.

Benefits:

- Debugging
- Replay
- Save/load
- Benchmarking
- Potential future multiplayer

---

## 80. ECS Architecture

Consider a lightweight Entity Component System.

Entities:

- NPC
- Vehicle
- Lamp
- Door
- Machine
- Tree

Components:

- Transform
- Physics
- Health
- AI
- Renderable
- Inventory
- PowerConsumer
- Flammable
- Destructible

Systems:

- PhysicsSystem
- AISystem
- FireSystem
- FluidSystem
- PowerSystem
- RenderingSystem

---

## 81. System Scheduler

Separate update rates.

Example:

```text
Rendering      60 Hz
Physics        60 Hz
AI             10 Hz
World sim      10 Hz
Weather         1 Hz
```

Build a scheduler that supports priorities and fixed/update intervals.

---

## 82. Multithreading

Use Web Workers.

Possible architecture:

```text
Main Thread
 ├── Rendering
 ├── Input
 └── UI

Worker 1 → Voxel generation
Worker 2 → Simulation
Worker 3 → AI / navigation
Worker 4 → World generation
```

Investigate:

- Transferable ArrayBuffers
- SharedArrayBuffer
- Atomics
- Worker pools

---

## 83. Chunk Generation Workers

Pipeline:

```text
request chunk
 ↓
worker
 ↓
generate
 ↓
mesh
 ↓
transfer buffers
 ↓
GPU
```

Never block rendering with expensive world generation.

---

## 84. Performance Profiler

Build an in-game profiler:

```text
FPS                  97
Frame time         10.3 ms

CPU
 voxel simulation    1.8 ms
 physics             1.2 ms
 AI                  0.7 ms

GPU
 geometry            3.1 ms
 shadows             1.4 ms
 postprocess         1.0 ms

Chunks
 loaded              421
 visible             183
 simulated            36

Voxels
 loaded            82.4M
 visible            4.8M

NPCs
 active               48
```

---

## 85. Automated Benchmarks

Create benchmark worlds:

```text
Benchmark A — 1M logical voxels
Benchmark B — 10M logical voxels
Benchmark C — 100M logical voxels
Benchmark D — 500 NPCs
Benchmark E — Large fire
Benchmark F — Mass destruction
```

Measure:

- Frame time
- CPU time
- GPU time
- Memory
- Mesh generation
- Simulation
- Physics
- Streaming latency

---

## 86. Adaptive Quality

Potential rules:

```text
FPS < 60
 → reduce particles

FPS < 50
 → reduce fluid resolution

FPS < 45
 → reduce shadow resolution

FPS < 40
 → increase voxel LOD
```

Expose manual overrides as well.

---

## 87. Memory Management

Track:

- CPU memory
- GPU memory
- Chunk count
- Geometry memory
- Texture memory
- Particle memory

Use:

- LRU eviction
- Chunk budgets
- Geometry cache
- Material cache

---

## 88. Settings

Expose:

- Voxel detail
- Shadow quality
- Fluid quality
- Particle density
- NPC simulation
- View distance
- Texture quality
- Post processing
- Volumetric effects
- FOV
- Motion blur
- Head bob
- UI scaling
- Key remapping
- Controller support

---

## 89. Repository Structure

Suggested monorepo:

```text
micro-world/
│
├── apps/
│   ├── game/
│   ├── editor/
│   └── benchmark/
│
├── packages/
│   ├── core/
│   ├── voxel/
│   ├── renderer/
│   ├── physics/
│   ├── fluids/
│   ├── fire/
│   ├── ai/
│   ├── navigation/
│   ├── audio/
│   ├── worldgen/
│   ├── entities/
│   ├── scripting/
│   ├── serialization/
│   ├── networking/
│   └── ui/
│
├── assets/
├── tests/
├── benchmarks/
└── tools/
```

---

## 90. Core Package

```text
core/
├── World
├── Entity
├── EventBus
├── Scheduler
├── Time
├── RNG
├── Command
└── ResourceManager
```

---

## 91. Voxel Package

```text
voxel/
├── VoxelWorld
├── Chunk
├── Region
├── Material
├── Palette
├── Mesher
├── GreedyMesher
├── DensityField
├── SVO
├── Streaming
└── Editing
```

---

## 92. Renderer Package

```text
renderer/
├── Renderer
├── VoxelRenderer
├── ChunkRenderer
├── Materials
├── Lighting
├── Shadows
├── PostFX
├── Particles
└── DebugRenderer
```

---

## 93. Simulation Package

```text
simulation/
├── Physics
├── Fluids
├── Fire
├── Smoke
├── Heat
├── Structures
├── Electricity
└── Weather
```

---

## 94. AI Package

```text
ai/
├── NPC
├── Navigation
├── Perception
├── Behavior
├── Needs
├── Memory
├── Schedules
└── Dialogue
```

---

## 95. World Generation Package

```text
worldgen/
├── Terrain
├── Noise
├── Erosion
├── Rivers
├── Biomes
├── Vegetation
├── Buildings
├── Roads
└── Cities
```

---

## 96. Editor Package

```text
editor/
├── Selection
├── Gizmos
├── Brushes
├── Inspector
├── Hierarchy
├── Clipboard
├── UndoRedo
├── Prefabs
└── Scripting
```

---

## 97. Suggested Technology

Primary:

- TypeScript
- Three.js
- WebGPU
- TSL
- Vite
- Web Workers
- IndexedDB

Potential supporting technologies:

- Rapier for rigid-body physics
- Zod for runtime validation

Keep the core voxel engine and major simulation systems custom.

---

## 98. Phase 0 — Repository

**Rules for all phases:**

- Every phase ends with a **runnable demo** and a short recorded/screenshot artifact. If it can't be shown, it isn't done.
- Every phase lists **exit criteria**. Do not start the next phase until they are met, and do not extend a phase by more than ~30% of its estimate without cutting scope.
- Each system ships in three passes: _works_ → _feels right_ → _fast_. Never build all three up front.
- Phases 6, 8 and 11 are **hard gates** (see below). A gate failure means re-architect, not push on.

Create:

- TypeScript project/monorepo
- Linting
- Formatting
- Unit testing
- Integration testing
- CI
- Build
- Dev server
- Basic architecture docs

---

## 99. Phase 1 — First Pixel

Goal:

> Walk around a 16³ voxel cube.

Implement:

- Renderer
- Camera
- Player
- Voxel array
- Mesh generation

---

## 100. Phase 2 — Chunks

Implement:

- 32³ chunks
- Loading
- Unloading
- Meshing
- Neighbor access
- Chunk coordinate conversion
- Dirty tracking

---

## 101. Phase 3 — Terrain

Generate:

- Hills
- Mountains
- Plains

---

## 102. Phase 4 — Materials

Add:

- Air
- Grass
- Dirt
- Stone
- Sand
- Wood
- Water

---

## 103. Phase 5 — Editing

Implement:

- Place
- Remove
- Paint
- Undo
- Redo
- Save
- Load

At this point the project becomes a basic Minecraft-like voxel sandbox.

---

## 104. Phase 6 — Microvoxels

**This is the go/no-go gate for the entire project.**

Increase logical resolution.

Optimize:

- Greedy meshing
- Chunk streaming
- LOD
- Storage

Exit criteria:

- A 2 cm-resolution wall can be destroyed voxel-by-voxel with the mouse
- The affected region remeshes in **under 16 ms** (perceptually instant)
- 60 FPS maintained while walking through a 128³ microvoxel world
- Save/reload round-trips losslessly

If these fail after optimization, fall back to 4–8 cm voxels and continue — the LOD design deliberately keeps the game valid at lower resolutions.

---

## 105. Phase 7 — Creator Mode

Add:

- Brushes
- Selection
- Copy/paste
- Gizmos
- Inspector
- Prefabs

At this point it becomes a serious voxel editor.

---

## 106. Phase 8 — Destruction

Add:

- Damage
- Fracturing
- Debris
- Physics
- Particles
- Sound

Exit criteria (gate):

- Removing wall supports under a roof causes it to fall within a second
- An explosion produces debris, dust, sound, and a hole — in that order, without frame drops below 45 FPS
- Debris count is capped and pooled; a 100-event stress test stays stable

---

## 107. Phase 9 — Water

Implement:

- Fluid grid
- Flow
- Pressure
- Flooding

---

## 108. Phase 10 — Fire

Implement:

- Temperature
- Fuel
- Oxygen
- Fire
- Smoke

---

## 109. Phase 11 — Structural Simulation

Implement:

- Support graph
- Stress
- Collapse
- Detached rigid bodies

Exit criteria (gate):

- The classic showcase works end-to-end: destroy the ground floor of a building → upper floors detach and collapse as rigid bodies → debris settles
- Analysis is incremental: a single edit does not re-analyze the whole building (budget: < 5 ms for a house-scale structure)
- "Believable over correct": engineering accuracy is explicitly out of scope

---

## 110. Phase 12 — NPCs

Start with:

- Navigation
- Idle behavior
- Wander
- Schedule

---

## 111. Phase 13 — NPC Reactions

Add:

- Hearing
- Vision
- Fear
- Fire response
- Destruction response
- Flood response

---

## 112. Phase 14 — Procedural Town

Generate:

- Roads
- Houses
- Shops
- Industrial areas
- Forest
- River

---

## 113. Phase 15 — Utilities

Add:

- Electricity
- Water
- Pipes
- Lights

---

## 114. Phase 16 — Atmosphere

Add:

- Weather
- Clouds
- Fog
- Day/night
- Seasons

---

## 115. Phase 17 — Visual Polish

Improve:

- Lighting
- AO
- Shadows
- Reflections
- Particles
- Materials
- Post processing
- Audio

---

## 116. Phase 18 — Scenario System

Create:

- Flood
- Fire
- Collapse
- Demolition
- Rescue

---

## 117. Phase 19 — Scripting

Add:

- Events
- Triggers
- Conditions
- Actions
- Variables
- Timers

---

## 118. Phase 20 — LLM Integration

Only after the deterministic simulation is mature.

Potential uses:

- NPC dialogue
- Scenario generation
- World descriptions
- Procedural mission generation
- High-level NPC intentions

---

## 119. Phase 21 — Performance

Profile and optimize:

- CPU
- GPU
- Memory
- Workers
- Chunks
- Meshing
- Simulation

---

## 120. Phase 22 — WebGPU Compute

Move expensive workloads to GPU:

- Fluids
- Particles
- Voxel operations
- Lighting
- Terrain

---

## 121. Phase 23 — Huge Worlds

Target:

```text
1 km²
```

Then experiment with:

```text
10 km²
```

---

## 122. Phase 24 — Extreme Benchmark

Generate:

```text
100M logical voxels
```

The goal is not necessarily to render all simultaneously.

Test:

- Representation
- Streaming
- Memory
- Generation
- Editing

---

## 123. Phase 25 — Destruction Benchmark

Build approximately 20 buildings.

Trigger a large destruction event.

Measure:

- FPS
- Simulation time
- Mesh rebuild time
- Physics time
- Memory

---

## 124. Phase 26 — Editor as a Real Tool

Push creator mode toward:

- Blender-like selection
- Minecraft-like building
- Unreal-like world organization

---

## 125. Phase 27 — Procedural Content Generator

Example UI:

```text
Generate World

Seed: 382910

World Size: Small
Terrain: Mountainous
Climate: Temperate
Urban Density: Medium
Water: High
Buildings: Industrial
Population: Medium
```

Generate an entire world.

---

## 126. Phase 28 — Scenario Generator

Generate:

- Location
- Objective
- NPCs
- Environment
- Constraints
- Events

Potentially with an LLM as a content-generation layer.

---

## 127. Phase 29 — Cinematic Mode

Example showcase:

```text
Camera approaches warehouse
 ↓
Rain begins
 ↓
Lightning
 ↓
NPC enters
 ↓
Player breaks pipe
 ↓
Water floods room
 ↓
Electrical short
 ↓
Fire starts
 ↓
Smoke rises
 ↓
NPC evacuates
 ↓
Roof collapses
 ↓
Camera pulls back
```

---

## 128. Phase 30 — Final Polish

Add:

- Menus
- Loading screens
- Tutorial
- Settings
- Error handling
- Accessibility
- Controller support
- Performance presets
- Save recovery
- Documentation

---

## 129. Research Tracks for Extra AI Coding Work

Use the project as a series of engineering experiments.

### Voxel storage

Compare:

- Dense
- Palette
- RLE
- Sparse
- SVO

### Meshing

Compare:

- Naive
- Greedy
- Marching cubes
- Surface nets
- Dual contouring

### Fluids

Compare:

- Cellular automata
- Height-field flow
- Stable fluids
- GPU solver

### Rendering

Compare:

- Naive cube rendering
- Greedy mesh
- Instancing
- Batching
- GPU voxel rendering

For each experiment:

1. Implement
2. Test
3. Benchmark
4. Visualize
5. Document
6. Compare
7. Keep or discard

---

## 130. AI-Assisted Development Strategy

Avoid asking the coding agent for huge vague features.

Instead use small, testable tasks.

Bad:

> Implement fluid simulation.

Good:

> Implement a deterministic 32×32×16 single-chunk fluid simulation. Each cell stores volume 0–255. Implement gravity and horizontal equalization. Add unit tests for conservation of mass, boundaries, equalization and empty cells.

Then iterate:

1. Chunk boundaries
2. Pressure
3. Worker execution
4. Profiling
5. GPU implementation

---

## 131. Use the Coding AI as Different Engineers

Useful review roles:

### Engine architect

Identify scalability and abstraction problems.

### Graphics engineer

Analyze GPU bottlenecks and rendering architecture.

### Simulation engineer

Review numerical stability and conservation.

### Gameplay engineer

Design interactions between systems.

### QA engineer

Generate adversarial and property-based tests.

### Performance engineer

Profile and optimize.

### Tools engineer

Improve creator mode.

### Code reviewer

Find race conditions, lifecycle bugs, and architectural problems.

---

## 132. Documentation Requirements

Every major subsystem should maintain:

```text
README.md
architecture.md
API.md
design.md
benchmarks.md
```

Also maintain:

```text
CHANGELOG.md
KNOWN_ISSUES.md
PERFORMANCE.md
```

---

## 133. Property-Based Testing

Test invariants such as:

- Editing a voxel twice restores original state.
- Serialization/deserialization preserves world state.
- Chunk generation is deterministic.
- Destroying air does nothing.
- Placing then removing a voxel restores the previous state.
- Fluid mass is approximately conserved.
- Unsupported structures do not remain stable.

---

## 134. Ultimate Showcase Scene

Create a ~500 × 500 m procedural town containing:

- Houses
- Apartments
- Factory
- Warehouse
- Supermarket
- Gas station
- River
- Bridge
- Forest
- Construction site

Potentially:

- 200 NPCs
- 50 vehicles
- Thousands of props
- Millions/billions of logical voxels

### Showcase event

A storm arrives.

Rain accumulates.

A drainage pipe is damaged.

The basement floods.

Electrical equipment shorts.

A fire starts.

NPCs react.

Firefighters arrive.

A bridge weakens.

A truck crosses it.

The bridge collapses.

Traffic reroutes.

NPCs respond.

Water continues downstream.

The player enters creator mode, pauses time, modifies the town, repairs/rebuilds the bridge, and resumes the simulation.

---

## 135. Three-Month Strategy

The goal is not to "finish a game" in three months.

The goal is to maximize:

- Technical depth
- Interesting engineering problems
- AI-assisted implementation
- Learning
- Demonstrable results

### Month 1 — Engine

Focus:

- TypeScript architecture
- WebGPU
- Voxel storage
- Chunks
- Meshing
- Streaming
- LOD
- Creator mode
- Serialization
- Undo/redo

Target:

> Walkable, editable, saveable microvoxel world.

### Month 2 — Simulation

Focus:

- Destruction
- Physics
- Water
- Fire
- Smoke
- Structural collapse
- Weather
- NPCs
- Navigation
- Audio

Target:

> A world where things actually happen.

### Month 3 — "Holy shit" factor

Focus:

- GPU compute
- Procedural towns
- Advanced lighting
- LOD
- Performance
- NPC reactions
- Scenario system
- Cinematic mode
- Photo mode
- Scripting
- Benchmarks

Target:

> A spectacular technical demo.

### Slippage policy (decide now, not mid-panic)

Three months is aggressive; something will slip. Cut in this order, without guilt:

1. Cinematic camera, photo mode, seasons
2. Vehicles, traffic, wildlife, ecosystem
3. LLM integration, visual scripting (keep the event bus — it's the backbone)
4. Elevators, plumbing detail (keep "pipe breaks → water leaks")
5. WebGL2 fallback (WebGPU-only demos are acceptable)

**Never cut:** the profiler, determinism, save/load, and the flooding integration test. These four are what make every other system debuggable and demonstrable.

### Demo cadence

End every week with a 60-second capture of something new working. These clips are the project's real output — they're what makes the three months demonstrable, and they catch "it almost works" self-deception early.

---

## 136. AI_TASKS.md Philosophy

Maintain a large task list and continuously split tasks into smaller implementation units.

Example:

```text
[ ] Implement chunk coordinate conversion
[ ] Add negative-coordinate tests
[ ] Implement palette compression
[ ] Implement greedy mesher
[ ] Benchmark greedy mesher
[ ] Implement mesh cache
[ ] Add chunk LRU
[ ] Add worker-based generation
[ ] Add worker-based meshing
[ ] Add transferable buffers
[ ] Add voxel editing
[ ] Add undo
[ ] Add redo
[ ] Add command serialization
[ ] Add world serialization
[ ] Add compressed save format
[ ] Add autosave
[ ] Add crash recovery
[ ] Add terrain generation
[ ] Add erosion
[ ] Add rivers
[ ] Add biomes
[ ] Add vegetation
[ ] Add structures
[ ] Add destruction
[ ] Add fracture
[ ] Add debris
[ ] Add physics
[ ] Add fluid
[ ] Add fire
[ ] Add smoke
[ ] Add heat
[ ] Add structural graph
[ ] Add collapse
[ ] Add NPC
[ ] Add navigation
[ ] Add perception
[ ] Add memory
[ ] Add schedules
[ ] Add weather
[ ] Add electricity
[ ] Add plumbing
[ ] Add sound propagation
[ ] Add procedural city
[ ] Add vehicles
[ ] Add traffic
[ ] Add scenario system
[ ] Add scripting
[ ] Add GPU particles
[ ] Add GPU fluids
[ ] Add GPU voxel operations
[ ] Add voxel AO
[ ] Add GI experiment
[ ] Add temporal rendering
[ ] Add benchmark suite
[ ] Add profiler
[ ] Add replay
[ ] Add photo mode
[ ] Add cinematic camera
```

---

## 137. Final North Star

The project should be thought of as:

```text
                MICRO//WORLD
                     │
       ┌─────────────┼─────────────┐
       │             │             │
    RENDERING     SIMULATION     CREATION
       │             │             │
       │       ┌─────┼─────┐       │
       │       │     │     │       │
       │     FIRE  WATER  PHYSICS  │
       │       │     │     │       │
       └───────┴─────┼─────┴───────┘
                     │
                  WORLD
                     │
              ┌──────┴──────┐
              │             │
             NPCs       ENVIRONMENT
```

The ultimate goal is not "Minecraft in Three.js."

The goal is:

> **How far can a browser-based voxel simulation engine be pushed?**

The first concrete milestone should be:

> In a browser, walk around a 128³ microvoxel world, destroy a 2 cm-resolution concrete wall with the mouse, watch the affected region remesh in real time, save it, reload it, and maintain 60 FPS.

Once that works, the rest of the project can grow from it.

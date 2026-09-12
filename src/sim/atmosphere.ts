import { hash3 } from '../voxel/terrain';

/**
 * Atmosphere (Phase 16): the world clock and everything that hangs off
 * it — the day/night sun path with seasonal drift, a seeded weather
 * state machine (clear → cloudy → overcast → rain → storm), wind, and
 * temperature. One module owns "what is the sky doing right now"; the
 * renderer maps the scalars to colors and particles, fire reads the
 * precipitation, and the NPC schedule reads the clock (plan §114).
 *
 * Determinism (ADR-005): the diurnal cycle is a pure function of the
 * tick counter, and the weather machine is a chain of segments whose
 * state, hold, and fade are hash-derived from (seed, segmentIndex) —
 * so `syncTo(t)` reproduces exactly the state stepping would reach,
 * and the same (seed, tick) always yields the same sky. Weather and
 * time are transient (not in the save format): a fresh world starts at
 * 08:00 of day 0, and a load resumes the session clock.
 *
 * Lightning rides the tick hash too: while a storm is overhead the sim
 * occasionally calls `onStrike(x, z)` near the center it was given
 * (the player). The pure core never touches voxels — main resolves the
 * strike (flash, thunder, and a real `fire.ignite` on whatever stands
 * there), so storms can start fires through the existing event chain.
 *
 * Pure: no three.js, no DOM (ADR-002). No sequential RNG.
 */

/** Schedule clock shared with the NPC sim (which re-exports these). */
export const TICKS_PER_HOUR = 100;
export const DAY_TICKS = TICKS_PER_HOUR * 24;
/** Where a fresh world starts: 08:00, a morning with the day ahead. */
export const START_TICK = 8 * TICKS_PER_HOUR;
/** Game days per season; a full year is 4·8 = 32 days (~21 min real). */
export const SEASON_LENGTH_DAYS = 8;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export type Weather = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm';
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];

/** Per-season sky constants: max sun elevation (rad) and day fraction. */
const SEASON_MAX_ELEVATION = [0.95, 1.15, 0.9, 0.62] as const;
const SEASON_DAYLIGHT = [0.5, 0.56, 0.5, 0.45] as const;
/** Afternoon temperature baseline per season (°C proxy, no real model). */
const SEASON_TEMPERATURE = [12, 24, 10, -4] as const;

/** Everything the world looks like at one instant (scalars only). */
export interface AtmosphereState {
  timeTicks: number;
  /** Float game hour (13.5 = 13:30). */
  hour: number;
  /** Game day since world start (seasons advance per SEASON_LENGTH_DAYS). */
  day: number;
  season: Season;
  weather: Weather;
  /** 0 (bare sky) – 1 (fully overcast). */
  cloudiness: number;
  /** Precipitation strength; snowing when the temperature is below ~0. */
  precip: number;
  snowing: boolean;
  /** Horizontal wind vector (cells/s proxy), length = windSpeed. */
  wind: { x: number; z: number };
  windSpeed: number;
  /** Sun direction (unit; points below the horizon at night). */
  sunDir: { x: number; y: number; z: number };
  /** Sun elevation in radians (negative at night). */
  sunElevation: number;
  /** Scene brightness from the sun (0 night – 1 day), smooth at dawn/dusk. */
  daylight: number;
  moonDir: { x: number; y: number; z: number };
  /** How visibly the moon is up (0–1). */
  moonlight: number;
  /** Extra fog density from weather (0 clear – ~0.9 storm). */
  fogFactor: number;
  /** Storm gloom that dims sun and ambience beyond the cloud cover. */
  darkness: number;
  /** °C proxy from season + time of day + precipitation. */
  temperature: number;
}

/** Colors + light levels the renderer applies to the scene each frame. */
export interface SkyPalette {
  zenith: number;
  horizon: number;
  fog: number;
  /** Direct sun tint (the voxel shader's `uSunColor` base). */
  sun: number;
  /** Sun light multiplier (0 at night). */
  sunIntensity: number;
  /** Hemisphere ambient tints (the shader's sky/ground mix). */
  ambientSky: number;
  ambientGround: number;
  /** 0–1 star visibility (night × clear sky). */
  starOpacity: number;
  /** 0–1 disc visibility for sun / moon. */
  sunDisc: number;
  moonDisc: number;
}

// --- weather segment chain ---------------------------------------------------

interface Segment {
  index: number;
  state: Weather;
  startTick: number;
  hold: number;
  fade: number;
}

/** Shortest possible segment — bounds syncTo's catch-up loop. */
const MIN_SEGMENT_SPAN = 600 + 100;

interface WeatherProfile {
  cloudiness: number;
  precip: number;
  wind: number;
  fog: number;
  darkness: number;
}

const WEATHER_PROFILE: Record<Weather, WeatherProfile> = {
  clear: { cloudiness: 0.14, precip: 0, wind: 0.3, fog: 0, darkness: 0 },
  cloudy: { cloudiness: 0.52, precip: 0, wind: 0.45, fog: 0.08, darkness: 0 },
  overcast: { cloudiness: 0.82, precip: 0, wind: 0.55, fog: 0.3, darkness: 0.08 },
  rain: { cloudiness: 0.94, precip: 0.6, wind: 0.65, fog: 0.65, darkness: 0.22 },
  storm: { cloudiness: 1, precip: 1, wind: 0.95, fog: 0.9, darkness: 0.45 },
};

/** Markov next-states: [candidate, weight] — hash-picked per segment. */
const NEXT_WEATHER: Record<Weather, readonly (readonly [Weather, number])[]> = {
  clear: [
    ['clear', 0.35],
    ['cloudy', 0.65],
  ],
  cloudy: [
    ['clear', 0.3],
    ['cloudy', 0.3],
    ['overcast', 0.4],
  ],
  overcast: [
    ['cloudy', 0.4],
    ['rain', 0.6],
  ],
  rain: [
    ['overcast', 0.45],
    ['rain', 0.3],
    ['storm', 0.25],
  ],
  storm: [
    ['rain', 0.5],
    ['overcast', 0.5],
  ],
};

function pickNext(state: Weather, seed: number, index: number): Weather {
  const roll = hash3(seed, index, 11, 0);
  let acc = 0;
  for (const [candidate, weight] of NEXT_WEATHER[state]) {
    acc += weight;
    if (roll < acc) return candidate;
  }
  return NEXT_WEATHER[state][NEXT_WEATHER[state].length - 1][0];
}

function segmentAt(index: number, state: Weather, startTick: number, seed: number): Segment {
  return {
    index,
    state,
    startTick,
    hold: 600 + Math.floor(hash3(seed, index, 12, 0) * 1400),
    fade: 120 + Math.floor(hash3(seed, index, 13, 0) * 160),
  };
}

function initialSegment(seed: number): Segment {
  const first = pickNext('clear', seed, 0);
  // A storm as the very first thing a new world sees is a bad opening.
  return segmentAt(0, first === 'storm' ? 'cloudy' : first, 0, seed);
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Chance, per tick of storm, that lightning strikes near the center. */
const STRIKE_CHANCE = 1 / 650;
/** Strike landing distances from the watch center (cells). */
const STRIKE_MIN_DISTANCE = 10;
const STRIKE_MAX_DISTANCE = 44;

export class AtmosphereSim {
  /** World ticks; the NPC schedule reads this via its injected `clock`. */
  timeTicks = START_TICK;
  private prev: Segment;
  private current: Segment;
  private readonly state: AtmosphereState = {
    timeTicks: START_TICK,
    hour: 8,
    day: 0,
    season: 'spring',
    weather: 'clear',
    cloudiness: 0.14,
    precip: 0,
    snowing: false,
    wind: { x: 0.2, z: 0.1 },
    windSpeed: 0.22,
    sunDir: { x: 0.5, y: 0.8, z: 0.3 },
    sunElevation: 0.9,
    daylight: 1,
    moonDir: { x: 0, y: -1, z: 0 },
    moonlight: 0,
    fogFactor: 0,
    darkness: 0,
    temperature: 15,
  };

  /** Wired by main: a storm strike lands at these surface coordinates. */
  onStrike?: (x: number, z: number) => void;
  /** Where strikes aim (main keeps this at the player position). */
  strikeCenter: { x: number; z: number } = { x: 0, z: 0 };

  constructor(private readonly seed: number) {
    this.current = initialSegment(seed);
    this.prev = segmentAt(-1, WEATHERS[0], this.current.startTick - MIN_SEGMENT_SPAN, seed);
    this.refresh();
  }

  // --- clock ---------------------------------------------------------------

  /** Advance one fixed step: clock, weather machine, lightning. */
  tick(): void {
    this.timeTicks++;
    this.advance();
    this.refresh();
    this.maybeStrike();
  }

  /**
   * Jump straight to tick `t` (tests, debug, future time controls).
   * Rebuilds the weather chain by iterating segments — each spans at
   * least MIN_SEGMENT_SPAN ticks, so even huge jumps are cheap — and is
   * purely index-derived, so it equals stepping tick by tick.
   */
  syncTo(t: number): void {
    if (t < this.current.startTick) {
      // Backwards: restart the chain from the epoch.
      this.current = initialSegment(this.seed);
      this.prev = segmentAt(-1, WEATHERS[0], -MIN_SEGMENT_SPAN, this.seed);
      this.timeTicks = 0;
    }
    // Move the clock first: `advance` walks segments against timeTicks.
    this.timeTicks = t;
    this.advance();
    this.refresh();
  }

  get hourOfDay(): number {
    return (this.timeTicks % DAY_TICKS) / TICKS_PER_HOUR;
  }

  /** "14:30"-style clock for the HUD. */
  clockString(): string {
    const hour = Math.floor(this.hourOfDay);
    const minute = Math.floor((this.hourOfDay - hour) * 60);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // --- weather -------------------------------------------------------------

  get weather(): Weather {
    return this.snapshot.weather;
  }

  get precip(): number {
    return this.snapshot.precip;
  }

  /**
   * Debug/scenario hook: force a weather state now. Deliberately breaks
   * the (seed, tick) purity of the chain until `reset` — scenario
   * systems and tests are allowed to do that.
   */
  forceWeather(state: Weather, holdTicks = 2400): void {
    this.prev = { ...this.current, hold: Math.max(0, this.timeTicks - this.current.startTick) };
    this.current = segmentAt(this.current.index + 1, state, this.timeTicks, this.seed);
    this.current.hold = holdTicks;
    this.current.fade = 60;
    this.refresh();
  }

  /** Full sim state for determinism tests and debug tooling. */
  exportState(): {
    timeTicks: number;
    prev: Segment;
    current: Segment;
    wind: { x: number; z: number };
    weather: Weather;
  } {
    return {
      timeTicks: this.timeTicks,
      prev: { ...this.prev },
      current: { ...this.current },
      wind: { ...this.snapshot.wind },
      weather: this.snapshot.weather,
    };
  }

  /** Back to the fresh-world instant (day 0, 08:00, epoch weather). */
  reset(): void {
    this.timeTicks = START_TICK;
    this.current = initialSegment(this.seed);
    this.prev = segmentAt(-1, WEATHERS[0], -MIN_SEGMENT_SPAN, this.seed);
    this.refresh();
  }

  // --- sampling ------------------------------------------------------------

  /** The live state (a stable object — renderers read it every frame). */
  get snapshot(): AtmosphereState {
    return this.state;
  }

  /** Current temperature (°C proxy). */
  get temperature(): number {
    return this.state.temperature;
  }

  /** Recompute the cached state for the current tick. */
  private refresh(): void {
    const s = this.state;
    const t = this.timeTicks;
    s.timeTicks = t;
    s.hour = this.hourOfDay;
    s.day = Math.floor(t / DAY_TICKS);

    // Season, blended from the previous one over each season's first day.
    const dayInYear = s.day % (SEASON_LENGTH_DAYS * 4);
    const seasonIndex = Math.floor(dayInYear / SEASON_LENGTH_DAYS);
    const dayInSeason = dayInYear % SEASON_LENGTH_DAYS;
    const prevSeason = (seasonIndex + 3) % 4;
    // Each season ramps in over its first day from the previous one's
    // constants — except the world's very first day, which would
    // otherwise inherit winter's low sun: day 0 is pure spring.
    const blend = s.day === 0 ? 1 : smooth(clamp01(dayInSeason));
    const maxElev =
      SEASON_MAX_ELEVATION[prevSeason] * (1 - blend) + SEASON_MAX_ELEVATION[seasonIndex] * blend;
    const daylightFrac =
      SEASON_DAYLIGHT[prevSeason] * (1 - blend) + SEASON_DAYLIGHT[seasonIndex] * blend;
    const seasonTemp =
      SEASON_TEMPERATURE[prevSeason] * (1 - blend) + SEASON_TEMPERATURE[seasonIndex] * blend;
    s.season = SEASONS[seasonIndex];

    // Weather blend: fade from the previous segment into the current one.
    const u = smooth(clamp01((t - this.current.startTick) / this.current.fade));
    const a = WEATHER_PROFILE[this.prev.state];
    const b = WEATHER_PROFILE[this.current.state];
    s.cloudiness = a.cloudiness + (b.cloudiness - a.cloudiness) * u;
    s.precip = a.precip + (b.precip - a.precip) * u;
    s.fogFactor = a.fog + (b.fog - a.fog) * u;
    s.darkness = a.darkness + (b.darkness - a.darkness) * u;
    s.weather = this.current.state;
    s.windSpeed = a.wind + (b.wind - a.wind) * u;
    const prevAngle = hash3(this.seed, this.prev.index, 14, 0) * Math.PI * 2;
    const currentAngle = hash3(this.seed, this.current.index, 14, 0) * Math.PI * 2;
    let delta = currentAngle - prevAngle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    const windAngle = prevAngle + delta * u;
    s.wind.x = Math.cos(windAngle) * s.windSpeed;
    s.wind.z = Math.sin(windAngle) * s.windSpeed;

    // Sun path: daylight fraction centers noon; elevation from season.
    const f = (t % DAY_TICKS) / DAY_TICKS;
    const sunrise = (1 - daylightFrac) / 2;
    const sun = this.bodyDir(f, sunrise, daylightFrac, maxElev);
    s.sunDir.x = sun.x;
    s.sunDir.y = sun.y;
    s.sunDir.z = sun.z;
    s.sunElevation = Math.asin(Math.max(-1, Math.min(1, sun.y)));
    s.daylight = smooth(clamp01((sun.y + 0.02) / 0.22));
    // Moon: the same path half a day off, up while the sun is down.
    const moonSpan = 1 - daylightFrac;
    const moon = this.bodyDir((f + 0.5) % 1, (1 - moonSpan) / 2, moonSpan, 0.9);
    s.moonDir.x = moon.x;
    s.moonDir.y = moon.y;
    s.moonDir.z = moon.z;
    s.moonlight = smooth(clamp01((moon.y + 0.02) / 0.25)) * (1 - s.daylight);

    s.snowing = s.precip > 0.05 && seasonTemp + 5 * Math.sin(2 * Math.PI * (f - 0.35)) < 0.5;
    s.temperature = seasonTemp + 5 * Math.sin(2 * Math.PI * (f - 0.35)) - s.precip * 2.5;
  }

  /**
   * Direction of a celestial body on the shared east→south→west arc:
   * azimuth sweeps 0…π around the horizon while elevation follows a
   * sine arc peaking at `maxElev`. `p` outside [0, 1] means the body is
   * below the horizon (y dips negative — the discs hide, and the voxel
   * shader's sun term goes to zero on its own). The result is a unit
   * vector, so elevation reads back exactly as `asin(y)`.
   */
  private bodyDir(
    f: number,
    rise: number,
    span: number,
    maxElev: number,
  ): { x: number; y: number; z: number } {
    const p = span > 0 ? (f - rise) / span : 0.5;
    const cycle = Math.max(-0.5, Math.min(1.5, p));
    const below = cycle < 0 || cycle > 1;
    const elev = Math.sin(Math.PI * cycle) * (below ? 0.6 : maxElev);
    const az = Math.PI * clamp01(p);
    return {
      x: Math.cos(elev) * Math.cos(az),
      y: Math.sin(elev),
      z: Math.cos(elev) * Math.sin(az),
    };
  }

  private advance(): void {
    while (this.timeTicks >= this.current.startTick + this.current.hold + this.current.fade) {
      const end = this.current.startTick + this.current.hold + this.current.fade;
      this.prev = this.current;
      const next = pickNext(this.current.state, this.seed, this.current.index + 1);
      this.current = segmentAt(this.current.index + 1, next, end, this.seed);
    }
  }

  private maybeStrike(): void {
    if (!this.onStrike) return;
    if (this.snapshot.weather !== 'storm') return;
    if (hash3(this.seed, 7777, this.timeTicks, 0) >= STRIKE_CHANCE) return;
    const angle = hash3(this.seed, 8888, this.timeTicks, 1) * Math.PI * 2;
    const dist =
      STRIKE_MIN_DISTANCE +
      hash3(this.seed, 8888, this.timeTicks, 2) * (STRIKE_MAX_DISTANCE - STRIKE_MIN_DISTANCE);
    this.onStrike(
      Math.round(this.strikeCenter.x + Math.cos(angle) * dist),
      Math.round(this.strikeCenter.z + Math.sin(angle) * dist),
    );
  }
}

// --- palette -----------------------------------------------------------------
// Pure hex math (no three.js): the renderer applies these to the sky dome
// and the voxel shader each frame; tests pin the day/night/storm shapes.

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

function rgbToHex(r: number, g: number, b: number): number {
  return (
    (Math.round(Math.max(0, Math.min(255, r))) << 16) |
    (Math.round(Math.max(0, Math.min(255, g))) << 8) |
    Math.round(Math.max(0, Math.min(255, b)))
  );
}

function mixHex(a: number, b: number, t: number): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

function scaleHex(hex: number, k: number): number {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * k, g * k, b * k);
}

// Keyframes: clear noon keeps the pre-atmosphere look (0x87b5e0 sky).
const NIGHT_ZENITH = 0x070b1e;
const NIGHT_HORIZON = 0x101832;
const DAY_ZENITH = 0x87b5e0;
const DAY_HORIZON = 0xbcd8ef;
const TWILIGHT_HORIZON = 0xd98a52;
const OVERCAST_TINT = 0x8a93a2;

/** Map an atmosphere snapshot to concrete colors and light levels. */
export function skyPalette(state: AtmosphereState): SkyPalette {
  const day = smooth(clamp01((state.sunElevation + 0.12) / 0.34));
  const twilight = Math.exp(-((state.sunElevation / 0.1) ** 2));

  let zenith = mixHex(NIGHT_ZENITH, DAY_ZENITH, day);
  let horizon = mixHex(mixHex(NIGHT_HORIZON, DAY_HORIZON, day), TWILIGHT_HORIZON, twilight * 0.85);
  const fog = mixHex(mixHex(NIGHT_HORIZON, DAY_HORIZON, day), horizon, 0.45);

  // Heavy weather: wash toward gray, dim everything.
  const gloom = smooth(clamp01((state.cloudiness - 0.4) / 0.6));
  const gray = scaleHex(OVERCAST_TINT, 0.15 + 0.85 * day);
  zenith = mixHex(zenith, gray, gloom * 0.8);
  horizon = mixHex(horizon, gray, gloom * 0.85);

  const sunWarm = mixHex(0xff9d5c, 0xfff3d6, smooth(clamp01((state.sunElevation - 0.05) / 0.5)));
  const sunIntensity =
    smooth(clamp01((state.sunElevation + 0.02) / 0.25)) * (1 - gloom * 0.75) * (1 - state.darkness);
  const ambientLevel = 0.85 * (1 - gloom * 0.45) * (1 - state.darkness * 0.7);

  return {
    zenith,
    horizon,
    fog,
    sun: sunWarm,
    sunIntensity,
    ambientSky: mixHex(scaleHex(0xcfe8ff, 0.16), scaleHex(0xcfe8ff, ambientLevel), day),
    ambientGround: mixHex(
      scaleHex(0x59472e, 0.12),
      scaleHex(0x59472e, 0.55 * (1 - gloom * 0.3)),
      day,
    ),
    starOpacity: (1 - day) * (1 - state.cloudiness * 0.85),
    sunDisc: smooth(clamp01((state.sunElevation + 0.04) / 0.12)),
    moonDisc: state.moonlight,
  };
}

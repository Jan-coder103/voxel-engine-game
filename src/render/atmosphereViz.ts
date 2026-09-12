import * as THREE from 'three';
import { skyPalette, type AtmosphereState } from '../sim/atmosphere';
import type { VoxelMaterialSet } from './voxelMaterial';
import { PrecipSystem } from './rainfx';

/**
 * Atmosphere rendering (Phase 16): the sky dome (gradient, sun, moon,
 * stars, procedural drifting clouds, lightning flash) plus the per-frame
 * application of the atmosphere palette to the voxel shader — sun/moon
 * direction and tint, hemisphere ambient, and weather-thickened fog.
 * The world's flat background color is replaced by the dome; the clear
 * color behind it tracks the fog color as a fallback.
 *
 * At night the voxel shader's single "sun" term is re-aimed at the moon
 * with a faint blue tint, so the world reads as moonlit instead of
 * pitch black (there is no voxel light field yet — Phase 17 territory).
 */
export class AtmosphereViz {
  private readonly dome: THREE.Mesh;
  private readonly domeMaterial: THREE.ShaderMaterial;
  private readonly precip: PrecipSystem;
  private readonly scratchColor = new THREE.Color();
  private windOffset = { x: 0, z: 0 };
  private flash = 0;

  constructor(
    scene: THREE.Scene,
    private readonly materials: VoxelMaterialSet,
    private readonly fogNear: number,
    private readonly fogFar: number,
    precipCapacity = 700,
  ) {
    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uZenith: { value: new THREE.Color(0x87b5e0) },
        uHorizon: { value: new THREE.Color(0xbcd8ef) },
        uSunTint: { value: new THREE.Color(0xfff3d6) },
        uSunDisc: { value: 1 },
        uMoonDisc: { value: 0 },
        uStars: { value: 0 },
        uCloudCoverage: { value: 0.14 },
        uCloudGloom: { value: 0 },
        uWindOffset: { value: new THREE.Vector2(0, 0) },
        uFlash: { value: 0 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), this.domeMaterial);
    this.dome.scale.setScalar(fogFar + 60);
    this.dome.renderOrder = -1;
    this.dome.frustumCulled = false;
    scene.add(this.dome);
    this.precip = new PrecipSystem(scene, precipCapacity);
  }

  get precipCount(): number {
    return this.precip.activeCount;
  }

  /** Current lightning flash level 0–1 (decays over ~¼ s). */
  get flashLevel(): number {
    return this.flash;
  }

  /** A lightning flash (main calls this when the atmosphere strikes). */
  strikeFlash(): void {
    this.flash = 1;
  }

  /**
   * One render frame: scroll the clouds with the wind, decay the flash,
   * re-dress the sky dome, and push the palette into the voxel shader.
   */
  update(atmosphere: AtmosphereState, camera: THREE.Vector3, dt: number, scene: THREE.Scene): void {
    this.windOffset.x += atmosphere.wind.x * dt * 0.05;
    this.windOffset.z += atmosphere.wind.z * dt * 0.05;
    this.flash = Math.max(0, this.flash - dt * 4.5);

    const palette = skyPalette(atmosphere);
    const u = this.domeMaterial.uniforms;
    (u.uSunDir.value as THREE.Vector3).set(
      atmosphere.sunDir.x,
      atmosphere.sunDir.y,
      atmosphere.sunDir.z,
    );
    (u.uMoonDir.value as THREE.Vector3).set(
      atmosphere.moonDir.x,
      atmosphere.moonDir.y,
      atmosphere.moonDir.z,
    );
    (u.uZenith.value as THREE.Color).setHex(palette.zenith);
    (u.uHorizon.value as THREE.Color).setHex(palette.horizon);
    (u.uSunTint.value as THREE.Color).setHex(palette.sun);
    u.uSunDisc.value = palette.sunDisc;
    u.uMoonDisc.value = palette.moonDisc;
    u.uStars.value = palette.starOpacity;
    u.uCloudCoverage.value = atmosphere.cloudiness;
    u.uCloudGloom.value = Math.min(1, atmosphere.darkness * 2 + atmosphere.cloudiness * 0.3);
    (u.uWindOffset.value as THREE.Vector2).set(this.windOffset.x, this.windOffset.z);
    u.uFlash.value = this.flash;

    this.dome.position.copy(camera);

    this.applyToVoxelShader(palette, atmosphere, scene);
    this.precip.update(dt, camera, atmosphere);
  }

  /** Map the palette onto the shared voxel shader uniforms. */
  private applyToVoxelShader(
    palette: ReturnType<typeof skyPalette>,
    atmosphere: AtmosphereState,
    scene: THREE.Scene,
  ): void {
    const shared = this.materials.opaque.uniforms;
    // The shader has one directional term: the sun by day, the moon
    // (faint, blue) when its light dominates. The crossover happens at
    // near-zero intensity, so the swap never visibly pops.
    const moonIntensity = 0.3 * atmosphere.moonlight;
    const sunWins = palette.sunIntensity >= moonIntensity;
    const dir = sunWins ? atmosphere.sunDir : atmosphere.moonDir;
    (shared.uSunDir.value as THREE.Vector3).set(dir.x, dir.y, dir.z);
    this.scratchColor.setHex(palette.sun);
    this.scratchColor.multiplyScalar(sunWins ? palette.sunIntensity : moonIntensity);
    if (!sunWins) this.scratchColor.multiply(MOON_TINT);
    (shared.uSunColor.value as THREE.Color).copy(this.scratchColor);

    (shared.uSkyColor.value as THREE.Color).setHex(palette.ambientSky);
    (shared.uGroundColor.value as THREE.Color).setHex(palette.ambientGround);

    // Fog: weather pulls the far wall in and the near wall out.
    const fog = 1 - atmosphere.fogFactor * 0.45;
    shared.uFogNear.value = this.fogNear * (1 - atmosphere.fogFactor * 0.55);
    shared.uFogFar.value = this.fogFar * fog;
    this.scratchColor.setHex(palette.fog);
    if (this.flash > 0) this.scratchColor.lerp(FLASH_WHITE, this.flash * 0.5);
    (shared.uFogColor.value as THREE.Color).copy(this.scratchColor);
    if (scene.background instanceof THREE.Color) scene.background.copy(this.scratchColor);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.dome);
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    this.precip.dispose(scene);
  }
}

const MOON_TINT = new THREE.Color(0.62, 0.7, 1.0);
const FLASH_WHITE = new THREE.Color(1, 1, 1);

const DOME_VERT = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunTint;
uniform float uSunDisc;
uniform float uMoonDisc;
uniform float uStars;
uniform float uCloudCoverage;
uniform float uCloudGloom;
uniform vec2 uWindOffset;
uniform float uFlash;

varying vec3 vDir;

float hash3(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  // Three octaves: a fourth reads better on stills but costs 33% more
  // per sky pixel, which SwiftShader-class renderers cannot spare.
  float v = 0.5 * noise2(p);
  v += 0.25 * noise2(p * 2.03 + 17.0);
  return v + 0.25 * noise2(p * 4.11 + 47.0);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // Gradient: zenith over horizon, dimming below the horizon line.
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  if (h < 0.0) sky = mix(uHorizon, uHorizon * 0.5, clamp(-h * 3.0, 0.0, 1.0));

  // Sun: disc plus a warm halo.
  float sunD = dot(dir, uSunDir);
  float disc = smoothstep(0.9993, 0.9997, sunD);
  float halo = pow(max(sunD, 0.0), 90.0) * 0.5;
  sky += uSunTint * (disc * 1.6 + halo) * uSunDisc;

  // Moon: a smaller pale disc.
  float moonD = dot(dir, uMoonDir);
  float moon = smoothstep(0.99955, 0.99985, moonD);
  sky += vec3(0.85, 0.88, 1.0) * moon * uMoonDisc * 1.1;

  // Stars: a sparse hash-scattered field, twinkling slightly.
  if (uStars > 0.001 && h > 0.0) {
    vec3 cell = floor(dir * 220.0);
    float star = step(0.9972, hash3(cell));
    float twinkle = 0.55 + 0.45 * hash3(cell + 1.0);
    sky += vec3(0.85, 0.92, 1.0) * star * twinkle * uStars;
  }

  // Clouds: fbm on a dome-projected plane, scrolling with the wind.
  // Skies under ~½-cloudy skip the fbm entirely — the software-GL
  // fallback renders every pixel of this shader on the CPU, and most
  // sessions spend most of their time under clearer skies.
  if (uCloudCoverage > 0.2 && h > 0.02) {
    vec2 uv = dir.xz / (h + 0.18) * 1.4 + uWindOffset;
    float n = fbm(uv * 0.55);
    float mask = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage * 0.55 + 0.08, n);
    vec3 cloudCol = mix(vec3(1.05), vec3(0.4, 0.43, 0.5), uCloudGloom);
    cloudCol += uSunTint * pow(max(sunD, 0.0), 3.0) * 0.3 * uSunDisc;
    float alpha = mask * smoothstep(0.02, 0.16, h);
    sky = mix(sky, cloudCol, alpha * 0.92);
  }

  sky += vec3(1.0) * uFlash;
  gl_FragColor = vec4(sky, 1.0);
  #include <colorspace_fragment>
}
`;

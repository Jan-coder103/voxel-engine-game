import * as THREE from 'three';
import { MATERIALS } from '../voxel/materials';

/**
 * The voxel material shader (Phase 4, variation reworked in Phase 6):
 * per-vertex `materialId` indexes a palette texture (one texel per
 * registered material); lighting (hemisphere + one sun) and fog are
 * computed in-shader, so no scene lights or scene.fog are needed.
 *
 * Per-voxel brightness variation is derived from the fragment's world
 * position (`floor(worldPos − normal/2)` recovers the voxel cell), which
 * stays correct on the greedy mesher's merged quads — a per-vertex
 * voxel-origin attribute would smear across them.
 *
 * Water is the same shader with transparency, no depth write, and both
 * faces visible (swimming under the surface sees it).
 */

export interface VoxelMaterialSet {
  opaque: THREE.ShaderMaterial;
  water: THREE.ShaderMaterial;
  dispose(): void;
}

export interface VoxelMaterialOptions {
  fogNear: number;
  fogFar: number;
  skyColor: number;
}

const VERT = /* glsl */ `
attribute float materialId;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vMaterialId;
varying float vFogDepth;

void main() {
  vNormal = normal;
  vMaterialId = materialId;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uPalette;
uniform float uPaletteSize;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uOpacity;
uniform float uVariation;

varying vec3 vNormal;
varying vec3 vWorldPos;
varying float vMaterialId;
varying float vFogDepth;

float hashVoxel(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void main() {
  vec3 albedo = texture2D(uPalette, vec2((vMaterialId + 0.5) / uPaletteSize, 0.5)).rgb;
  // Recovers the integer voxel cell from the fragment's world position:
  // a face lies on the cell plane offset by normal/2 along its axis, and
  // the in-plane coordinates floor back into the same cell everywhere
  // except the outermost edge pixels.
  vec3 n = normalize(vNormal);
  float variation = hashVoxel(floor(vWorldPos - n * 0.5)) - 0.5;
  albedo *= 1.0 + 2.0 * uVariation * variation;

  float sun = max(dot(n, uSunDir), 0.0);
  vec3 ambient = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 lit = albedo * (ambient + uSunColor * sun);

  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  vec3 color = mix(lit, uFogColor, fog);

  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
}
`;

/** One palette texel per registered material, stored in linear space. */
function createPaletteTexture(): THREE.DataTexture {
  const data = new Uint8Array(MATERIALS.length * 4);
  const color = new THREE.Color();
  MATERIALS.forEach((def, i) => {
    color.setHex(def.color, THREE.SRGBColorSpace);
    data[i * 4] = Math.round(color.r * 255);
    data[i * 4 + 1] = Math.round(color.g * 255);
    data[i * 4 + 2] = Math.round(color.b * 255);
    data[i * 4 + 3] = 255;
  });
  const texture = new THREE.DataTexture(data, MATERIALS.length, 1, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createVoxelMaterials(options: VoxelMaterialOptions): VoxelMaterialSet {
  const palette = createPaletteTexture();

  const sky = new THREE.Color(options.skyColor);
  const shared = {
    uPalette: { value: palette },
    uPaletteSize: { value: MATERIALS.length },
    uSunDir: { value: new THREE.Vector3(0.55, 0.8, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(0xfff3d6).multiplyScalar(1.15) },
    uSkyColor: { value: new THREE.Color(0xcfe8ff).multiplyScalar(0.85) },
    uGroundColor: { value: new THREE.Color(0x59472e).multiplyScalar(0.55) },
    uFogColor: { value: sky },
    uFogNear: { value: options.fogNear },
    uFogFar: { value: options.fogFar },
  };

  const make = (extra: Record<string, { value: unknown }>, transparent: boolean) =>
    new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...shared, ...extra },
      transparent,
      depthWrite: !transparent,
      side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    });

  const opaque = make({ uOpacity: { value: 1 }, uVariation: { value: 0.04 } }, false);
  const water = make({ uOpacity: { value: 0.62 }, uVariation: { value: 0.01 } }, true);

  return {
    opaque,
    water,
    dispose() {
      palette.dispose();
      opaque.dispose();
      water.dispose();
    },
  };
}

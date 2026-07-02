/* ---------------------------------------------------------------------------
 * Procedural PBR materials for the Tiger.
 *
 * - Camouflage: Dunkelgelb base with Olivgrün / Rotbraun blotches (the
 *   standard 1943–44 three-tone scheme), painted onto a canvas.
 * - Zimmerit: the ridged anti-magnetic-mine paste, generated as a bump map
 *   (fine horizontal rows of vertical trowel ridges).
 * - Plus steel/track/rubber utility materials.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { mulberry32 } from '../utils/noise';

export interface TankMaterials {
  /** Hull & turret armor: camo paint over Zimmerit. */
  armor: THREE.MeshStandardMaterial;
  /** Painted steel without Zimmerit (barrel, wheels, hatches, fenders). */
  paint: THREE.MeshStandardMaterial;
  /** Bare dark steel (MGs, sprocket teeth, tools). */
  steel: THREE.MeshStandardMaterial;
  /** Track links: worn manganese steel with rust tint. */
  track: THREE.MeshStandardMaterial;
  /** Dark rubber/grime (periscopes, vision blocks). */
  dark: THREE.MeshStandardMaterial;
  /** Wood for tool handles / jack block. */
  wood: THREE.MeshStandardMaterial;
}

function makeCamoTexture(seed: number): THREE.CanvasTexture {
  const s = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(seed);

  // Dunkelgelb base
  ctx.fillStyle = '#94824f';
  ctx.fillRect(0, 0, s, s);

  // Soft-edged camo blotches drawn as blurred random walks
  const paintBlotches = (color: string, count: number, radius: number) => {
    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < count; i++) {
      let x = rand() * s;
      let y = rand() * s;
      const steps = 4 + Math.floor(rand() * 5);
      for (let j = 0; j < steps; j++) {
        const r = radius * (0.5 + rand() * 0.8);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.5 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        x += (rand() - 0.5) * radius * 2.4;
        y += (rand() - 0.5) * radius * 2.4;
      }
    }
    ctx.restore();
  };
  paintBlotches('#5c6134', 14, 46); // Olivgrün
  paintBlotches('#6d4a2c', 10, 40); // Rotbraun

  // Dust/grime speckle + subtle vertical rain streaks
  const img = ctx.getImageData(0, 0, s, s);
  for (let i = 0; i < s * s; i++) {
    const v = (rand() - 0.5) * 22;
    img.data[i * 4 + 0] += v;
    img.data[i * 4 + 1] += v;
    img.data[i * 4 + 2] += v;
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#2c2418';
  for (let i = 0; i < 240; i++) {
    const x = rand() * s;
    ctx.fillRect(x, rand() * s * 0.5, 1 + rand() * 2, 60 + rand() * 200);
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Zimmerit bump map: rows of short vertical trowel ridges.
 * ~140 rows across the texture ≈ 4–5 cm ridge rows on a hull-sized face.
 */
function makeZimmeritBump(seed: number): THREE.CanvasTexture {
  const s = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(seed);

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, s, s);

  const rowH = 7.3;
  for (let y = 0; y < s; y += rowH) {
    const jitter = (rand() - 0.5) * 2;
    for (let x = 0; x < s; x += 4) {
      // alternating ridge/groove with noise → fine vertical ribbing per row
      const ridge = (Math.floor(x / 4) % 2 === 0 ? 1 : -1) * (0.6 + rand() * 0.4);
      const v = 128 + ridge * 52 + (rand() - 0.5) * 30;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y + jitter, 4, rowH - 1.2);
    }
    // dark groove between rows
    ctx.fillStyle = 'rgb(70,70,70)';
    ctx.fillRect(0, y + rowH - 1.2 + jitter, s, 1.2);
  }

  // occasional chipped patches where the paste has fallen off
  ctx.fillStyle = 'rgb(128,128,128)';
  for (let i = 0; i < 26; i++) {
    ctx.beginPath();
    ctx.ellipse(rand() * s, rand() * s, 6 + rand() * 22, 4 + rand() * 12, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export function createTankMaterials(seed = 77): TankMaterials {
  const camo = makeCamoTexture(seed);
  const zimmerit = makeZimmeritBump(seed + 1);

  const armor = new THREE.MeshStandardMaterial({
    map: camo,
    bumpMap: zimmerit,
    bumpScale: 0.6,
    roughness: 0.82,
    metalness: 0.15,
  });

  const paint = new THREE.MeshStandardMaterial({
    map: camo,
    roughness: 0.66,
    metalness: 0.25,
  });

  const steel = new THREE.MeshStandardMaterial({
    color: 0x3d3d40,
    roughness: 0.55,
    metalness: 0.75,
  });

  const track = new THREE.MeshStandardMaterial({
    color: 0x4b453e,
    roughness: 0.85,
    metalness: 0.55,
  });

  const dark = new THREE.MeshStandardMaterial({
    color: 0x1c1c1c,
    roughness: 0.9,
    metalness: 0.1,
  });

  const wood = new THREE.MeshStandardMaterial({
    color: 0x7a5f3a,
    roughness: 0.9,
    metalness: 0,
  });

  return { armor, paint, steel, track, dark, wood };
}

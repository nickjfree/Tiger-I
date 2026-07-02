/* ---------------------------------------------------------------------------
 * Simple wooden gunnery targets scattered around the spawn.
 * A shell passing near a standing target knocks it over — instant feedback
 * for the ballistics without needing full enemy AI (easy to extend later).
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Terrain } from './Terrain';
import { clamp } from '../utils/math';

interface Target {
  root: THREE.Group;      // planted at ground, yaw only
  panel: THREE.Group;     // tips over around its base when killed
  center: THREE.Vector3;  // world-space hit test center
  alive: boolean;
  fallT: number;          // 0..1 fall animation progress
}

const HIT_RADIUS = 1.6;

export class Targets {
  readonly group = new THREE.Group();
  private readonly targets: Target[] = [];
  destroyed = 0;

  /** HUD callback when a target is destroyed. */
  onDestroyed: ((remaining: number) => void) | null = null;

  constructor(terrain: Terrain) {
    // (angle degrees, range meters) around spawn — mix of ranges for gunnery practice
    const spots: Array<[number, number]> = [
      [10, 90], [-25, 140], [40, 200], [-60, 260], [75, 330], [160, 180], [-130, 240],
    ];

    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6f4d, roughness: 0.9 });
    const face = this.makeFaceMaterial();

    for (const [angDeg, range] of spots) {
      const ang = (angDeg * Math.PI) / 180;
      const x = Math.sin(ang) * range;
      const z = Math.cos(ang) * range;
      const y = terrain.getHeight(x, z);

      const root = new THREE.Group();
      root.position.set(x, y, z);
      root.rotation.y = Math.atan2(-x, -z); // face the spawn point

      const panel = new THREE.Group();
      // support posts
      for (const px of [-0.8, 0.8]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.12), wood);
        post.position.set(px, 1.2, 0);
        post.castShadow = true;
        panel.add(post);
      }
      // board with painted roundel facing the player
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.08), [
        wood, wood, wood, wood, face, wood,
      ]);
      board.position.set(0, 1.9, 0);
      board.castShadow = true;
      panel.add(board);

      root.add(panel);
      this.group.add(root);

      this.targets.push({
        root,
        panel,
        center: new THREE.Vector3(x, y + 1.9, z),
        alive: true,
        fallT: 0,
      });
    }
  }

  private makeFaceMaterial(): THREE.MeshStandardMaterial {
    const s = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = s;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#cfc4a2';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#22201c';
    ctx.lineWidth = 10;
    for (const r of [96, 58]) {
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#a33227';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  }

  /**
   * Test a shell's movement segment (prev → next) against standing targets.
   * Returns the hit position, or null.
   */
  testSegment(prev: THREE.Vector3, next: THREE.Vector3): THREE.Vector3 | null {
    for (const t of this.targets) {
      if (!t.alive) continue;
      // closest point on segment to target center
      const ab = next.clone().sub(prev);
      const len2 = ab.lengthSq();
      const tt = len2 === 0 ? 0 : clamp(t.center.clone().sub(prev).dot(ab) / len2, 0, 1);
      const closest = prev.clone().addScaledVector(ab, tt);
      if (closest.distanceTo(t.center) < HIT_RADIUS) {
        t.alive = false;
        this.destroyed++;
        this.onDestroyed?.(this.targets.length - this.destroyed);
        return closest;
      }
    }
    return null;
  }

  /** Positions for the minimap. */
  getMarkers(): Array<{ x: number; z: number; alive: boolean }> {
    return this.targets.map((t) => ({ x: t.center.x, z: t.center.z, alive: t.alive }));
  }

  update(dt: number): void {
    for (const t of this.targets) {
      if (!t.alive && t.fallT < 1) {
        t.fallT = Math.min(1, t.fallT + dt * 1.6);
        // ease-in fall backwards around the base
        const e = t.fallT * t.fallT;
        t.panel.rotation.x = (-Math.PI / 2 + 0.06) * e;
      }
    }
  }
}

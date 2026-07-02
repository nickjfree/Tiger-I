/* ---------------------------------------------------------------------------
 * Sky, sun, ambient light and fog.
 *
 * The sky is a custom gradient shader on an inverted sphere with an analytic
 * sun disc + glow, so no external assets are needed. The directional light's
 * shadow frustum follows the tank so shadows stay crisp near the action.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';

export class Environment {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3(-0.45, 0.55, 0.35).normalize();

  private readonly sky: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    // --- fog & background haze ---
    const hazeColor = new THREE.Color(0xc9c2a6);
    scene.fog = new THREE.Fog(hazeColor, 140, 950);

    // --- sky dome ---
    this.sky = this.buildSky();
    this.group.add(this.sky);

    // --- lights ---
    this.sun = new THREE.DirectionalLight(0xfff2d8, 3.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -55;
    cam.right = 55;
    cam.top = 55;
    cam.bottom = -55;
    cam.near = 10;
    cam.far = 420;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.15;
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    const hemi = new THREE.HemisphereLight(0xbdd0e8, 0x54503a, 0.75);
    this.group.add(hemi);

    scene.add(this.group);
  }

  private buildSky(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(1600, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x5b7ca8) },
        horizonColor: { value: new THREE.Color(0xcfc6a5) },
        groundColor: { value: new THREE.Color(0x8f8768) },
        sunDir: { value: this.sunDir.clone() },
        sunColor: { value: new THREE.Color(0xfff3d0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 groundColor;
        uniform vec3 sunDir;
        uniform vec3 sunColor;
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float up = dir.y;
          vec3 col;
          if (up >= 0.0) {
            col = mix(horizonColor, topColor, pow(up, 0.55));
          } else {
            col = mix(horizonColor, groundColor, pow(-up, 0.5));
          }
          float d = max(dot(dir, normalize(sunDir)), 0.0);
          // wide warm glow + tight disc
          col += sunColor * pow(d, 12.0) * 0.10;
          col += sunColor * pow(d, 350.0) * 0.55;
          col += sunColor * smoothstep(0.99965, 0.99985, d);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Keep sky centered on the camera and shadow box centered on the tank. */
  update(cameraPos: THREE.Vector3, tankPos: THREE.Vector3): void {
    this.sky.position.copy(cameraPos);
    this.sun.position.copy(tankPos).addScaledVector(this.sunDir, 180);
    this.sun.target.position.copy(tankPos);
  }
}

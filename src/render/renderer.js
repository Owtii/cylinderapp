import * as THREE from 'three/webgpu';
import { mix, vec3, screenUV, uniform, smoothstep } from 'three/tsl';
import { TUNING } from '../tuning.js';

/**
 * Renderer, scene, sky and lighting.
 *
 * Uses WebGPURenderer, which transparently falls back to a WebGL2 backend when
 * WebGPU is unavailable — so the game runs everywhere while using the WebGPU
 * path where it exists.
 */
export class Renderer {
  /** @param {HTMLElement} container element that owns the canvas */
  constructor(container) {
    this.container = container;
    this.canvas = null;
    this.forcedWebGL = false;
    this._createRenderer(false);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xb2c6d6, TUNING.gfx.fogNear, TUNING.gfx.fogFar);

    this.camera = new THREE.PerspectiveCamera(
      TUNING.camera.fovMin,
      1,
      TUNING.camera.near,
      TUNING.camera.far,
    );
    this.camera.position.set(0, 6, 14);

    this.quality = 'high';
    this._buildSky();
    this._buildLights();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
  }

  /**
   * A canvas can only ever hand out one kind of context, so falling back from
   * WebGPU to WebGL2 means throwing the canvas away and making a new one.
   */
  _createRenderer(forceWebGL) {
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    const canvas = document.createElement('canvas');
    canvas.id = 'scene';
    this.container.insertBefore(canvas, this.container.firstChild);
    this.canvas = canvas;
    this.forcedWebGL = forceWebGL;
    this.renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      alpha: false,
      forceWebGL,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x0b0d10, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = TUNING.gfx.shadowsDefault;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  async init() {
    await this.renderer.init();

    // three only falls back when the *adapter* is missing. A WebGPU stack that
    // reports an adapter and then throws on the first render pass (older Dawn
    // builds against a newer three) would otherwise be a black screen forever, so
    // probe with a real render before committing to the backend.
    if (!this.forcedWebGL) {
      try {
        this._onResize();
        this.renderer.render(this.probeScene(), this.camera);
      } catch (err) {
        console.warn('WebGPU render failed, falling back to WebGL2:', err);
        try { this.renderer.dispose(); } catch { /* already dead */ }
        this._createRenderer(true);
        await this.renderer.init();
      }
    }

    this._onResize();
    this.backend = this.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
    return this.backend;
  }

  /** Minimal scene used only for the backend probe. */
  probeScene() {
    if (!this._probe) {
      this._probe = new THREE.Scene();
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicNodeMaterial({ color: 0x000000 }),
      );
      m.position.set(0, 0, -5);
      this._probe.add(m);
    }
    return this._probe;
  }

  _buildSky() {
    // Cheap two-stop vertical gradient. Screen-space is fine: the camera pitch is
    // nearly constant, and it costs one lerp per pixel.
    this.uHorizon = uniform(new THREE.Color(0xc3d5e2));
    this.uZenith = uniform(new THREE.Color(0x36567a));
    // screenUV.y is 0 at the TOP of the frame, so the zenith is the low end and
    // the horizon the high end. Getting this backwards puts a dark band along the
    // horizon and washes out the sky overhead, which reads as fog rather than sky.
    const t = smoothstep(0.10, 0.72, screenUV.y);
    this.scene.backgroundNode = mix(this.uZenith, this.uHorizon, t).mul(vec3(1, 1, 1));
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xcfe3f2, 0x39312a, 1.15);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
    sun.position.set(38, 58, 26);
    sun.castShadow = TUNING.gfx.shadowsDefault;
    sun.shadow.mapSize.set(TUNING.gfx.shadowMapSize, TUNING.gfx.shadowMapSize);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 220;
    const s = 62;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.035;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // A dim fill from the opposite side stops the shadowed faces going flat black.
    const fill = new THREE.DirectionalLight(0x7fa6cc, 0.5);
    fill.position.set(-30, 22, -18);
    this.scene.add(fill);
    this.fill = fill;
  }

  /** Keep the shadow frustum tight around the player instead of the whole world. */
  followLights(x, y, z) {
    const sun = this.sun;
    sun.target.position.set(x, y, z);
    sun.target.updateMatrixWorld();
    sun.position.set(x + 38, y + 58, z + 26);
  }

  setQuality(q) {
    this.quality = q;
    const shadows = q === 'high' && TUNING.gfx.shadowsDefault;
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(
      q === 'high' ? TUNING.gfx.shadowMapSize : 1024,
      q === 'high' ? TUNING.gfx.shadowMapSize : 1024,
    );
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this._onResize();
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cap = this.quality === 'high'
      ? TUNING.gfx.pixelRatioCap
      : TUNING.gfx.lowQualityPixelRatio;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
    if (this.onResize) this.onResize(w, h);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    this.renderer.dispose();
  }
}

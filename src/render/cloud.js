/**
 * 3D photoemission cloud.
 *
 * A pump pulse ejects electrons from the sample surface; after a flight time
 * t = 1 they form a stack of glowing energy shells in vacuum. In-plane momentum
 * sets the emission angle, kinetic energy sets the flight radius.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { sampleColormap } from '../colormaps.js';
import { sampleVoxels, mulberry32 } from '../data/volume.js';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;

  uniform float uGrow;
  uniform float uFlight;
  uniform float uSize;
  uniform float uDpr;
  uniform float uHeight;
  uniform float uExposure;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    vec3 p = position * uFlight * uGrow;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uSize * uDpr * (uHeight / 900.0) * (6.0 / max(0.6, -mvPosition.z));
    vAlpha = aAlpha * uExposure * smoothstep(0.0, 0.08, uGrow);
    vColor = color;
    vSeed = aSeed;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q) * 2.0;
    if (d > 1.0) discard;
    float halo = exp(-d * d * 2.9);
    float core = exp(-d * d * 13.0);
    float spark = 0.86 + 0.28 * fract(vSeed * 7.77);
    float a = halo * vAlpha;
    vec3 c = vColor * (0.72 + 0.85 * core) * spark;
    gl_FragColor = vec4(c * a, a);
  }
`;

const GRID_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GRID_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uOpacity;
  uniform float uPulse;

  void main() {
    vec2 p = (vUv - 0.5) * 6.0;
    float r = length(p);
    float ang = atan(p.y, p.x);

    float rings = 1.0 - smoothstep(0.0, 0.012, abs(fract(r / 0.5 + 0.5) - 0.5) * 0.5);
    float spokes = 1.0 - smoothstep(0.0, 0.010, abs(fract(ang / 6.2831853 * 24.0 + 0.5) - 0.5) * 6.2831853 * r / 24.0);
    float fade = smoothstep(3.0, 0.25, r);
    float grid = (rings * 0.55 + spokes * 0.25) * fade;

    // injection site
    float site = exp(-r * r * 900.0) * 1.4;
    float halo = exp(-r * r * 60.0) * 0.12;

    // pulse ring
    float wave = exp(-pow((r - uPulse * 2.4) / 0.035, 2.0)) * step(0.001, uPulse) * (1.0 - uPulse) * 0.25;

    vec3 col = vec3(0.36, 0.62, 0.62) * grid;
    col += vec3(0.95, 0.9, 0.72) * (site + halo);
    col += vec3(0.5, 0.9, 0.85) * wave;
    float a = clamp(grid * 0.55 + site + halo, 0.0, 1.0);
    gl_FragColor = vec4(col * uOpacity, a * uOpacity);
  }
`;

const RING_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uOpacity;
  uniform vec3 uColor;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = smoothstep(0.0, 0.2, 1.0 - r) * smoothstep(0.85, 0.97, r);
    gl_FragColor = vec4(uColor * a * uOpacity, a * uOpacity);
  }
`;

const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,248,228,1)');
  g.addColorStop(0.18, 'rgba(255,238,200,0.85)');
  g.addColorStop(0.45, 'rgba(180,230,220,0.25)');
  g.addColorStop(1, 'rgba(120,200,210,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class ElectronCloud {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.volume = null;
    this.settings = null;
    this.size = { w: 512, h: 512 };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.reveal = { playing: false, raf: 0, start: 0 };
    this.active = true;
    this.pointCount = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1.4, -2.8, 2.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0.72);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 7.5;
    this.controls.minPolarAngle = 0.06;
    this.controls.maxPolarAngle = 1.48;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.42;
    this.controls.rotateSpeed = 0.7;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.3, 0.5, 0.55);
    this.composer.addPass(this.bloomPass);

    this.pointUniforms = {
      uGrow: { value: 1 },
      uFlight: { value: 1 },
      uSize: { value: 1.1 },
      uDpr: { value: this.dpr },
      uHeight: { value: 512 },
      uExposure: { value: 1.0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.pointUniforms,
      transparent: true,
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this.geometry = null;
    this.points = null;

    this.gridUniforms = { uOpacity: { value: 0.9 }, uPulse: { value: 0 } };
    this.grid = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShaderMaterial({
        vertexShader: GRID_VERT,
        fragmentShader: GRID_FRAG,
        uniforms: this.gridUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    this.grid.position.z = -0.004;
    this.grid.renderOrder = -2;
    this.scene.add(this.grid);

    // soft ground glow
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4.8, 4.8),
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            float a = smoothstep(1.0, 0.0, r);
            a = pow(a, 3.0) * 0.09;
            gl_FragColor = vec4(vec3(0.18, 0.34, 0.36) * a, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      })
    );
    this.ground.position.z = -0.006;
    this.ground.renderOrder = -3;
    this.scene.add(this.ground);

    // pulse rings
    this.rings = [];
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color(i ? '#8fe0d2' : '#f1e6c6') },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.965, 1.0, 180), mat);
      ring.position.z = 0.002;
      ring.scale.setScalar(0.05);
      ring.visible = false;
      this.scene.add(ring);
      this.rings.push(ring);
    }

    // laser pulse
    this.beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff2d0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.04, 1.7, 18, 1, true), this.beamMat);
    this.beam.rotation.x = Math.PI / 2;
    this.beam.position.z = -0.85;
    this.scene.add(this.beam);

    this.core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.5,
        color: 0xfff4dc,
      })
    );
    this.core.scale.setScalar(0.42);
    this.core.position.set(0, 0, 0.01);
    this.scene.add(this.core);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.size = { w, h };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pointUniforms.uDpr.value = this.dpr;
    this.pointUniforms.uHeight.value = h;
    if (this.pointCount) this.frame();
  }

  buildPoints(volume, settings) {
    this.volume = volume;
    this.settings = settings;
    const e0 = volume.energyIndex(settings.energy[0]);
    const e1 = volume.energyIndex(settings.energy[1]);
    const samples = sampleVoxels(volume, {
      e0,
      e1,
      gamma: 0.8,
      count: settings.density,
      seed: 923,
    });
    const n = samples.count;
    if (!n) return;
    const rng = mulberry32(6113);

    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    const seed = new Float32Array(n);

    const { kxMin, kxMax, kyMin, kyMax } = volume;
    const invX = 1 / Math.max(1e-9, (kxMax - kxMin) * 0.5);
    const invY = 1 / Math.max(1e-9, (kyMax - kyMin) * 0.5);
    const alphaMax = (settings.cone * Math.PI) / 180;
    this.coneRad = alphaMax;
    const cmap = settings.colormap;
    const loE = settings.energy[0];
    const hiE = settings.energy[1];
    const invE = 1 / Math.max(1e-9, hiE - loE);

    for (let i = 0; i < n; i++) {
      const kx = samples.kx[i];
      const ky = samples.ky[i];
      const ebRel = Math.min(1, Math.max(0, (samples.eb[i] - loE) * invE));
      const I = samples.intensity[i];

      const nx = (kx - kxMin) * invX - 1;
      const ny = (ky - kyMin) * invY - 1;
      let kNorm = Math.hypot(nx, ny) / 1.04;
      if (kNorm > 1.08) kNorm = 1.08;

      const phi = Math.atan2(ny, nx) + gaussian(rng) * 0.004;
      const alphaAngle = alphaMax * Math.pow(Math.min(1.06, kNorm), 1.08) + gaussian(rng) * 0.0035;

      // kinetic energy grows toward the Fermi level
      const vNorm = Math.sqrt(Math.max(0.05, 1 - 0.88 * ebRel));
      let R = 0.34 + 1.16 * vNorm;
      R *= 1 + gaussian(rng) * 0.035 * (0.5 + ebRel);

      const sa = Math.sin(alphaAngle);
      const ca = Math.cos(alphaAngle);
      const idx = i * 3;
      pos[idx] = R * sa * Math.cos(phi);
      pos[idx + 1] = R * sa * Math.sin(phi);
      pos[idx + 2] = R * ca;

      const t = Math.min(1, Math.max(0, 0.012 + ebRel * 0.976));
      const c = sampleColormap(cmap, t);
      const lum = 0.86 + rng() * 0.3;
      col[idx] = Math.min(1.2, c[0] * lum);
      col[idx + 1] = Math.min(1.2, c[1] * lum);
      col[idx + 2] = Math.min(1.2, c[2] * lum);

      size[i] = 1.3 + Math.pow(rng(), 1.8) * 2.8;
      alpha[i] = (0.024 + rng() * 0.058) * (0.4 + 0.6 * Math.pow(Math.min(1, I), 0.3));
      seed[i] = rng();
    }

    this.disposePoints();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.6), 2.2);

    this.geometry = geo;
    this.pointCount = n;
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.pointUniforms.uGrow.value = 1;
    this.frame();
    this.render();
  }

  disposePoints() {
    if (this.points) {
      this.scene.remove(this.points);
      this.points = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    this.pointCount = 0;
  }

  setFlight(value, frame = false) {
    this.pointUniforms.uFlight.value = value;
    if (frame) this.frame(value);
    this.render();
  }

  /** Keep the whole luminous cap inside the camera window as t changes. */
  frame(t = this.pointUniforms.uFlight.value) {
    const R = 1.5 * t;
    const halfW = R * Math.sin(this.coneRad || 0.66) * 1.16;
    const halfH = R * 0.8;
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.25, this.camera.aspect));
    const fitW = halfW / Math.max(1e-4, Math.tan(hHalf));
    const fitH = halfH / Math.max(1e-4, Math.tan(vHalf));
    const dist = Math.max(fitW, fitH) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(2.15, -2.85, 1.0);
    dir.normalize();
    this.controls.target.set(0, 0, 0.48 * R);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  setPointSize(value) {
    this.pointUniforms.uSize.value = value;
  }

  setExposure(value) {
    this.pointUniforms.uExposure.value = value;
    this.render();
  }

  setAutoRotate(value) {
    this.controls.autoRotate = value;
  }

  setGrid(visible) {
    this.grid.visible = visible;
    this.ground.visible = visible;
  }

  setActive(active) {
    this.active = active;
    if (active) this.render();
  }

  replay() {
    cancelAnimationFrame(this.reveal.raf);
    const start = performance.now();
    this.reveal.playing = true;
    this.reveal.start = start;
    this.pointUniforms.uGrow.value = 0;
    this.core.material.opacity = 1;
    this.beamMat.opacity = 0.85;

    const step = (now) => {
      const t = Math.min(1, (now - start) / 2400);
      const ease = 1 - Math.pow(1 - t, 3);
      this.pointUniforms.uGrow.value = ease;
      this.beamMat.opacity = Math.max(0, 0.9 - t * 4.2);
      this.core.material.opacity = Math.max(0.35, 1 - t * 1.6);
      this.gridUniforms.uPulse.value = t;
      for (let i = 0; i < this.rings.length; i++) {
        const ring = this.rings[i];
        const rt = Math.max(0, Math.min(1, (t - i * 0.12) / 0.9));
        ring.visible = rt > 0 && rt < 1;
        ring.scale.setScalar(0.06 + rt * 2.4);
        ring.material.uniforms.uOpacity.value = (1 - rt) * 0.45;
      }
      this.render();
      if (t < 1) {
        this.reveal.raf = requestAnimationFrame(step);
      } else {
        this.reveal.playing = false;
        this.gridUniforms.uPulse.value = 0;
        this.rings.forEach((r) => (r.visible = false));
        this.beamMat.opacity = 0;
        this.core.material.opacity = 0.55;
        this.render();
      }
    };
    this.reveal.raf = requestAnimationFrame(step);
  }

  tick() {
    if (!this.active) return;
    if (!this.container.clientWidth || !this.container.clientHeight) return;
    this.controls.update();
    this.gridUniforms.uPulse.value *= 0.985;
    this.render();
  }

  render() {
    this.composer.render();
  }

  exportPNG(scale = 2, bg = '#06070a') {
    const { w, h } = this.size;
    const oldDpr = this.dpr;
    const targetW = Math.min(3840, Math.floor(w * scale));
    const ratio = targetW / Math.max(1, w);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.pointUniforms.uDpr.value = ratio;
    this.pointUniforms.uHeight.value = h;
    this.render();
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const url = out.toDataURL('image/png');
    this.renderer.setPixelRatio(oldDpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(oldDpr);
    this.composer.setSize(w, h);
    this.pointUniforms.uDpr.value = oldDpr;
    this.pointUniforms.uHeight.value = h;
    this.render();
    return url;
  }

  dispose() {
    cancelAnimationFrame(this.reveal.raf);
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.disposePoints();
    this.controls.dispose();
    this.renderer.dispose();
  }
}

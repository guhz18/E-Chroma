/**
 * 2D electron chromatogram.
 *
 * A WebGL point-splat pass accumulates millions of soft, radially streaked
 * pigment grains into a half-float buffer; a composite pass tone-maps the
 * result, paints the specimen background / lattice, and cuts the circular plate.
 */

import * as THREE from 'three';
import { sampleColormap } from '../colormaps.js';
import { sampleVoxels, mulberry32 } from '../data/volume.js';

const VERT = /* glsl */ `
  attribute vec2 iPos;
  attribute vec2 iDir;
  attribute vec2 iSize;
  attribute vec3 iColor;
  attribute float iAlpha;
  attribute float iSeed;

  uniform float uReveal;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    vec2 p = position.xy;
    vec2 dir = normalize(iDir + vec2(1e-5, 0.0));
    vec2 nor = vec2(-dir.y, dir.x);
    vec2 world = iPos + dir * (p.x * iSize.x) + nor * (p.y * iSize.y);

    float d = length(iPos);
    vUv = p * 2.0;
    vColor = iColor;
    vSeed = iSeed;
    vAlpha = iAlpha * step(d, uReveal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSeed;

  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;

    float across = vUv.y;
    float along = vUv.x;
    float body = exp(-(across * across * 3.6 + along * along * 1.35));
    float core = exp(-(across * across * 14.0 + along * along * 5.0));
    float tail = mix(0.45, 1.0, smoothstep(-1.0, 1.0, along));
    float a = body * tail * vAlpha;

    float spark = fract(vSeed * 13.317);
    vec3 c = vColor * (0.72 + 0.9 * core) * (0.82 + 0.34 * spark);
    gl_FragColor = vec4(c * a, a);
  }
`;

const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const POST_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tPoints;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform vec2 uRes;
  uniform vec3 uBgColor;
  uniform float uBgStyle;      // 0 void, 1 solid, 2 paper
  uniform float uInk;          // 1 = subtractive pigment on light paper
  uniform float uLattice;      // 0 none, 1 square, 2 hex, 3 honeycomb
  uniform float uLatticeOpacity;
  uniform float uFrame;
  uniform float uExposure;
  uniform float uSat;
  uniform float uReveal;
  uniform float uFlash;
  uniform float uDrop;
  uniform float uTime;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float lineMask(float x, float w) {
    return 1.0 - smoothstep(0.0, w, abs(fract(x + 0.5) - 0.5));
  }

  vec3 paperBase() {
    return vec3(0.905, 0.878, 0.812);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);

    vec3 bg;
    if (uBgStyle > 1.5) {
      float fib = hash21(floor(vUv * uRes * 0.55));
      bg = paperBase() * (0.975 + 0.025 * fib);
      bg *= 1.0 - 0.10 * smoothstep(0.35, 1.0, r);
    } else if (uBgStyle > 0.5) {
      bg = uBgColor;
    } else {
      float g = smoothstep(1.25, 0.0, r);
      bg = mix(uBgColor * 0.55, uBgColor * 1.9 + vec3(0.004, 0.006, 0.012), g);
      // faint cold nebula
      bg += vec3(0.008, 0.010, 0.020) * smoothstep(0.3, 0.9, 0.5 + 0.5 * sin(p.x * 2.1 + p.y * 1.4));
      // dust of stars
      vec2 sp = vUv * 260.0;
      vec2 id = floor(sp);
      vec2 f = fract(sp) - 0.5;
      float h = hash21(id);
      float star = step(0.986, h) * exp(-dot(f, f) * 34.0);
      bg += vec3(0.55, 0.68, 0.9) * star * 0.18;
    }

    // ────────────────────────────────────────────────────────────
    float latOver = 0.0;
    vec3 latColor = vec3(0.0);
    if (uLattice > 0.5) {
      vec2 q = p * 11.5;
      float d = 1e5;
      if (uLattice < 1.5) {
        d = min(abs(fract(q.x + 0.5) - 0.5), abs(fract(q.y + 0.5) - 0.5));
      } else if (uLattice < 2.5) {
        d = min(
          abs(fract(q.x + 0.5) - 0.5),
          min(
            abs(fract(0.5 * q.x + 0.8660254 * q.y + 0.5) - 0.5),
            abs(fract(0.5 * q.x - 0.8660254 * q.y + 0.5) - 0.5)
          )
        );
      } else {
        vec2 s = vec2(1.0, 1.7320508);
        vec2 a = mod(q, s) - s * 0.5;
        vec2 b = mod(q - s * 0.5, s) - s * 0.5;
        vec2 gv = dot(a, a) < dot(b, b) ? a : b;
        float hd = max(abs(gv.x) * 0.8660254 + abs(gv.y) * 0.5, abs(gv.y));
        d = abs(hd - 0.42);
      }
      float w = uLattice < 1.5 ? 0.022 : 0.026;
      float grid = 1.0 - smoothstep(0.0, w, d);
      float fade = smoothstep(1.0, 0.15, r) * 0.85 + 0.15;
      vec3 lineCol = mix(vec3(0.66, 0.78, 0.86), vec3(0.16, 0.15, 0.12), uInk);
      latOver = grid * fade;
      latColor = lineCol;
      bg = mix(bg, lineCol, grid * uLatticeOpacity * 0.34 * fade);

      // lattice sites
      if (uLattice > 1.5) {
        float dots = 1.0 - smoothstep(0.05, 0.09, length(fract(q + 0.5) - 0.5));
        bg += lineCol * dots * uLatticeOpacity * 0.18;
      }
    }

    // ────────────────────────────────────────────────────────────
    vec2 tx = 1.5 / uRes;
    vec4 src = texture2D(tPoints, vUv) * 0.4;
    src += texture2D(tPoints, vUv + vec2(tx.x, 0.0)) * 0.15;
    src += texture2D(tPoints, vUv - vec2(tx.x, 0.0)) * 0.15;
    src += texture2D(tPoints, vUv + vec2(0.0, tx.y)) * 0.15;
    src += texture2D(tPoints, vUv - vec2(0.0, tx.y)) * 0.15;
    float cov = src.a;
    vec3 avg = src.rgb / max(cov, 1e-4);
    vec3 col;

    if (uInk > 0.5) {
      float a = 1.0 - exp(-cov * 1.6);
      vec3 pigment = clamp(avg, 0.0, 1.0);
      col = bg * (1.0 - a * (1.0 - pigment) * 0.92);
      col += pigment * a * 0.05;
      col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat);
    } else {
      vec3 glow = texture2D(tBloom, vUv).rgb * uBloom;
      vec3 lit = bg + src.rgb * uExposure + glow;
      lit = vec3(1.0) - exp(-lit * 1.25);
      lit = mix(vec3(dot(lit, vec3(0.299, 0.587, 0.114))), lit, uSat);
      col = lit;
    }

    // let the crystal grid read through the pigment
    col = mix(col, latColor, latOver * uLatticeOpacity * 0.16);

    // injection drop
    float core = exp(-r * r * 2600.0);
    float halo = exp(-r * r * 38.0);
    col += (core * 1.25 + halo * 0.09) * uDrop * vec3(1.0, 0.95, 0.84);

    // expanding meniscus
    float wave = exp(-pow((r - uReveal) / 0.007, 2.0));
    col += wave * uFlash * vec3(1.0, 0.94, 0.8) * 0.65;

    // ────────────────────────────────────────────────────────────
    float mask = 1.0 - smoothstep(0.994, 1.0, r);

    if (uFrame > 0.5) {
      float ang = atan(p.y, p.x);
      float tickCoord = ang / 6.2831853 * 72.0;
      float f = abs(fract(tickCoord + 0.5) - 0.5);
      float thick = 0.028;
      float ringBand = smoothstep(0.968, 0.974, r) * (1.0 - smoothstep(0.9885, 0.992, r));
      float ticks = (1.0 - smoothstep(0.0, thick, f)) * ringBand;
      float major = 1.0 - smoothstep(0.0, thick * 2.3, f);
      ticks *= mix(0.55, 1.0, major);
      vec3 tickCol = mix(vec3(0.92, 0.88, 0.76), vec3(0.12, 0.11, 0.09), uInk);
      col = mix(col, tickCol, ticks * 0.42);

      float rim = exp(-pow((r - 0.9945) / 0.0016, 2.0));
      col += rim * mix(vec3(0.95, 0.88, 0.7), vec3(0.15, 0.13, 0.1), uInk) * 0.5;

      float outer = exp(-pow((r - 1.006) / 0.0035, 2.0));
      col += outer * mix(vec3(0.7, 0.78, 0.9), vec3(0.2, 0.18, 0.14), uInk) * 0.18;
    }

    // vignette + grain
    col *= 1.0 - 0.22 * pow(clamp(r, 0.0, 1.0), 2.4);
    float grain = hash21(vUv * uRes + uTime * 0.13) - 0.5;
    col += grain * (uInk > 0.5 ? 0.018 : 0.024);

    gl_FragColor = vec4(col * mask, mask);
  }
`;

const THRESHOLD_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float k = smoothstep(0.10, 0.42, l);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uDir;

  void main() {
    vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
    sum += texture2D(tDiffuse, vUv + uDir * 1.384615) * 0.316216;
    sum += texture2D(tDiffuse, vUv - uDir * 1.384615) * 0.316216;
    sum += texture2D(tDiffuse, vUv + uDir * 3.230769) * 0.070270;
    sum += texture2D(tDiffuse, vUv - uDir * 3.230769) * 0.070270;
    gl_FragColor = sum;
  }
`;

const QUAD_POS = new Float32Array([
  -0.5, -0.5, 0,
  0.5, -0.5, 0,
  0.5, 0.5, 0,
  -0.5, 0.5, 0,
]);

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Chromatogram {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.settings = null;
    this.volume = null;
    this.size = 512;
    this.dpr = Math.min((window.devicePixelRatio || 1) * 1.8, 2.8);
    this.reveal = { start: 0, playing: false, raf: 0 };
    this.needsRender = false;

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
    this.camera = new THREE.OrthographicCamera(-1.07, 1.07, 1.07, -1.07, 0.1, 10);
    this.camera.position.z = 2;

    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;

    this.bloomA = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.bloomB = this.bloomA.clone();
    this.bloomA.texture.colorSpace = THREE.NoColorSpace;
    this.bloomB.texture.colorSpace = THREE.NoColorSpace;

    this.fsScene = new THREE.Scene();
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.fsMesh.frustumCulled = false;
    this.fsScene.add(this.fsMesh);

    this.thresholdMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: THRESHOLD_FRAG,
      uniforms: { tDiffuse: { value: this.rt.texture } },
      depthTest: false,
      depthWrite: false,
    });
    this.blurH = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: this.bloomA.texture },
        uDir: { value: new THREE.Vector2(1 / 256, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurV = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tDiffuse: { value: this.bloomB.texture },
        uDir: { value: new THREE.Vector2(0, 1 / 256) },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.pointUniforms = { uReveal: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.pointUniforms,
      transparent: true,
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
    this.mesh = null;
    this.instanceCount = 0;

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postUniforms = {
      tPoints: { value: this.rt.texture },
      tBloom: { value: this.bloomA.texture },
      uBloom: { value: 0.55 },
      uRes: { value: new THREE.Vector2(512, 512) },
      uBgColor: { value: new THREE.Color('#06070a') },
      uBgStyle: { value: 0 },
      uInk: { value: 0 },
      uLattice: { value: 1 },
      uLatticeOpacity: { value: 0.3 },
      uFrame: { value: 1 },
      uExposure: { value: 1.1 },
      uSat: { value: 1.08 },
      uReveal: { value: 1 },
      uFlash: { value: 0 },
      uDrop: { value: 1 },
      uTime: { value: 0 },
    };
    this.postMaterial = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: this.postUniforms,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  resize() {
    const cs = getComputedStyle(this.container);
    const w = this.container.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    const h = this.container.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    const size = Math.max(120, Math.floor(Math.min(w, h)));
    this.size = size;
    if (this.canvas.parentElement) {
      this.canvas.parentElement.style.width = `${size}px`;
      this.canvas.parentElement.style.height = `${size}px`;
    }
    this.dpr = Math.min((window.devicePixelRatio || 1) * 1.8, 2.8);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(size, size, false);
    const bw = Math.floor(size * this.dpr);
    const bh = Math.floor(size * this.dpr);
    this.rt.setSize(bw, bh);
    const qw = Math.max(2, Math.floor(bw / 2));
    const qh = Math.max(2, Math.floor(bh / 2));
    this.bloomA.setSize(qw, qh);
    this.bloomB.setSize(qw, qh);
    this.blurH.uniforms.uDir.value.set(1 / qw, 0);
    this.blurV.uniforms.uDir.value.set(0, 1 / qh);
    this.postUniforms.uRes.value.set(bw, bh);
    this.render();
  }

  setBackground({ style, color, lattice, latticeOpacity, frame }) {
    const isPaper = style === 'paper';
    const isSolid = style === 'solid';
    this.postUniforms.uBgStyle.value = isPaper ? 2 : isSolid ? 1 : 0;
    this.postUniforms.uBgColor.value.set(color);
    const lum = 0.2126 * this.postUniforms.uBgColor.value.r
      + 0.7152 * this.postUniforms.uBgColor.value.g
      + 0.0722 * this.postUniforms.uBgColor.value.b;
    this.postUniforms.uInk.value = isPaper || lum > 0.55 ? 1 : 0;
    this.postUniforms.uLattice.value = lattice === 'square' ? 1 : lattice === 'hex' ? 2 : lattice === 'honeycomb' ? 3 : 0;
    this.postUniforms.uLatticeOpacity.value = latticeOpacity;
    this.postUniforms.uFrame.value = frame ? 1 : 0;
    this.render();
  }

  setExposure(value) {
    this.postUniforms.uExposure.value = value;
    this.render();
  }

  buildPoints(volume, settings) {
    this.volume = volume;
    this.settings = settings;
    const e0 = volume.energyIndex(settings.energy[0]);
    const e1 = volume.energyIndex(settings.energy[1]);
    const targetCount = Math.round(settings.density);
    const samples = sampleVoxels(volume, {
      e0,
      e1,
      gamma: settings.gamma ?? 0.82,
      count: targetCount,
      seed: 1429,
    });
    const n = samples.count;
    const rng = mulberry32(7731);

    const iPos = new Float32Array(n * 2);
    const iDir = new Float32Array(n * 2);
    const iSize = new Float32Array(n * 2);
    const iColor = new Float32Array(n * 3);
    const iAlpha = new Float32Array(n);
    const iSeed = new Float32Array(n);

    const { kxMin, kxMax, kyMin, kyMax } = volume;
    const invX = 1 / Math.max(1e-9, (kxMax - kxMin) * 0.5);
    const invY = 1 / Math.max(1e-9, (kyMax - kyMin) * 0.5);
    const sep = settings.separation;
    const twist = settings.twist;
    const diff = settings.diffusion;
    const streak = settings.streak;
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
      kNorm = kNorm > 1.08 ? 1.08 : kNorm;

      const retention = 0.04 + 0.87 * Math.pow(1 - ebRel, 1.15);
      const proj = 0.16 + 0.84 * kNorm;
      let rad = sep * retention + (1 - sep) * proj;

      // radial diffusion, wider for fast (low Eb) electrons
      const sigma = 0.0045 * diff * (0.55 + 0.7 * (1 - ebRel)) + 0.0018;
      rad += gaussian(rng) * sigma;
      rad = Math.max(0.018, Math.min(1.0, rad));

      let th = Math.atan2(ny, nx);
      th += twist * (ebRel - 0.45) * 1.45 + (rng() - 0.5) * 0.007;
      const cs = Math.cos(th);
      const sn = Math.sin(th);

      const idx2 = i * 2;
      iPos[idx2] = rad * cs;
      iPos[idx2 + 1] = rad * sn;
      iDir[idx2] = cs;
      iDir[idx2 + 1] = sn;

      const base = 0.0054 + Math.pow(rng(), 2.0) * 0.0115;
      const len = base * (0.55 + streak * 0.55) * (0.8 + 0.4 * Math.min(1, I));
      const wid = base * (1.02 + rng() * 0.34);
      iSize[idx2] = len;
      iSize[idx2 + 1] = wid;

      const t = Math.min(1, Math.max(0, 0.012 + ebRel * 0.976));
      const c = sampleColormap(cmap, t);
      const lum = 0.88 + rng() * 0.2;
      const spark = rng() < 0.006 ? 0.2 : 0;
      const idx3 = i * 3;
      iColor[idx3] = Math.min(1.2, c[0] * lum + spark);
      iColor[idx3 + 1] = Math.min(1.2, c[1] * lum + spark);
      iColor[idx3 + 2] = Math.min(1.2, c[2] * lum + spark);

      const radialWeight = 0.16 + 0.84 * Math.pow(Math.max(0.02, rad), 0.9);
      iAlpha[i] = (0.045 + rng() * 0.08) * radialWeight * (0.42 + 0.58 * Math.pow(Math.min(1, I), 0.35));
      iSeed[i] = rng();
    }

    this.disposePoints();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 2));
    geo.setAttribute('iDir', new THREE.InstancedBufferAttribute(iDir, 2));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
    geo.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(iAlpha, 1));
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);

    this.geometry = geo;
    this.instanceCount = n;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.postUniforms.uReveal.value = 1;
    this.pointUniforms.uReveal.value = 1;
    this.render();
  }

  disposePoints() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    this.instanceCount = 0;
  }

  replay() {
    cancelAnimationFrame(this.reveal.raf);
    const start = performance.now();
    this.reveal.start = start;
    this.reveal.playing = true;
    this.postUniforms.uDrop.value = 1;
    this.postUniforms.uFlash.value = 0;

    const step = (now) => {
      const t = Math.min(1, (now - start) / 2600);
      const ease = 1 - Math.pow(1 - t, 3);
      this.postUniforms.uReveal.value = ease;
      this.pointUniforms.uReveal.value = ease;
      this.postUniforms.uFlash.value = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.75 * 0.9;
      this.postUniforms.uDrop.value = Math.max(0, 1 - t * 3.2);
      this.postUniforms.uTime.value = (now - start) / 1000;
      this.render();
      if (t < 1) {
        this.reveal.raf = requestAnimationFrame(step);
      } else {
        this.reveal.playing = false;
        this.postUniforms.uFlash.value = 0;
        this.postUniforms.uDrop.value = 0.34;
        this.postUniforms.uReveal.value = 1;
        this.pointUniforms.uReveal.value = 1;
        this.render();
      }
    };
    this.reveal.raf = requestAnimationFrame(step);
  }

  pass(material, target) {
    this.fsMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.fsScene, this.fsCamera);
  }

  render() {
    if (!this.size) return;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.pass(this.thresholdMat, this.bloomA);
    this.pass(this.blurH, this.bloomB);
    this.pass(this.blurV, this.bloomA);

    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.postScene, this.postCamera);
  }

  exportPNG(scale = 2, bg = '#06070a') {
    const oldDpr = this.dpr;
    const target = Math.min(4096, Math.max(2048, Math.floor(this.size * Math.min(Math.max(scale, this.dpr * 1.05), 4))));
    const ratio = target / Math.max(1, this.size);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.size, this.size, false);
    this.rt.setSize(target, target);
    const qt = Math.max(2, Math.floor(target / 2));
    this.bloomA.setSize(qt, qt);
    this.bloomB.setSize(qt, qt);
    this.blurH.uniforms.uDir.value.set(1 / qt, 0);
    this.blurV.uniforms.uDir.value.set(0, 1 / qt);
    this.postUniforms.uRes.value.set(target, target);
    this.render();

    const src = this.renderer.domElement;
    let url;
    if (bg) {
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      url = out.toDataURL('image/png');
    } else {
      url = src.toDataURL('image/png');
    }

    this.renderer.setPixelRatio(oldDpr);
    this.renderer.setSize(this.size, this.size, false);
    const bw = Math.floor(this.size * oldDpr);
    this.rt.setSize(bw, bw);
    const qw = Math.max(2, Math.floor(bw / 2));
    this.bloomA.setSize(qw, qw);
    this.bloomB.setSize(qw, qw);
    this.blurH.uniforms.uDir.value.set(1 / qw, 0);
    this.blurV.uniforms.uDir.value.set(0, 1 / qw);
    this.postUniforms.uRes.value.set(bw, bw);
    this.render();
    return url;
  }

  dispose() {
    cancelAnimationFrame(this.reveal.raf);
    this.resizeObserver.disconnect();
    this.disposePoints();
    this.rt.dispose();
    this.material.dispose();
    this.postMaterial.dispose();
    this.renderer.dispose();
  }
}


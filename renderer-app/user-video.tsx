import React, { useMemo } from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  AbsoluteFill,
} from 'remotion';
import * as THREE from 'three';

// =============================================================================
// COMPOSITION CONFIG
// =============================================================================
export const compositionConfig = {
  id: 'FriendsPlayingFootball', // PascalCase only, NO hyphens or underscores
  durationInSeconds: 5,
  fps: 60,
  width: 1920,
  height: 1080,
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================
const COLORS = {
  skyTop: 0x6cc4ef,
  skyHorizon: 0xeaf5fa,
  fog: 0xcfe4ee,
  grassBase: 0x4f9d55,
  grassStripe: 0x63b668,
  hillFar: 0x4a7c4a,
  hillMid: 0x5a8f5a,
  hillNear: 0x6ba36b,
  sunlight: 0xfffaea,
  line: 0xffffff,
  // Player A (red)
  aShirt: 0xe63946,
  aShorts: 0xf8f9fa,
  aSkin: 0xf2c299,
  aHair: 0x4a2c17,
  aShoes: 0x1d3557,
  // Player B (blue)
  bShirt: 0x2680eb,
  bShorts: 0x14324f,
  bSkin: 0x94603e,
  bHair: 0x161616,
  bShoes: 0xffd166,
} as const;

const EASINGS = {
  gentle: Easing.bezier(0.25, 0.1, 0.25, 1),
  easeOut: Easing.bezier(0.33, 1, 0.68, 1),
  easeInOut: Easing.bezier(0.37, 0, 0.63, 1),
  bouncy: Easing.bezier(0.34, 1.56, 0.64, 1),
};

const CLAMP = {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
} as const;

// =============================================================================
// SEEDED RANDOM (for deterministic renders)
// =============================================================================
const seededRandom = (seed: number): number => {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
};

// =============================================================================
// CHOREOGRAPHY (all times in seconds)
// =============================================================================
const BALL_RADIUS = 0.38;
const PLAYER_X = 4.2; // each friend stands this far from the center
const BALL_OFFSET = 0.95; // ball rests this far in front of a player
const BALL_REST_X = PLAYER_X - BALL_OFFSET;

type Side = 'A' | 'B';
interface PassDef {
  from: Side;
  start: number; // kick contact time
  end: number; // arrival time at the other player's feet
  arc: number; // peak height of the pass
  ground: boolean; // ground pass with small bounces
}

const PASSES: PassDef[] = [
  { from: 'A', start: 0.55, end: 1.45, arc: 2.4, ground: false },
  { from: 'B', start: 1.85, end: 2.75, arc: 0, ground: true },
  { from: 'A', start: 3.05, end: 3.9, arc: 1.6, ground: false },
  { from: 'B', start: 4.2, end: 4.95, arc: 2.8, ground: false },
];

const getBallState = (t: number): { x: number; y: number } => {
  let x = -BALL_REST_X;
  let restSince = -1;
  for (const p of PASSES) {
    if (t < p.start) break;
    const fromX = p.from === 'A' ? -BALL_REST_X : BALL_REST_X;
    const toX = -fromX;
    if (t <= p.end) {
      const prog = (t - p.start) / (p.end - p.start);
      const xp = interpolate(prog, [0, 1], [0, 1], {
        easing: p.ground ? EASINGS.easeOut : EASINGS.gentle,
        ...CLAMP,
      });
      const px = fromX + (toX - fromX) * xp;
      const py = p.ground
        ? BALL_RADIUS + Math.abs(Math.sin(prog * Math.PI * 3)) * 0.28 * (1 - prog)
        : BALL_RADIUS + 4 * p.arc * prog * (1 - prog);
      return { x: px, y: py };
    }
    x = toX;
    restSince = p.end;
  }
  const dt = restSince < 0 ? 0 : t - restSince;
  const y =
    restSince < 0
      ? BALL_RADIUS
      : BALL_RADIUS + Math.abs(Math.sin(dt * 9)) * 0.35 * Math.exp(-dt * 5);
  return { x, y };
};

const getKickSwing = (t: number, side: Side): number =>
  PASSES.reduce(
    (sum, p) =>
      p.from === side
        ? sum +
          interpolate(
            t,
            [p.start - 0.45, p.start - 0.15, p.start, p.start + 0.45],
            [0, -0.75, 1.15, 0],
            CLAMP
          )
        : sum,
    0
  );

const getTrapSwing = (t: number, side: Side): number =>
  PASSES.reduce(
    (sum, p) =>
      p.from !== side
        ? sum + interpolate(t, [p.end - 0.3, p.end - 0.05, p.end + 0.25], [0, 0.55, 0], CLAMP)
        : sum,
    0
  );

// =============================================================================
// SMALL THREE.JS HELPERS
// =============================================================================
const stdMat = (color: number, roughness = 0.85, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

const makeMesh = (
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  pos: [number, number, number] = [0, 0, 0],
  cast = true
) => {
  const m = new THREE.Mesh(geo, material);
  m.position.set(pos[0], pos[1], pos[2]);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
};

// =============================================================================
// PLAYER (stylized Pixar-like character, built facing +X)
// =============================================================================
interface PlayerRig {
  root: THREE.Group;
  upper: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  eyes: THREE.Group[];
}

interface PlayerStyle {
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  shoes: number;
  tufts: boolean;
}

const createLeg = (z: number, style: PlayerStyle): THREE.Group => {
  const leg = new THREE.Group();
  leg.position.set(0, 0.95, z);
  leg.add(makeMesh(new THREE.CylinderGeometry(0.2, 0.17, 0.42, 14), stdMat(style.shorts), [0, -0.2, 0]));
  leg.add(makeMesh(new THREE.CylinderGeometry(0.14, 0.13, 0.42, 12), stdMat(0xffffff), [0, -0.6, 0]));
  const shoe = makeMesh(new THREE.SphereGeometry(1, 16, 12), stdMat(style.shoes, 0.6), [0.1, -0.79, 0]);
  shoe.scale.set(0.34, 0.16, 0.2);
  leg.add(shoe);
  return leg;
};

const createArm = (z: number, style: PlayerStyle): THREE.Group => {
  const arm = new THREE.Group();
  arm.position.set(0, 0.75, z);
  arm.add(makeMesh(new THREE.SphereGeometry(0.15, 12, 10), stdMat(style.shirt), [0, 0, 0]));
  arm.add(makeMesh(new THREE.CylinderGeometry(0.09, 0.08, 0.6, 10), stdMat(style.skin), [0, -0.32, 0]));
  arm.add(makeMesh(new THREE.SphereGeometry(0.11, 12, 10), stdMat(style.skin), [0, -0.65, 0]));
  return arm;
};

const createPlayer = (style: PlayerStyle): PlayerRig => {
  const root = new THREE.Group();

  const legL = createLeg(0.24, style);
  const legR = createLeg(-0.24, style);
  root.add(legL, legR);

  const upper = new THREE.Group();
  upper.position.set(0, 0.95, 0);
  root.add(upper);

  // Torso
  upper.add(makeMesh(new THREE.CylinderGeometry(0.4, 0.34, 0.85, 20), stdMat(style.shirt), [0, 0.45, 0]));
  const shoulders = makeMesh(new THREE.SphereGeometry(0.4, 20, 12), stdMat(style.shirt), [0, 0.85, 0]);
  shoulders.scale.set(1, 0.45, 1);
  upper.add(shoulders);
  upper.add(makeMesh(new THREE.CylinderGeometry(0.385, 0.385, 0.12, 20), stdMat(0xffffff), [0, 0.5, 0]));
  upper.add(makeMesh(new THREE.CylinderGeometry(0.34, 0.36, 0.22, 20), stdMat(style.shorts), [0, 0.04, 0]));

  // Arms
  const armL = createArm(0.52, style);
  const armR = createArm(-0.52, style);
  upper.add(armL, armR);

  // Head
  const head = new THREE.Group();
  head.position.set(0, 1.42, 0);
  upper.add(head);
  head.add(makeMesh(new THREE.SphereGeometry(0.55, 32, 24), stdMat(style.skin, 0.7)));

  const hairMat = stdMat(style.hair, 0.6);
  hairMat.side = THREE.DoubleSide;
  const hair = makeMesh(
    new THREE.SphereGeometry(0.58, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.46),
    hairMat
  );
  hair.rotation.z = 0.3;
  head.add(hair);

  if (style.tufts) {
    for (let i = 0; i < 3; i++) {
      const tuft = makeMesh(
        new THREE.ConeGeometry(0.11, 0.32, 8),
        stdMat(style.hair, 0.6),
        [-0.08 + (i - 1) * 0.02, 0.6, (i - 1) * 0.2]
      );
      tuft.rotation.x = (i - 1) * -0.45;
      tuft.rotation.z = 0.2;
      head.add(tuft);
    }
  }

  // Ears
  head.add(makeMesh(new THREE.SphereGeometry(0.12, 10, 8), stdMat(style.skin, 0.7), [-0.02, 0, 0.55]));
  head.add(makeMesh(new THREE.SphereGeometry(0.12, 10, 8), stdMat(style.skin, 0.7), [-0.02, 0, -0.55]));

  // Eyes (groups so we can blink)
  const eyes: THREE.Group[] = [];
  [0.2, -0.2].forEach((z) => {
    const eye = new THREE.Group();
    eye.position.set(0.49, 0.1, z);
    const white = makeMesh(new THREE.SphereGeometry(0.11, 14, 12), stdMat(0xffffff, 0.3), [0, 0, 0], false);
    white.scale.set(0.7, 1, 0.9);
    const pupil = makeMesh(new THREE.SphereGeometry(0.06, 10, 8), stdMat(0x101010, 0.2), [0.05, 0, 0], false);
    eye.add(white, pupil);
    head.add(eye);
    eyes.push(eye);
  });

  // Nose, cheeks, smile
  head.add(makeMesh(new THREE.SphereGeometry(0.07, 10, 8), stdMat(style.skin, 0.7), [0.55, -0.03, 0], false));
  [0.33, -0.33].forEach((z) => {
    const cheek = makeMesh(new THREE.SphereGeometry(0.07, 10, 8), stdMat(0xff9a9a, 0.9), [0.46, -0.1, z], false);
    cheek.scale.set(0.5, 0.8, 1);
    head.add(cheek);
  });
  const smileGroup = new THREE.Group();
  smileGroup.position.set(0.5, -0.2, 0);
  smileGroup.rotation.y = Math.PI / 2;
  const smile = makeMesh(
    new THREE.TorusGeometry(0.14, 0.025, 8, 20, Math.PI),
    stdMat(0x7a2e2e, 0.5),
    [0, 0.06, 0],
    false
  );
  smile.rotation.z = Math.PI;
  smileGroup.add(smile);
  head.add(smileGroup);

  return { root, upper, head, legL, legR, armL, armR, eyes };
};

const poseOnPlayer = (rig: PlayerRig, t: number, side: Side) => {
  const phase = side === 'A' ? 0 : 1.7;
  const kick = getKickSwing(t, side);
  const trap = getTrapSwing(t, side);
  const step = Math.sin(t * 5 + phase) * 0.1;

  rig.legR.rotation.z = step + kick;
  rig.legL.rotation.z = -step + trap;

  rig.upper.rotation.z = -kick * 0.12;

  rig.armL.rotation.z = step * 2 - kick * 0.5;
  rig.armR.rotation.z = -step * 2 + kick * 0.5;
  rig.armL.rotation.x = -0.25 - Math.abs(kick) * 0.2;
  rig.armR.rotation.x = 0.25 + Math.abs(kick) * 0.2;

  rig.head.rotation.z = Math.sin(t * 2.5 + phase) * 0.04 - kick * 0.05;
  const blinkPhase = (t + phase * 0.5) % 2.4;
  const blink = blinkPhase < 0.12 ? 0.1 : 1;
  rig.eyes.forEach((e) => e.scale.set(1, blink, 1));

  rig.root.position.y = Math.abs(Math.sin(t * 5 + phase)) * 0.05;
};

// =============================================================================
// BALL
// =============================================================================
const createBall = (): THREE.Group => {
  const group = new THREE.Group();
  const body = makeMesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 24), stdMat(0xffffff, 0.45));
  group.add(body);

  const phi = (1 + Math.sqrt(5)) / 2;
  const verts: [number, number, number][] = [
    [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
    [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
    [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1],
  ];
  const patchMat = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.5, side: THREE.DoubleSide });
  verts.forEach((v) => {
    const n = new THREE.Vector3(v[0], v[1], v[2]).normalize();
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.14, 5), patchMat);
    patch.position.copy(n).multiplyScalar(BALL_RADIUS + 0.003);
    patch.lookAt(n.clone().multiplyScalar(2));
    group.add(patch);
  });
  return group;
};

// =============================================================================
// ENVIRONMENT PIECES
// =============================================================================
const createGoal = (x: number, z: number, rotY: number): THREE.Group => {
  const g = new THREE.Group();
  const postMat = stdMat(0xffffff, 0.4, 0.1);
  const W = 5;
  const H = 2.2;
  const D = 1.8;
  [-W / 2, W / 2].forEach((px) => {
    g.add(makeMesh(new THREE.CylinderGeometry(0.08, 0.08, H, 10), postMat, [px, H / 2, 0]));
    g.add(makeMesh(new THREE.CylinderGeometry(0.06, 0.06, H, 10), postMat, [px, H / 2, -D]));
    const top = makeMesh(new THREE.CylinderGeometry(0.05, 0.05, D, 8), postMat, [px, H, -D / 2]);
    top.rotation.x = Math.PI / 2;
    g.add(top);
  });
  const bar = makeMesh(new THREE.CylinderGeometry(0.08, 0.08, W, 10), postMat, [0, H, 0]);
  bar.rotation.z = Math.PI / 2;
  g.add(bar);

  const netMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), netMat);
  back.position.set(0, H / 2, -D);
  g.add(back);
  [-W / 2, W / 2].forEach((px) => {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(D, H), netMat);
    side.rotation.y = Math.PI / 2;
    side.position.set(px, H / 2, -D / 2);
    g.add(side);
  });
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, D), netMat);
  roof.rotation.x = Math.PI / 2;
  roof.position.set(0, H, -D / 2);
  g.add(roof);

  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  return g;
};

const createCloud = (x: number, y: number, z: number, scale: number): THREE.Group => {
  const group = new THREE.Group();
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    transparent: true,
    opacity: 0.92,
  });
  const spheres: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [-0.7, 0.15, 0, 0.65],
    [0.7, 0.1, 0, 0.7],
    [0.25, 0.35, 0.15, 0.5],
    [-0.25, 0.25, -0.15, 0.55],
  ];
  spheres.forEach(([cx, cy, cz, cr]) => {
    const part = new THREE.Mesh(new THREE.SphereGeometry(cr, 10, 10), cloudMat);
    part.position.set(cx, cy, cz);
    group.add(part);
  });
  group.position.set(x, y, z);
  group.scale.setScalar(scale);
  return group;
};

const createHill = (x: number, z: number, w: number, h: number, d: number, color: number) => {
  const geo = new THREE.SphereGeometry(1, 32, 24);
  geo.scale(w, h, d);
  const hill = new THREE.Mesh(geo, stdMat(color, 0.9));
  hill.position.set(x, h * 0.3 - 1, z);
  hill.receiveShadow = true;
  return hill;
};

const createTree = (x: number, z: number, s: number, tint: number): THREE.Group => {
  const tree = new THREE.Group();
  tree.add(makeMesh(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 8), stdMat(0x7a5230), [0, 1.1, 0], false));
  const crown = makeMesh(new THREE.SphereGeometry(1.5, 14, 12), stdMat(tint, 0.9), [0, 3.3, 0], false);
  crown.scale.set(1, 1.15, 1);
  tree.add(crown);
  tree.add(makeMesh(new THREE.SphereGeometry(1.0, 12, 10), stdMat(tint, 0.9), [0.8, 2.7, 0.4], false));
  tree.position.set(x, 0, z);
  tree.scale.setScalar(s);
  return tree;
};

// =============================================================================
// PRE-GENERATED DATA TYPES
// =============================================================================
interface GrassBlade {
  x: number;
  z: number;
  height: number;
  rotation: number;
  tone: number;
  phase: number;
}
interface CloudData { x: number; y: number; z: number; scale: number; speed: number }
interface TreeData { x: number; z: number; scale: number; tint: number }
interface DustData { dx: number; dy: number; dz: number; size: number }

// =============================================================================
// THREE.JS SCENE COMPONENT
// =============================================================================
const ThreeScene: React.FC<{
  frame: number;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}> = ({ frame, fps, durationInFrames, width, height }) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const time = frame / fps; // ALWAYS time-based

  // Pre-generate static data ONCE
  const sceneData = useMemo(() => {
    const grass: GrassBlade[] = [];
    for (let i = 0; i < 4500; i++) {
      const x = seededRandom(i * 1.1) * 64 - 32;
      const z = seededRandom(i * 2.2) * 40 - 24;
      // keep the play area (where friends & ball are) cleaner
      if (Math.abs(x) < 6.2 && Math.abs(z) < 2.4) continue;
      grass.push({
        x,
        z,
        height: 0.5 + seededRandom(i * 3.3) * 0.7,
        rotation: seededRandom(i * 4.4) * Math.PI * 2,
        tone: seededRandom(i * 5.5),
        phase: seededRandom(i * 6.6) * Math.PI * 2,
      });
    }

    const clouds: CloudData[] = Array.from({ length: 7 }, (_, i) => ({
      x: seededRandom(i * 7.7) * 90 - 45,
      y: 22 + seededRandom(i * 8.8) * 12,
      z: -45 - seededRandom(i * 9.9) * 25,
      scale: 3 + seededRandom(i * 10.1) * 3,
      speed: 0.5 + seededRandom(i * 11.3) * 0.6,
    }));

    const trees: TreeData[] = Array.from({ length: 14 }, (_, i) => ({
      x: -48 + i * 7.4 + (seededRandom(i * 12.7) - 0.5) * 3,
      z: -24 - seededRandom(i * 13.9) * 8,
      scale: 1.1 + seededRandom(i * 14.3) * 0.9,
      tint: i % 3 === 0 ? 0x3f8f4a : i % 3 === 1 ? 0x4aa05a : 0x367f45,
    }));

    const dust: DustData[] = Array.from({ length: 8 }, (_, i) => ({
      dx: 0.4 + seededRandom(i * 15.1) * 1.2,
      dy: 0.6 + seededRandom(i * 16.3) * 0.9,
      dz: (seededRandom(i * 17.9) - 0.5) * 2,
      size: 0.1 + seededRandom(i * 18.7) * 0.12,
    }));

    return { grass, clouds, trees, dust };
  }, []);

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // RENDERER
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(COLORS.skyHorizon);

    // SCENE
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(COLORS.fog, 0.011);

    // CAMERA (slow orbit + dolly in, gently tracking the ball)
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 500);
    const ball = getBallState(time);
    const camAngle = interpolate(time, [0, 5], [-0.5, 0.45], { easing: EASINGS.gentle, ...CLAMP });
    const camRadius = interpolate(time, [0, 5], [18, 13.5], { easing: EASINGS.easeInOut, ...CLAMP });
    const camHeight = interpolate(time, [0, 5], [5.2, 3.3], { easing: EASINGS.easeInOut, ...CLAMP });
    camera.position.set(
      Math.sin(camAngle) * camRadius + Math.sin(time * 1.2) * 0.04,
      camHeight + Math.sin(time * 1.5) * 0.05,
      Math.cos(camAngle) * camRadius
    );
    camera.lookAt(ball.x * 0.3, 1.6, 0);

    // SKY DOME
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(COLORS.skyTop) },
        bottomColor: { value: new THREE.Color(COLORS.skyHorizon) },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), 0.7)), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(200, 32, 24), skyMat));

    // LIGHTING
    scene.add(new THREE.AmbientLight(0x9bb8d4, 0.5));

    const sun = new THREE.DirectionalLight(COLORS.sunlight, 1.4);
    sun.position.set(14, 28, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.bias = -0.0003;
    scene.add(sun);

    scene.add(new THREE.HemisphereLight(0x87ceeb, 0x3d5c3d, 0.4));

    const rim = new THREE.DirectionalLight(0xffeedd, 0.3);
    rim.position.set(-20, 15, -15);
    scene.add(rim);

    // GROUND + MOWING STRIPES
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(220, 140), stdMat(COLORS.grassBase, 0.95));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const stripeMat = stdMat(COLORS.grassStripe, 0.95);
    for (let i = -10; i < 10; i += 2) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(3, 0.02, 60), stripeMat);
      stripe.position.set(i * 3 + 1.5, 0.01, -8);
      stripe.receiveShadow = true;
      scene.add(stripe);
    }

    // FIELD MARKINGS
    const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.line, transparent: true, opacity: 0.85 });
    const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 40), lineMat);
    centerLine.rotation.x = -Math.PI / 2;
    centerLine.position.set(0, 0.025, -8);
    scene.add(centerLine);
    const circle = new THREE.Mesh(new THREE.RingGeometry(5.35, 5.55, 72), lineMat);
    circle.rotation.x = -Math.PI / 2;
    circle.position.set(0, 0.03, 0);
    scene.add(circle);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.28, 20), lineMat);
    spot.rotation.x = -Math.PI / 2;
    spot.position.set(0, 0.03, 0);
    scene.add(spot);

    // INSTANCED GRASS (wind reactive)
    const grassGeo = new THREE.ConeGeometry(0.07, 0.55, 3);
    grassGeo.translate(0, 0.275, 0);
    const grassMesh = new THREE.InstancedMesh(
      grassGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide }),
      sceneData.grass.length
    );
    grassMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    const colA = new THREE.Color(0x5fae60);
    const colB = new THREE.Color(0x8fd07a);
    const tmpColor = new THREE.Color();
    sceneData.grass.forEach((blade, i) => {
      const wind = Math.sin(time * 2 + blade.x * 0.3 + blade.z * 0.2 + blade.phase) * 0.14;
      // ball "breeze": grass near the ball path ripples when the ball flies by
      const distToBall = Math.abs(blade.x - ball.x);
      const ripple =
        distToBall < 3 && Math.abs(blade.z) < 8
          ? Math.sin(time * 12 - distToBall * 2) * 0.12 * (1 - distToBall / 3)
          : 0;
      dummy.position.set(blade.x, 0, blade.z);
      dummy.rotation.set(wind + ripple, blade.rotation, wind * 0.5);
      dummy.scale.set(1, blade.height, 1);
      dummy.updateMatrix();
      grassMesh.setMatrixAt(i, dummy.matrix);
      tmpColor.copy(colA).lerp(colB, blade.tone);
      grassMesh.setColorAt(i, tmpColor);
    });
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    scene.add(grassMesh);

    // HILLS (layered for depth)
    scene.add(createHill(-40, -75, 45, 20, 22, COLORS.hillFar));
    scene.add(createHill(30, -85, 55, 26, 24, COLORS.hillFar));
    scene.add(createHill(-10, -55, 34, 14, 16, COLORS.hillMid));
    scene.add(createHill(45, -50, 28, 12, 14, COLORS.hillMid));
    scene.add(createHill(-32, -38, 22, 8, 10, COLORS.hillNear));

    // TREES
    sceneData.trees.forEach((t) => scene.add(createTree(t.x, t.z, t.scale, t.tint)));

    // CLOUDS
    sceneData.clouds.forEach((c) => {
      scene.add(createCloud(c.x + time * c.speed, c.y, c.z, c.scale));
    });

    // MINI GOALS + CONES
    scene.add(createGoal(-10, -8, 0.45));
    scene.add(createGoal(10, -8, -0.45));
    const coneMat = stdMat(0xff7a1a, 0.6);
    const conePositions: [number, number][] = [[-8.5, 3.2], [8.5, 3.2], [-8.5, -3.2], [8.5, -3.2]];
    conePositions.forEach(([cx, cz]) => {
      scene.add(makeMesh(new THREE.ConeGeometry(0.3, 0.7, 16), coneMat, [cx, 0.35, cz]));
      scene.add(makeMesh(new THREE.CylinderGeometry(0.31, 0.31, 0.1, 16), stdMat(0xffffff, 0.6), [cx, 0.38, cz]));
    });

    // PLAYERS
    const playerA = createPlayer({
      shirt: COLORS.aShirt,
      shorts: COLORS.aShorts,
      skin: COLORS.aSkin,
      hair: COLORS.aHair,
      shoes: COLORS.aShoes,
      tufts: false,
    });
    playerA.root.position.set(-PLAYER_X, 0, 0);
    poseOnPlayer(playerA, time, 'A');
    scene.add(playerA.root);

    const playerB = createPlayer({
      shirt: COLORS.bShirt,
      shorts: COLORS.bShorts,
      skin: COLORS.bSkin,
      hair: COLORS.bHair,
      shoes: COLORS.bShoes,
      tufts: true,
    });
    playerB.root.position.set(PLAYER_X, 0, 0);
    playerB.root.rotation.y = Math.PI; // faces -X toward friend A
    poseOnPlayer(playerB, time, 'B');
    scene.add(playerB.root);

    // BALL
    const ballGroup = createBall();
    ballGroup.position.set(ball.x, ball.y, 0);
    ballGroup.rotation.set(time * 2, 0, -ball.x / BALL_RADIUS);
    scene.add(ballGroup);

    // DUST PUFFS at each kick
    const dustGeo = new THREE.SphereGeometry(1, 8, 6);
    PASSES.forEach((p) => {
      const age = time - p.start;
      if (age < 0 || age > 0.7) return;
      const sign = p.from === 'A' ? 1 : -1; // +1 = kicked toward +X
      const fromX = p.from === 'A' ? -BALL_REST_X : BALL_REST_X;
      sceneData.dust.forEach((d) => {
        const opacity = (1 - age / 0.7) * 0.5;
        if (opacity < 0.03) return;
        const mat = new THREE.MeshBasicMaterial({
          color: 0xe8dcc0,
          transparent: true,
          opacity,
          depthWrite: false,
        });
        const puff = new THREE.Mesh(dustGeo, mat);
        puff.position.set(
          fromX - sign * (0.3 + age * d.dx * 1.4),
          Math.max(0.1, 0.12 + age * d.dy - age * age * 1.6),
          d.dz * age * 1.2
        );
        puff.scale.setScalar(d.size + age * 0.45);
        scene.add(puff);
      });
    });

    // RENDER
    renderer.render(scene, camera);

    return () => {
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mats = m.material;
        if (Array.isArray(mats)) mats.forEach((mm) => mm.dispose());
        else if (mats) (mats as THREE.Material).dispose();
      });
      renderer.dispose();
    };
  }, [frame, fps, durationInFrames, time, sceneData, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const FriendsPlayingFootball: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps, width, height } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, fps * 0.5], [1, 0], CLAMP);
  const fadeOut = interpolate(frame, [durationInFrames - fps * 0.5, durationInFrames], [0, 1], CLAMP);
  const blackout = Math.max(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <ThreeScene
        frame={frame}
        fps={fps}
        durationInFrames={durationInFrames}
        width={width}
        height={height}
      />
      {/* Soft vignette */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 58%, rgba(0,0,0,0.28) 100%)',
          pointerEvents: 'none',
        }}
      />
      {/* Fade in / out */}
      <AbsoluteFill style={{ backgroundColor: '#000', opacity: blackout, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

export default FriendsPlayingFootball;

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  animateHumanRig,
  createRealisticHumanRig,
  disposeCharacterResources,
} from './characters';
import type { TextureBundle } from './textures';
import type { CharacterId } from './types';

export type CharacterPreviewMap = Record<CharacterId, string>;

let cachedPreviews: CharacterPreviewMap | null = null;
let inFlightPromise: Promise<CharacterPreviewMap> | null = null;

function createDummyTextureBundle(): TextureBundle {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  dummy.needsUpdate = true;
  const tex = dummy as unknown as THREE.CanvasTexture;
  return {
    compact: true,
    tileAlbedo: tex,
    tileBump: tex,
    tileRoughness: tex,
    wallAlbedo: tex,
    wallBump: tex,
    concreteAlbedo: tex,
    concreteBump: tex,
    cautionAlbedo: tex,
    metalAlbedo: tex,
    metalBump: tex,
    woodAlbedo: tex,
    woodBump: tex,
    woodRoughness: tex,
    ceilingAlbedo: tex,
    waterNormal: tex,
    monsterSkin: tex,
    monsterBump: tex,
    monsterNormal: tex,
    monsterRoughness: tex,
    monsterEmissive: tex,
    monsterFinSkin: tex,
    monsterFinEmissive: tex,
    monsterEye: tex,
    setAnisotropy: () => {},
    dispose: () => {
      dummy.dispose();
    },
  };
}

function createPoolroomsStudioTileTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Deep Poolrooms slate-teal ceramic tile base
    ctx.fillStyle = '#09191d';
    ctx.fillRect(0, 0, size, size);

    const cells = 8;
    const step = size / cells;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const shade = ((x * 7 + y * 13) % 5) - 2;
        const r = Math.max(6, 11 + shade * 1);
        const g = Math.max(16, 29 + shade * 2);
        const b = Math.max(20, 34 + shade * 2);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x * step + 1, y * step + 1, step - 2, step - 2);

        // Subtle glazed tile bevel specular highlight
        ctx.fillStyle = 'rgba(130, 224, 214, 0.045)';
        ctx.fillRect(x * step + 2, y * step + 2, step - 4, 2);
      }
    }

    // Recessed grout lines
    ctx.strokeStyle = 'rgba(3, 8, 10, 0.85)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= cells; i++) {
      const p = i * step;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = Math.min(4, Math.max(1, anisotropy));
  tex.needsUpdate = true;
  return tex;
}

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function encodePortraitDataUrl(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL('image/webp', 0.9);
  if (webp.startsWith('data:image/webp')) {
    return webp;
  }
  return canvas.toDataURL('image/jpeg', 0.92);
}

async function renderCharacterPortraits(): Promise<CharacterPreviewMap> {
  if (typeof document === 'undefined') {
    return { male: '', female: '' };
  }

  const isCompactDevice =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window ||
      (typeof navigator !== 'undefined' &&
        (navigator.maxTouchPoints > 0 || (navigator.hardwareConcurrency || 4) <= 4)));

  const width = isCompactDevice ? 360 : 440;
  const height = isCompactDevice ? 540 : 660;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isCompactDevice,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'default',
    });
  } catch {
    return { male: '', female: '' };
  }

  const dummyBundle = createDummyTextureBundle();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x061013);
  scene.fog = new THREE.FogExp2(0x061013, 0.088);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTarget = pmrem.fromScene(roomEnv, 0.04);

  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.74;

  // Atmospheric Poolrooms horror-survival studio lighting
  const hemi = new THREE.HemisphereLight(0x9bd6e2, 0x0a161a, 0.7);
  scene.add(hemi);

  const keyLight = new THREE.DirectionalLight(0xfff1de, 2.3);
  keyLight.position.set(2.2, 3.6, 3.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(512, 512);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 14;
  keyLight.shadow.camera.left = -1.5;
  keyLight.shadow.camera.right = 1.5;
  keyLight.shadow.camera.top = 2.5;
  keyLight.shadow.camera.bottom = -0.5;
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.015;
  scene.add(keyLight);

  // Cool teal Poolrooms rim light separating character & long hair from backdrop
  const rimLight = new THREE.DirectionalLight(0x52ebbf, 2.05);
  rimLight.position.set(-2.3, 2.6, -2.1);
  scene.add(rimLight);

  // Warm-neutral hair & shoulder top-back sheen light
  const hairSheenLight = new THREE.PointLight(0xffe7cf, 1.35, 6.0, 1.5);
  hairSheenLight.position.set(0.8, 2.25, -1.2);
  scene.add(hairSheenLight);

  // Gentle front face catchlight & under-brow fill
  const faceFill = new THREE.PointLight(0xffeada, 0.92, 5.5, 1.4);
  faceFill.position.set(-0.35, 1.58, 1.85);
  scene.add(faceFill);

  // Poolrooms recessed tiled alcove backdrop + wet ceramic floor + stepped plinth
  const tileTex = createPoolroomsStudioTileTexture(renderer.capabilities.getMaxAnisotropy());
  const floorMat = new THREE.MeshStandardMaterial({
    map: tileTex,
    roughness: 0.24,
    metalness: 0.14,
  });
  const wallMat = new THREE.MeshStandardMaterial({
    map: tileTex,
    color: 0x8bb6bd,
    roughness: 0.42,
    metalness: 0.08,
  });

  const floorGeo = new THREE.PlaneGeometry(8, 8);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -0.024;
  floor.receiveShadow = true;
  scene.add(floor);

  const backWallGeo = new THREE.PlaneGeometry(6.5, 5.2);
  const backWall = new THREE.Mesh(backWallGeo, wallMat);
  backWall.position.set(0, 2.1, -1.75);
  backWall.receiveShadow = true;
  scene.add(backWall);

  // Architectural Poolrooms pillars framing the recessed alcove
  const pillarGeo = new THREE.BoxGeometry(0.44, 5.2, 0.55);
  const leftPillar = new THREE.Mesh(pillarGeo, wallMat);
  leftPillar.position.set(-1.38, 2.1, -1.42);
  leftPillar.receiveShadow = true;
  const rightPillar = new THREE.Mesh(pillarGeo, wallMat);
  rightPillar.position.set(1.38, 2.1, -1.42);
  rightPillar.receiveShadow = true;
  scene.add(leftPillar, rightPillar);

  // Subtle subsurface cyan pool-glow behind alcove
  const alcoveGlow = new THREE.PointLight(0x3ad8ae, 2.4, 5.2, 1.4);
  alcoveGlow.position.set(0, 1.05, -1.35);
  scene.add(alcoveGlow);

  // Grounded wet-tile survival plinth under character boots (top surface y = 0.000)
  const plinthGeo = new THREE.CylinderGeometry(0.62, 0.68, 0.026, 36);
  const plinthMat = new THREE.MeshStandardMaterial({
    color: 0x0d1f24,
    roughness: 0.34,
    metalness: 0.24,
  });
  const plinth = new THREE.Mesh(plinthGeo, plinthMat);
  plinth.position.y = -0.013;
  plinth.receiveShadow = true;
  scene.add(plinth);

  const rimRingGeo = new THREE.TorusGeometry(0.62, 0.0055, 8, 36);
  rimRingGeo.rotateX(Math.PI / 2);
  const rimRingMat = new THREE.MeshStandardMaterial({
    color: 0x45d6ae,
    emissive: 0x269e7d,
    emissiveIntensity: 0.55,
    roughness: 0.28,
  });
  const rimRing = new THREE.Mesh(rimRingGeo, rimRingMat);
  rimRing.position.y = 0.0005;
  scene.add(rimRing);

  // Full-body head-to-feet framing (vertical FOV 25deg covers y=-0.15m..+1.95m cleanly)
  const camera = new THREE.PerspectiveCamera(25, width / height, 0.1, 22);
  camera.position.set(0, 0.98, 4.78);
  camera.lookAt(0, 0.90, 0);

  const result: CharacterPreviewMap = { male: '', female: '' };

  try {
    for (const charId of ['male', 'female'] as const) {
      // Yield a frame between portraits so lobby UI & backdrop stay responsive
      await yieldFrame();

      const rig = createRealisticHumanRig(dummyBundle, charId, 0x52e0b6, true);
      rig.setShadowDetail('standard');
      scene.add(rig.root);

      // Initialize rig state cleanly
      for (let step = 0; step < 6; step++) {
        animateHumanRig(rig, 'idle', 0, 0.2, 0.05);
      }

      if (charId === 'male') {
        // Male Pose: Confident survival stance, turned slightly toward viewer's left, strong posture, forearm raised near tactical harness
        rig.root.rotation.y = -0.40;
        rig.hips.position.y = 0.91;
        rig.hips.rotation.set(0, 0, 0);
        rig.torso.rotation.set(-0.03, 0.10, 0);
        rig.headGroup.rotation.set(-0.02, 0.28, 0);

        rig.leftLeg.rotation.set(-0.12, 0, 0.08);
        rig.leftShin.rotation.set(0.14, 0, 0);
        rig.rightLeg.rotation.set(0.09, 0, -0.09);
        rig.rightShin.rotation.set(0.05, 0, 0);

        rig.rightArm.rotation.set(0.12, 0, 0.15);
        rig.rightForearm.rotation.set(-0.32, 0, 0);
        rig.leftArm.rotation.set(-0.38, -0.22, -0.16);
        rig.leftForearm.rotation.set(-1.02, 0, 0);
      } else {
        // Female Pose: Elegant, confident survival stance at opposite angle so BOTH face AND long flowing back hair are clearly showcased
        rig.root.rotation.y = 0.68;
        rig.hips.position.y = 0.915;
        rig.hips.rotation.set(0, 0, -0.03);
        rig.torso.rotation.set(-0.02, -0.12, 0.025);
        rig.headGroup.rotation.set(-0.02, -0.46, 0.035);

        rig.leftLeg.rotation.set(-0.15, 0, 0.05);
        rig.leftShin.rotation.set(0.22, 0, 0);
        rig.rightLeg.rotation.set(0.06, 0, -0.05);
        rig.rightShin.rotation.set(0.02, 0, 0);

        rig.leftArm.rotation.set(0.10, 0.12, -0.20);
        rig.leftForearm.rotation.set(-0.62, 0, 0.06);
        rig.rightArm.rotation.set(-0.14, -0.08, 0.14);
        rig.rightForearm.rotation.set(-0.24, 0, 0);

        // Gentle sweeping drape of long multi-tier hair so individual waves silhouette cleanly
        for (let i = 0; i < rig.hairNodes.length; i++) {
          const hn = rig.hairNodes[i];
          if (hn.pitchFactor < 0) {
            hn.group.rotation.x = hn.restPitch + 0.14 * Math.abs(hn.pitchFactor);
            hn.group.rotation.z = hn.restRoll + 0.09 * hn.rollFactor;
          } else {
            hn.group.rotation.x = hn.restPitch - 0.04;
            hn.group.rotation.z = hn.restRoll + 0.03;
          }
        }
      }

      rig.root.updateMatrixWorld(true);

      renderer.render(scene, camera);
      result[charId] = encodePortraitDataUrl(canvas);

      scene.remove(rig.root);
      rig.dispose();
    }
  } finally {
    disposeCharacterResources(dummyBundle);
    dummyBundle.dispose();
    tileTex.dispose();
    floorMat.dispose();
    wallMat.dispose();
    floorGeo.dispose();
    backWallGeo.dispose();
    pillarGeo.dispose();
    plinthGeo.dispose();
    plinthMat.dispose();
    rimRingGeo.dispose();
    rimRingMat.dispose();
    keyLight.shadow.map?.dispose();
    keyLight.dispose();
    hemi.dispose();
    rimLight.dispose();
    hairSheenLight.dispose();
    faceFill.dispose();
    alcoveGlow.dispose();
    envTarget.dispose();
    roomEnv.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return result;
}

export function getCachedCharacterPreviews(): CharacterPreviewMap | null {
  return cachedPreviews;
}

export function loadCharacterPreviews(): Promise<CharacterPreviewMap> {
  if (cachedPreviews && cachedPreviews.male && cachedPreviews.female) {
    return Promise.resolve(cachedPreviews);
  }
  if (!inFlightPromise) {
    inFlightPromise = new Promise<CharacterPreviewMap>((resolve) => {
      const run = () => {
        void renderCharacterPortraits().then((rendered) => {
          if (rendered.male && rendered.female) {
            cachedPreviews = rendered;
          }
          inFlightPromise = null;
          resolve(rendered);
        });
      };
      // Defer past main PoolGameEngine boot & shader prewarm so lobby stays stutter-free
      const ric =
        typeof window !== 'undefined'
          ? (window as Window & {
              requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
            }).requestIdleCallback
          : undefined;
      if (typeof ric === 'function') {
        setTimeout(() => ric(run, { timeout: 700 }), 220);
      } else {
        setTimeout(run, 360);
      }
    });
  }
  return inFlightPromise;
}

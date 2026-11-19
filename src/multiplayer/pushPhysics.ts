import type { LevelDef, PlatformDef } from '../game/types.ts';
import {
  PUSH_MAX_DISTANCE,
  PUSH_MAX_Y_DIFF,
  PUSH_MIN_FACING_DOT,
} from './types.ts';

export interface PushCandidate {
  userId: string;
  x: number;
  y: number;
  z: number;
}

export interface SelectedPushTarget {
  userId: string;
  dirX: number;
  dirZ: number;
  dist: number;
}

export function worldToRotatedPlatformLocal(
  dx: number,
  dy: number,
  dz: number,
  plat: PlatformDef,
  elapsedSec: number
): [number, number, number] {
  const axis = plat.rotationAxis || 'y';
  const spd = plat.rotationSpeed || 0;
  const phase = plat.rotationPhase ?? 0;
  const ang = phase + elapsedSec * spd;

  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (axis === 'y') ry = ang;
  else if (axis === 'x') rx = ang;
  else if (axis === 'z') rz = ang;
  else if (axis === 'xy') {
    rx = phase * 0.7 + elapsedSec * spd * 0.55;
    ry = ang;
  } else if (axis === 'zy') {
    ry = ang;
    rz = phase * 0.7 + elapsedSec * spd * 0.55;
  }

  // Inverse of Three.js 'YXZ' Euler (R_y(ry) * R_x(rx) * R_z(rz)) is R_z(-rz) * R_x(-rx) * R_y(-ry)
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const x1 = dx * cy - dz * sy;
  const y1 = dy;
  const z1 = dx * sy + dz * cy;

  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const x2 = x1;
  const y2 = y1 * cx + z1 * sx;
  const z2 = -y1 * sx + z1 * cx;

  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const lx = x2 * cz + y2 * sz;
  const ly = -x2 * sz + y2 * cz;
  const lz = z2;

  return [lx, ly, lz];
}

function segmentIntersectsAxisBox(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;

  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 1e-7) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ax) * inv;
    let t2 = (maxX - ax) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  if (Math.abs(dy) < 1e-7) {
    if (ay < minY || ay > maxY) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - ay) * inv;
    let t2 = (maxY - ay) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  if (Math.abs(dz) < 1e-7) {
    if (az < minZ || az > maxZ) return false;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - az) * inv;
    let t2 = (maxZ - az) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  return tmin <= tmax;
}

export function isPushPathObstructed(
  def: LevelDef,
  ax: number,
  ay: number,
  az: number,
  tx: number,
  ty: number,
  tz: number,
  elapsedSec: number
): boolean {
  // Check torso-height line of sight (0.95m above feet) so platforms underfoot do not false-trigger
  const p0x = ax;
  const p0y = ay + 0.95;
  const p0z = az;
  const p1x = tx;
  const p1y = ty + 0.95;
  const p1z = tz;

  const b = def.bounds;
  if (
    p0x < b.minX ||
    p0x > b.maxX ||
    p0z < b.minZ ||
    p0z > b.maxZ ||
    p1x < b.minX ||
    p1x > b.maxX ||
    p1z < b.minZ ||
    p1z > b.maxZ
  ) {
    return true;
  }

  for (const w of def.walls) {
    const [wx, wy, wz] = w.position;
    const [ww, wh, wd] = w.size;
    if (
      segmentIntersectsAxisBox(
        p0x,
        p0y,
        p0z,
        p1x,
        p1y,
        p1z,
        wx - ww * 0.5,
        wx + ww * 0.5,
        wy - wh * 0.5,
        wy + wh * 0.5,
        wz - wd * 0.5,
        wz + wd * 0.5
      )
    ) {
      return true;
    }
  }

  for (const plat of def.platforms) {
    if (plat.kind === 'disappearing') continue;
    let [px, py, pz] = plat.position;
    if (plat.kind === 'moving' && plat.moveOffset) {
      const speed = plat.moveSpeed ?? 1.0;
      const phase = plat.movePhase ?? 0;
      const factor = 0.5 - 0.5 * Math.cos(elapsedSec * speed + phase);
      px += plat.moveOffset[0] * factor;
      py += plat.moveOffset[1] * factor;
      pz += plat.moveOffset[2] * factor;
    }
    const [pw, ph, pd] = plat.size;
    const hw = pw * 0.5;
    const hh = ph * 0.5;
    const hd = pd * 0.5;

    if (!plat.rotationSpeed) {
      if (
        segmentIntersectsAxisBox(
          p0x,
          p0y,
          p0z,
          p1x,
          p1y,
          p1z,
          px - hw,
          px + hw,
          py - hh,
          py + hh,
          pz - hd,
          pz + hd
        )
      ) {
        return true;
      }
    } else {
      const [l0x, l0y, l0z] = worldToRotatedPlatformLocal(
        p0x - px,
        p0y - py,
        p0z - pz,
        plat,
        elapsedSec
      );
      const [l1x, l1y, l1z] = worldToRotatedPlatformLocal(
        p1x - px,
        p1y - py,
        p1z - pz,
        plat,
        elapsedSec
      );
      if (segmentIntersectsAxisBox(l0x, l0y, l0z, l1x, l1y, l1z, -hw, hw, -hh, hh, -hd, hd)) {
        return true;
      }
    }
  }

  return false;
}

export function selectPushTarget(
  def: LevelDef,
  attacker: { userId: string; x: number; y: number; z: number; yaw: number },
  candidates: PushCandidate[],
  elapsedSec: number
): SelectedPushTarget | null {
  const fx = Math.sin(attacker.yaw);
  const fz = Math.cos(attacker.yaw);

  let best: SelectedPushTarget | null = null;
  let bestScore = -Infinity;

  for (const cand of candidates) {
    if (cand.userId === attacker.userId) continue;

    const dx = cand.x - attacker.x;
    const dz = cand.z - attacker.z;
    const dy = Math.abs(cand.y - attacker.y);
    if (dy > PUSH_MAX_Y_DIFF) continue;

    const dist = Math.hypot(dx, dz);
    if (dist > PUSH_MAX_DISTANCE) continue;

    let ux = fx;
    let uz = fz;
    let facingDot = 1;
    if (dist > 0.2) {
      ux = dx / dist;
      uz = dz / dist;
      facingDot = fx * ux + fz * uz;
      if (facingDot < PUSH_MIN_FACING_DOT) continue;
    }

    if (
      isPushPathObstructed(
        def,
        attacker.x,
        attacker.y,
        attacker.z,
        cand.x,
        cand.y,
        cand.z,
        elapsedSec
      )
    ) {
      continue;
    }

    // Prefer targets well-aligned in front and close
    const score = facingDot * 2.0 - dist * 0.45;
    if (score > bestScore) {
      bestScore = score;
      let dirX = fx * 0.6 + ux * 0.4;
      let dirZ = fz * 0.6 + uz * 0.4;
      const dLen = Math.hypot(dirX, dirZ);
      if (dLen > 1e-5) {
        dirX /= dLen;
        dirZ /= dLen;
      } else {
        dirX = fx;
        dirZ = fz;
      }
      best = {
        userId: cand.userId,
        dirX,
        dirZ,
        dist,
      };
    }
  }

  return best;
}

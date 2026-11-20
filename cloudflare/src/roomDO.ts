import { getLevelById, isValidLevelId } from '../../src/game/levels.ts';
import {
  computeSerpentSteerAngle,
  resetSerpentNavProgress,
  resolvePatrolTarget,
  selectClosestPatrolWaypoint,
  updateSerpentProgressAndYaw,
} from '../../src/game/serpentNav.ts';
import { LevelSpatialGrid } from '../../src/game/spatialGrid.ts';
import { normalizeCharacterId, type CharacterId, type LevelDef, type PlatformDef } from '../../src/game/types.ts';
import {
  EAT_DURATION_MS,
  MAX_ROOM_PLAYERS,
  MIN_ROOM_PLAYERS,
  PUSH_COOLDOWN_MS,
  PUSH_FORCE_HORIZ,
  PUSH_FORCE_LIFT_Y,
  PUSH_RECOVERY_MS,
  type ClientPlayerInputPacket,
  type ClientPushPacket,
  type GamePlayerEvent,
  type MatchResultSummary,
  type MonsterNetState,
  type PlayerAnimSyncState,
  type PlayerNetState,
  type PublicUser,
  type RoomInviteInfo,
  type RoomPlayerInfo,
  type RoomState,
  type RoomVoicePeerState,
  type VoiceSignalKind,
} from '../../src/multiplayer/types.ts';
import { computePushNudge, selectPushTarget } from '../../src/multiplayer/pushPhysics.ts';
import type { DeliveryMessage, Env, RoomDeliveryBatch } from './types.ts';

interface InternalRoomPlayer extends RoomPlayerInfo {
  characterId: CharacterId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  animState: PlayerAnimSyncState;
  horizSpeed: number;
  velX: number;
  velY: number;
  velZ: number;
  inWater: boolean;
  lastUpdateAt: number;
  lastPushAt: number;
  pushImmunityUntil: number;
  beingEatenUntil: number;
  beingEatenByMonsterId: string | null;
}

interface InternalMonster extends MonsterNetState {
  waypoints: [number, number][];
  patrolSpeed: number;
  chaseSpeed: number;
  waterDetectionRadius: number;
  scale: number;
  avoidDir: 1 | -1;
  avoidTimer: number;
  stuckTimer: number;
  navBestDist: number;
  navStallTimer: number;
  navAnchorX: number;
  navAnchorZ: number;
  navAnchorTimer: number;
  navTurnAccum: number;
  diveTimer?: number;
  attackHoldUntil?: number;
  eatingStartAt?: number;
  eatingUntil?: number;
}

interface InternalRoom {
  id: string;
  code: string;
  hostId: string;
  levelId: number;
  status: 'lobby' | 'playing' | 'ended';
  players: Map<string, InternalRoomPlayer>;
  invites: Map<string, RoomInviteInfo>;
  monsters: InternalMonster[];
  levelDef: LevelDef;
  matchStartTime: number | null;
  timeRemaining: number;
  matchResult: MatchResultSummary | null;
  lastTickMs: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function shortestAngleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function worldToRotatedPlatformLocal(
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

function getLevelDef(levelId: number): LevelDef {
  return getLevelById(levelId);
}

export class GameRoomDO {
  private ctx: DurableObjectState;
  private env: Env;
  private room: InternalRoom | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectDeadlines = new Map<string, number>();
  private lastWorldBroadcastMs = 0;
  private dirtyPlayersSinceBroadcast = false;
  private tickDeliverInFlight = false;
  private spatialGrids = new Map<number, LevelSpatialGrid>();
  private scratchPlats: number[] = [];
  private scratchWalls: number[] = [];
  private aliveInWaterScratch: InternalRoomPlayer[] = [];
  private claimedTargetsScratch = new Set<string>();
  private _cbDef: LevelDef | null = null;
  private _cbBotY = 0;
  private _cbTopY = 0;
  private _cbElapsed = 0;
  private readonly checkMonsterBlockedFn = (cx: number, cz: number, cr: number): boolean =>
    this.isCircleBlocked(this._cbDef!, cx, cz, cr, this._cbBotY, this._cbTopY, this._cbElapsed);

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  private scheduleNextAlarm(delayMs = 100): void {
    const now = Date.now();
    let targetMs = Infinity;
    if (this.room && this.room.status === 'playing') {
      targetMs = now + Math.max(50, delayMs);
    }
    for (const deadline of this.disconnectDeadlines.values()) {
      if (deadline < targetMs) targetMs = deadline;
    }
    if (!Number.isFinite(targetMs)) {
      if (typeof this.ctx?.storage?.deleteAlarm === 'function') {
        void this.ctx.storage.deleteAlarm().catch(() => {});
      }
      return;
    }
    if (typeof this.ctx?.storage?.setAlarm === 'function') {
      void this.ctx.storage.setAlarm(Math.max(now + 25, targetMs)).catch(() => {});
    }
  }

  public async alarm(): Promise<void> {
    const now = Date.now();
    const batch = this.createBatch();
    let didWork = false;

    // Expire any disconnected players past grace deadline
    if (this.room && this.disconnectDeadlines.size > 0) {
      for (const [uid, deadline] of Array.from(this.disconnectDeadlines.entries())) {
        if (now >= deadline) {
          this.disconnectDeadlines.delete(uid);
          const p = this.room?.players.get(uid);
          if (p && !p.connected) {
            this.removePlayerInternal(uid, 'left', batch);
            didWork = true;
          }
        }
      }
    }

    if (this.room && this.room.status === 'playing') {
      if (this.dirtyPlayersSinceBroadcast || now - this.lastWorldBroadcastMs >= 40) {
        this.advanceRoomSimulation(this.room, now, batch, true);
        didWork = true;
      }
    }

    if (didWork) {
      await this.deliverBatchAsync(batch);
    }

    if ((this.room && this.room.status === 'playing') || this.disconnectDeadlines.size > 0) {
      this.scheduleNextAlarm(90);
    }
  }

  private getLevelGrid(def: LevelDef): LevelSpatialGrid {
    let grid = this.spatialGrids.get(def.id);
    if (!grid) {
      grid = new LevelSpatialGrid(def, 12);
      this.spatialGrids.set(def.id, grid);
    }
    return grid;
  }

  private getDisconnectGraceMs(): number {
    const parsed = Number(this.env.DISCONNECT_GRACE_MS || 8000);
    return Number.isFinite(parsed) && parsed >= 500 ? parsed : 8000;
  }

  private makeRoomPlayer(user: PublicUser, isHost: boolean, levelDef: LevelDef): InternalRoomPlayer {
    return {
      userId: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
      avatarIcon: user.avatarIcon,
      characterId: 'male',
      isHost,
      isBot: false,
      connected: true,
      alive: true,
      escaped: false,
      checkpointIndex: 0,
      x: levelDef.spawn[0],
      y: levelDef.spawn[1],
      z: levelDef.spawn[2],
      yaw: Math.PI,
      animState: 'idle',
      horizSpeed: 0,
      velX: 0,
      velY: 0,
      velZ: 0,
      inWater: false,
      lastUpdateAt: Date.now(),
      lastPushAt: 0,
      pushImmunityUntil: 0,
      beingEatenUntil: 0,
      beingEatenByMonsterId: null,
      voice: {
        voiceActive: false,
        micEnabled: false,
        selfMuted: false,
        speaking: false,
      },
    };
  }

  private serializeRoom(room: InternalRoom): RoomState {
    return {
      id: room.id,
      code: room.code,
      hostId: room.hostId,
      levelId: room.levelId,
      status: room.status,
      isPrivate: true,
      minPlayers: MIN_ROOM_PLAYERS,
      maxPlayers: MAX_ROOM_PLAYERS,
      players: Array.from(room.players.values()).map((p) => ({
        userId: p.userId,
        username: p.username,
        avatarColor: p.avatarColor,
        avatarIcon: p.avatarIcon,
        characterId: p.characterId,
        isHost: p.userId === room.hostId,
        isBot: false,
        connected: p.connected,
        alive: p.alive,
        escaped: p.escaped,
        checkpointIndex: p.checkpointIndex,
        voice: { ...p.voice },
      })),
      invitedFriendIds: Array.from(room.invites.keys()),
      matchStartTime: room.matchStartTime,
    };
  }

  private serializeNetPlayers(room: InternalRoom, compact = false): PlayerNetState[] {
    const out: PlayerNetState[] = [];
    for (const p of room.players.values()) {
      if (compact) {
        out.push({
          userId: p.userId,
          characterId: p.characterId,
          x: r3(p.x),
          y: r3(p.y),
          z: r3(p.z),
          yaw: r3(p.yaw),
          animState: p.animState,
          horizSpeed: r2(p.horizSpeed),
          velX: r2(p.velX),
          velY: r2(p.velY),
          velZ: r2(p.velZ),
          inWater: p.inWater,
          alive: p.alive,
          escaped: p.escaped,
          checkpointIndex: p.checkpointIndex,
        });
      } else {
        out.push({
          userId: p.userId,
          username: p.username,
          avatarColor: p.avatarColor,
          characterId: p.characterId,
          x: r3(p.x),
          y: r3(p.y),
          z: r3(p.z),
          yaw: r3(p.yaw),
          animState: p.animState,
          horizSpeed: r2(p.horizSpeed),
          velX: r2(p.velX),
          velY: r2(p.velY),
          velZ: r2(p.velZ),
          inWater: p.inWater,
          alive: p.alive,
          escaped: p.escaped,
          checkpointIndex: p.checkpointIndex,
        });
      }
    }
    return out;
  }

  private serializeNetMonsters(room: InternalRoom): MonsterNetState[] {
    const out: MonsterNetState[] = [];
    for (let i = 0; i < room.monsters.length; i++) {
      const m = room.monsters[i];
      out.push({
        id: m.id,
        x: r3(m.x),
        y: r3(m.y),
        z: r3(m.z),
        yaw: r3(m.yaw),
        velX: r2(m.velX),
        velZ: r2(m.velZ),
        alert: m.alert,
        targetUserId: m.targetUserId,
        emerged: m.emerged,
        wpIndex: m.wpIndex,
        eatingUserId: m.eatingUserId ?? null,
        eatingProgress: r3(m.eatingProgress ?? 0),
      });
    }
    return out;
  }

  private roomPlayerIds(room: InternalRoom): string[] {
    return Array.from(room.players.keys());
  }

  private async deliverBatchAsync(batch: RoomDeliveryBatch): Promise<void> {
    if (
      batch.deliveries.length === 0 &&
      !batch.closedRoom &&
      !batch.removedUsers?.length &&
      !batch.joinedUsers?.length &&
      !batch.presenceChangedUserIds?.length &&
      !batch.purgedInvites?.length
    ) {
      return;
    }
    const hubId = this.env.PRESENCE_HUB.idFromName('global-presence-hub');
    const hub = this.env.PRESENCE_HUB.get(hubId);
    await hub.fetch('https://presence-hub/internal/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  }

  private stopLoopAndTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.disconnectDeadlines.clear();
    if (typeof this.ctx?.storage?.deleteAlarm === 'function') {
      void this.ctx.storage.deleteAlarm().catch(() => {});
    }
  }

  private createBatch(): RoomDeliveryBatch {
    return {
      deliveries: [],
      joinedUsers: [],
      removedUsers: [],
      presenceChangedUserIds: [],
      purgedInvites: [],
    };
  }

  private pushRoomBroadcast(batch: RoomDeliveryBatch, room: InternalRoom, event: string, payload: unknown): void {
    const targets = this.roomPlayerIds(room);
    if (targets.length === 0) return;
    batch.deliveries.push({ targetUserIds: targets, event, payload });
  }

  private transferHost(room: InternalRoom, previousHostId: string, batch: RoomDeliveryBatch): void {
    const candidates = Array.from(room.players.values()).filter((p) => p.userId !== previousHostId);
    if (candidates.length === 0) return;

    const nextHost = candidates.find((c) => c.connected) || candidates[0];
    const oldHost = room.players.get(previousHostId);
    if (oldHost) oldHost.isHost = false;
    nextHost.isHost = true;
    room.hostId = nextHost.userId;

    const ev: GamePlayerEvent = {
      userId: nextHost.userId,
      username: nextHost.username,
      kind: 'host_transferred',
    };
    this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
  }

  private destroyRoomInternal(reason: string, batch: RoomDeliveryBatch): void {
    const room = this.room;
    if (!room) return;
    this.stopLoopAndTimers();

    for (const [uid, inv] of room.invites.entries()) {
      batch.purgedInvites!.push({ userId: uid, inviteId: inv.id, reason: 'room_closed' });
    }
    room.invites.clear();

    const affectedUserIds = Array.from(room.players.keys());
    this.pushRoomBroadcast(batch, room, 'room:closed', { roomId: room.id, reason });
    batch.closedRoom = {
      roomId: room.id,
      code: room.code,
      affectedUserIds,
    };
    for (const uid of affectedUserIds) {
      batch.presenceChangedUserIds!.push(uid);
    }

    room.players.clear();
    this.room = null;
  }

  private removePlayerInternal(
    userId: string,
    reason: 'left' | 'kicked',
    batch: RoomDeliveryBatch
  ): void {
    const room = this.room;
    if (!room) return;
    const removed = room.players.get(userId);
    if (!removed) return;

    this.disconnectDeadlines.delete(userId);

    const wasHost = room.hostId === userId;
    room.players.delete(userId);
    for (const m of room.monsters) {
      if (m.eatingUserId === userId) {
        m.eatingUserId = null;
        m.eatingStartAt = 0;
        m.eatingUntil = 0;
        m.eatingProgress = 0;
      }
    }
    batch.removedUsers!.push({ userId, roomId: room.id });
    batch.presenceChangedUserIds!.push(userId);

    this.pushRoomBroadcast(batch, room, 'voice:peer_left', { roomId: room.id, userId });

    if (reason === 'kicked') {
      batch.deliveries.push({
        targetUserId: userId,
        event: 'room:kicked',
        payload: {
          roomId: room.id,
          reason: 'You were removed from the room by the host.',
        },
      });
    } else {
      batch.deliveries.push({
        targetUserId: userId,
        event: 'room:state',
        payload: null,
      });
    }

    if (room.players.size === 0) {
      this.destroyRoomInternal('Room closed because all players left.', batch);
      return;
    }

    if (wasHost) {
      this.transferHost(room, userId, batch);
    }

    if (room.status === 'playing') {
      const ev: GamePlayerEvent = {
        userId: removed.userId,
        username: removed.username,
        kind: 'left',
      };
      this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
      this.evaluateMatchResolution(room, batch);
    }

    if (this.room) {
      const summary = this.serializeRoom(room);
      batch.roomSummary = summary;
      this.pushRoomBroadcast(batch, room, 'room:state', summary);
    }
  }

  private isPlayerOnPlatform(
    def: LevelDef,
    x: number,
    y: number,
    z: number,
    elapsedSec = 0,
    clientInWater = false
  ): boolean {
    // Below the waterline is always wet — never falsely protected by a nearby low platform
    if (y < def.bounds.waterY - 0.12) {
      return false;
    }
    // When client already reports swimming in water, only reject water if clearly standing inside platform footprint
    const margin = clientInWater ? 0.04 : 0.36;
    const minBelowTop = clientInWater ? 0.06 : 0.16;
    this.getLevelGrid(def).queryRadius(x, z, 2.5, this.scratchPlats, null);
    for (let i = 0; i < this.scratchPlats.length; i++) {
      const plat = def.platforms[this.scratchPlats[i]];
      const [pw, ph, pd] = plat.size;
      let px = plat.position[0];
      let py = plat.position[1];
      let pz = plat.position[2];
      if (plat.kind === 'moving' && plat.moveOffset) {
        const speed = plat.moveSpeed ?? 1.0;
        const phase = plat.movePhase ?? 0;
        const factor = 0.5 - 0.5 * Math.cos(elapsedSec * speed + phase);
        px += plat.moveOffset[0] * factor;
        py += plat.moveOffset[1] * factor;
        pz += plat.moveOffset[2] * factor;
      }

      if (plat.rotationSpeed) {
        const hw = pw * 0.5;
        const hh = ph * 0.5;
        const hd = pd * 0.5;
        const axis = plat.rotationAxis || 'y';
        const rotMargin = clientInWater ? 0.08 : 0.48;
        if (axis === 'y') {
          const topY = py + hh;
          if (y >= topY - minBelowTop && y <= topY + 0.5 && y >= def.bounds.waterY - 0.06) {
            const [lx, , lz] = worldToRotatedPlatformLocal(x - px, 0, z - pz, plat, elapsedSec);
            if (Math.abs(lx) <= hw + rotMargin && Math.abs(lz) <= hd + rotMargin) {
              return true;
            }
          }
        } else if (y >= def.bounds.waterY - 0.06) {
          const [lx, ly, lz] = worldToRotatedPlatformLocal(x - px, y - py, z - pz, plat, elapsedSec);
          const ox = Math.max(0, Math.abs(lx) - hw);
          const oy = Math.max(0, Math.abs(ly) - hh);
          const oz = Math.max(0, Math.abs(lz) - hd);
          if (ox * ox + oy * oy + oz * oz <= rotMargin * rotMargin) {
            return true;
          }
        }
        continue;
      }
      const topY = py + ph * 0.5;
      if (y >= topY - minBelowTop && y <= topY + 0.45 && y >= def.bounds.waterY - 0.06) {
        if (plat.kind === 'moving' && plat.moveOffset) {
          const minX = Math.min(plat.position[0], plat.position[0] + plat.moveOffset[0]) - pw * 0.5 - margin;
          const maxX = Math.max(plat.position[0], plat.position[0] + plat.moveOffset[0]) + pw * 0.5 + margin;
          const minZ = Math.min(plat.position[2], plat.position[2] + plat.moveOffset[2]) - pd * 0.5 - margin;
          const maxZ = Math.max(plat.position[2], plat.position[2] + plat.moveOffset[2]) + pd * 0.5 + margin;
          if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return true;
        } else if (Math.abs(x - px) <= pw * 0.5 + margin && Math.abs(z - pz) <= pd * 0.5 + margin) {
          return true;
        }
      }
    }
    return false;
  }

  private isPlayerInWaterServer(
    def: LevelDef,
    x: number,
    y: number,
    z: number,
    clientInWater: boolean,
    elapsedSec = 0
  ): boolean {
    if (y < def.bounds.waterY - 0.12) return true;
    if (this.isPlayerOnPlatform(def, x, y, z, elapsedSec, clientInWater)) return false;
    if (clientInWater && y <= def.bounds.waterY + 0.06) return true;
    return y < def.bounds.waterY - 0.04;
  }

  private isCircleBlocked(
    def: LevelDef,
    x: number,
    z: number,
    radius: number,
    botY: number,
    topY: number,
    elapsedSec = 0,
    checkWalls = true,
    checkPlats = true
  ): boolean {
    const b = def.bounds;
    if (checkWalls && (x - radius < b.minX || x + radius > b.maxX || z - radius < b.minZ || z + radius > b.maxZ)) {
      return true;
    }
    const rSq = radius * radius;
    this.getLevelGrid(def).queryRadius(x, z, radius + 0.5, this.scratchPlats, this.scratchWalls);
    if (checkWalls) {
      for (let i = 0; i < this.scratchWalls.length; i++) {
        const w = def.walls[this.scratchWalls[i]];
        const [wx, wy, wz] = w.position;
        const [ww, wh, wd] = w.size;
        if (topY <= wy - wh * 0.5 + 0.05 || botY >= wy + wh * 0.5 - 0.05) continue;
        const cx = clamp(x, wx - ww * 0.5, wx + ww * 0.5);
        const cz = clamp(z, wz - wd * 0.5, wz + wd * 0.5);
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz < rSq) return true;
      }
    }
    if (!checkPlats) return false;
    for (let i = 0; i < this.scratchPlats.length; i++) {
      const plat = def.platforms[this.scratchPlats[i]];
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
        if (topY <= py - hh + 0.05 || botY >= py + hh - 0.05) continue;
        const cx = clamp(x, px - hw, px + hw);
        const cz = clamp(z, pz - hd, pz + hd);
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz < rSq) return true;
      } else if ((plat.rotationAxis || 'y') === 'y') {
        if (topY <= py - hh + 0.05 || botY >= py + hh - 0.05) continue;
        const [lx, , lz] = worldToRotatedPlatformLocal(x - px, 0, z - pz, plat, elapsedSec);
        const dlx = lx - clamp(lx, -hw, hw);
        const dlz = lz - clamp(lz, -hd, hd);
        if (dlx * dlx + dlz * dlz < rSq) return true;
      } else {
        const spanY = Math.max(0.1, topY - botY);
        const padY = Math.min(radius * 0.5, spanY * 0.25);
        const yMin = botY + padY;
        const yMax = topY - padY;
        for (let sIdx = 0; sIdx < 4; sIdx++) {
          const sy = yMin + ((yMax - yMin) * sIdx) / 3;
          const [lx, ly, lz] = worldToRotatedPlatformLocal(x - px, sy - py, z - pz, plat, elapsedSec);
          const dlx = lx - clamp(lx, -hw, hw);
          const dly = ly - clamp(ly, -hh, hh);
          const dlz = lz - clamp(lz, -hd, hd);
          if (dlx * dlx + dly * dly + dlz * dlz < rSq) return true;
        }
      }
    }
    return false;
  }

  private resolveMonsterCircleSolids(
    def: LevelDef,
    m: InternalMonster,
    radius: number,
    botY: number,
    topY: number,
    elapsedSec: number
  ): void {
    const b = def.bounds;
    const rSq = radius * radius;
    const grid = this.getLevelGrid(def);

    for (let iter = 0; iter < 2; iter++) {
      grid.queryRadius(m.x, m.z, radius + 0.5, this.scratchPlats, this.scratchWalls);
      for (let i = 0; i < this.scratchPlats.length; i++) {
        const plat = def.platforms[this.scratchPlats[i]];
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
        const axis = plat.rotationAxis || 'y';

        if (!plat.rotationSpeed) {
          if (topY <= py - hh + 0.05 || botY >= py + hh - 0.05) continue;
          const lx = m.x - px;
          const lz = m.z - pz;
          const dlx = lx - clamp(lx, -hw, hw);
          const dlz = lz - clamp(lz, -hd, hd);
          const dSq = dlx * dlx + dlz * dlz;
          if (dSq < rSq) {
            let wx = 0;
            let wz = 0;
            if (dSq > 1e-8) {
              const d = Math.sqrt(dSq);
              const pen = radius - d;
              wx = (dlx / d) * pen;
              wz = (dlz / d) * pen;
            } else {
              const penX = hw + radius - Math.abs(lx);
              const penZ = hd + radius - Math.abs(lz);
              if (penX < penZ) wx = lx >= 0 ? penX : -penX;
              else wz = lz >= 0 ? penZ : -penZ;
            }
            m.x += wx;
            m.z += wz;
            const wLen = Math.hypot(wx, wz);
            if (wLen > 1e-6) {
              const nx = wx / wLen;
              const nz = wz / wLen;
              const vn = m.velX * nx + m.velZ * nz;
              if (vn < 0) {
                m.velX -= vn * nx;
                m.velZ -= vn * nz;
              }
            }
          }
        } else if (axis === 'y') {
          if (topY <= py - hh + 0.05 || botY >= py + hh - 0.05) continue;
          const ang = (plat.rotationPhase ?? 0) + elapsedSec * plat.rotationSpeed;
          const [lx, , lz] = worldToRotatedPlatformLocal(m.x - px, 0, m.z - pz, plat, elapsedSec);
          const dlx = lx - clamp(lx, -hw, hw);
          const dlz = lz - clamp(lz, -hd, hd);
          const dSq = dlx * dlx + dlz * dlz;
          if (dSq < rSq) {
            let lwx = 0;
            let lwz = 0;
            if (dSq > 1e-8) {
              const d = Math.sqrt(dSq);
              const pen = radius - d;
              lwx = (dlx / d) * pen;
              lwz = (dlz / d) * pen;
            } else {
              const penX = hw + radius - Math.abs(lx);
              const penZ = hd + radius - Math.abs(lz);
              if (penX < penZ) lwx = lx >= 0 ? penX : -penX;
              else lwz = lz >= 0 ? penZ : -penZ;
            }
            const cy = Math.cos(ang);
            const sy = Math.sin(ang);
            const wx = lwx * cy + lwz * sy;
            const wz = -lwx * sy + lwz * cy;
            m.x += wx;
            m.z += wz;
            const wLen = Math.hypot(wx, wz);
            if (wLen > 1e-6) {
              const nx = wx / wLen;
              const nz = wz / wLen;
              const vn = m.velX * nx + m.velZ * nz;
              if (vn < 0) {
                m.velX -= vn * nx;
                m.velZ -= vn * nz;
              }
            }
          }
        } else {
          const spanY = Math.max(0.1, topY - botY);
          const padY = Math.min(radius * 0.5, spanY * 0.25);
          const yMin = botY + padY;
          const yMax = topY - padY;
          const spd = plat.rotationSpeed;
          const phase = plat.rotationPhase ?? 0;
          const ry = phase + elapsedSec * spd;
          const rx = axis === 'x' ? ry : axis === 'xy' ? phase * 0.7 + elapsedSec * spd * 0.55 : 0;
          const rz = axis === 'z' ? ry : axis === 'zy' ? phase * 0.7 + elapsedSec * spd * 0.55 : 0;
          const ey = axis === 'x' || axis === 'z' ? 0 : ry;

          let bestDSq = rSq;
          let bestLwx = 0;
          let bestLwz = 0;
          for (let sIdx = 0; sIdx < 4; sIdx++) {
            const sy = yMin + ((yMax - yMin) * sIdx) / 3;
            const [lx, ly, lz] = worldToRotatedPlatformLocal(m.x - px, sy - py, m.z - pz, plat, elapsedSec);
            const dlx = lx - clamp(lx, -hw, hw);
            const dly = ly - clamp(ly, -hh, hh);
            const dlz = lz - clamp(lz, -hd, hd);
            const dSq = dlx * dlx + dly * dly + dlz * dlz;
            if (dSq < bestDSq) {
              bestDSq = dSq;
              if (dSq > 1e-8) {
                const d = Math.sqrt(dSq);
                const pen = radius - d;
                bestLwx = (dlx / d) * pen;
                bestLwz = (dlz / d) * pen;
              } else {
                const penX = hw + radius - Math.abs(lx);
                const penZ = hd + radius - Math.abs(lz);
                bestLwx = penX < penZ ? (lx >= 0 ? penX : -penX) : 0;
                bestLwz = penX < penZ ? 0 : (lz >= 0 ? penZ : -penZ);
              }
            }
          }
          if (bestDSq < rSq) {
            const cz = Math.cos(rz);
            const sz = Math.sin(rz);
            const x1 = bestLwx * cz;
            const y1 = bestLwx * sz;
            const z1 = bestLwz;
            const cx = Math.cos(rx);
            const sx = Math.sin(rx);
            const x2 = x1;
            const z2 = y1 * sx + z1 * cx;
            const cy = Math.cos(ey);
            const sy2 = Math.sin(ey);
            const wx = x2 * cy + z2 * sy2;
            const wz = -x2 * sy2 + z2 * cy;
            m.x += wx;
            m.z += wz;
            const wLen = Math.hypot(wx, wz);
            if (wLen > 1e-6) {
              const nx = wx / wLen;
              const nz = wz / wLen;
              const vn = m.velX * nx + m.velZ * nz;
              if (vn < 0) {
                m.velX -= vn * nx;
                m.velZ -= vn * nz;
              }
            }
          }
        }
      }

      for (let i = 0; i < this.scratchWalls.length; i++) {
        const w = def.walls[this.scratchWalls[i]];
        const [ww, wh, wd] = w.size;
        const [wxPos, wyPos, wzPos] = w.position;
        if (topY <= wyPos - wh * 0.5 + 0.05 || botY >= wyPos + wh * 0.5 - 0.05) continue;
        const cx = clamp(m.x, wxPos - ww * 0.5, wxPos + ww * 0.5);
        const cz = clamp(m.z, wzPos - wd * 0.5, wzPos + wd * 0.5);
        const dx = m.x - cx;
        const dz = m.z - cz;
        const dSq = dx * dx + dz * dz;
        if (dSq < rSq) {
          let wx = 0;
          let wz = 0;
          if (dSq > 1e-8) {
            const d = Math.sqrt(dSq);
            const pen = radius - d;
            wx = (dx / d) * pen;
            wz = (dz / d) * pen;
          } else {
            const dLeft = m.x - (wxPos - ww * 0.5 - radius);
            const dRight = wxPos + ww * 0.5 + radius - m.x;
            const dFront = m.z - (wzPos - wd * 0.5 - radius);
            const dBack = wzPos + wd * 0.5 + radius - m.z;
            const minPen = Math.min(dLeft, dRight, dFront, dBack);
            if (minPen === dLeft) wx = -dLeft;
            else if (minPen === dRight) wx = dRight;
            else if (minPen === dFront) wz = -dFront;
            else wz = dBack;
          }
          m.x += wx;
          m.z += wz;
          const wLen = Math.hypot(wx, wz);
          if (wLen > 1e-6) {
            const nx = wx / wLen;
            const nz = wz / wLen;
            const vn = m.velX * nx + m.velZ * nz;
            if (vn < 0) {
              m.velX -= vn * nx;
              m.velZ -= vn * nz;
            }
          }
        }
      }

      m.x = clamp(m.x, b.minX + radius + 0.15, b.maxX - radius - 0.15);
      m.z = clamp(m.z, b.minZ + radius + 0.15, b.maxZ - radius - 0.15);
    }
  }

  private updateRoomMonsters(room: InternalRoom, dt: number, batch: RoomDeliveryBatch): void {
    const def = room.levelDef;
    const waterY = def.bounds.waterY;
    const now = Date.now();
    const elapsedSec = room.matchStartTime ? Math.max(0, (now - room.matchStartTime) / 1000) : 0;
    const aliveInWater = this.aliveInWaterScratch;
    aliveInWater.length = 0;
    for (const p of room.players.values()) {
      if (p.alive && !p.escaped && p.connected && p.inWater && (!p.beingEatenUntil || now >= p.beingEatenUntil)) {
        aliveInWater.push(p);
      }
    }
    const claimedTargets = this.claimedTargetsScratch;
    claimedTargets.clear();

    // Guarantee EVERY swimmer in water is immediately chased by the nearest available serpent,
    // even if monster 0 is busy eating another player or across a large sector.
    const forcedChaseByMonster = new Map<number, InternalRoomPlayer>();
    if (aliveInWater.length > 0 && room.monsters.length > 0) {
      const assignedMonsters = new Set<number>();
      for (const swimmer of aliveInWater) {
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let mi = 0; mi < room.monsters.length; mi++) {
          if (assignedMonsters.has(mi)) continue;
          const mm = room.monsters[mi];
          if (mm.eatingUntil && mm.eatingUserId && now < mm.eatingUntil) continue;
          const d = Math.hypot(swimmer.x - mm.x, swimmer.z - mm.z);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = mi;
          }
        }
        if (bestIdx >= 0) {
          assignedMonsters.add(bestIdx);
          forcedChaseByMonster.set(bestIdx, swimmer);
          claimedTargets.add(swimmer.userId);
        }
      }
    }

    for (let i = 0; i < room.monsters.length; i++) {
      const m = room.monsters[i];

      if (m.eatingUntil && m.eatingUserId) {
        const victim = room.players.get(m.eatingUserId);
        if (!victim || !victim.connected || !victim.alive) {
          m.eatingUserId = null;
          m.eatingStartAt = 0;
          m.eatingUntil = 0;
          m.eatingProgress = 0;
        } else if (now < m.eatingUntil) {
          m.alert = 'chasing';
          m.emerged = true;
          m.targetUserId = victim.userId;
          m.velX *= 0.8;
          m.velZ *= 0.8;
          m.eatingProgress = clamp((now - (m.eatingStartAt || now)) / EAT_DURATION_MS, 0, 1);
          m.y += (waterY + 0.08 - m.y) * Math.min(1, 5.5 * dt);
          continue;
        } else {
          victim.alive = false;
          victim.beingEatenUntil = 0;
          victim.beingEatenByMonsterId = null;
          const ev: GamePlayerEvent = {
            userId: victim.userId,
            username: victim.username,
            kind: 'caught',
            x: victim.x,
            y: victim.y,
            z: victim.z,
            monsterId: m.id,
          };
          this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
          m.eatingUserId = null;
          m.eatingStartAt = 0;
          m.eatingUntil = 0;
          m.eatingProgress = 0;
          m.attackHoldUntil = now + 450;
          m.velX = 0;
          m.velZ = 0;
          resetSerpentNavProgress(m);
        }
      }

      const forcedTarget = forcedChaseByMonster.get(i) || null;
      let target: InternalRoomPlayer | null = forcedTarget;
      let targetDist = forcedTarget ? Math.hypot(forcedTarget.x - m.x, forcedTarget.z - m.z) : Infinity;

      if (!target && aliveInWater.length > 0) {
        let unclaimedTarget: InternalRoomPlayer | null = null;
        let unclaimedDist = Infinity;
        let anyTarget: InternalRoomPlayer | null = null;
        let anyDist = Infinity;
        for (const p of aliveInWater) {
          const d = Math.hypot(p.x - m.x, p.z - m.z);
          if (d < anyDist) {
            anyDist = d;
            anyTarget = p;
          }
          if (!claimedTargets.has(p.userId) && d < unclaimedDist) {
            unclaimedDist = d;
            unclaimedTarget = p;
          }
        }
        if (unclaimedTarget && unclaimedDist <= m.waterDetectionRadius) {
          target = unclaimedTarget;
          targetDist = unclaimedDist;
        } else if (anyTarget && (anyDist <= m.waterDetectionRadius || i === 0)) {
          target = anyTarget;
          targetDist = anyDist;
        }
      }

      const shouldChase = Boolean(target && (Boolean(forcedTarget) || targetDist <= m.waterDetectionRadius || i === 0));
      if (shouldChase && target) {
        claimedTargets.add(target.userId);
      }
      const extremeChaseSpeed = Math.max(48.0, m.chaseSpeed * 7.2);
      const holdingStrike = Boolean(m.attackHoldUntil && now < m.attackHoldUntil);

      const monsterRadius = 0.88 * m.scale;
      const monsterBotY = waterY - 1.5;
      const monsterTopY = waterY + 4.2 * m.scale;
      this._cbDef = def;
      this._cbBotY = monsterBotY;
      this._cbTopY = monsterTopY;
      this._cbElapsed = elapsedSec;
      const checkMonsterBlocked = this.checkMonsterBlockedFn;

      if (shouldChase && target) {
        m.attackHoldUntil = 0;
        if (m.alert !== 'chasing') {
          m.alert = 'chasing';
          const dx = target.x - m.x;
          const dz = target.z - m.z;
          const len = Math.hypot(dx, dz);
          if (len > 0.01) {
            const nx = dx / len;
            const nz = dz / len;
            m.yaw = Math.atan2(nx, nz);
            m.velX = nx * extremeChaseSpeed;
            m.velZ = nz * extremeChaseSpeed;
          }
          resetSerpentNavProgress(m);
        }
        m.emerged = targetDist < 10.5;
        m.targetUserId = target.userId;
      } else if (holdingStrike) {
        m.alert = 'chasing';
        m.emerged = true;
        m.velX *= 0.85;
        m.velZ *= 0.85;
      } else {
        m.attackHoldUntil = 0;
        if (m.alert !== 'calm') {
          m.alert = 'calm';
          m.emerged = false;
          m.targetUserId = null;
          const spd = Math.hypot(m.velX, m.velZ);
          if (spd > m.patrolSpeed && spd > 0.01) {
            const damp = m.patrolSpeed / spd;
            m.velX *= damp;
            m.velZ *= damp;
          }
          m.avoidTimer = 0;
          selectClosestPatrolWaypoint(m, monsterRadius, checkMonsterBlocked);
        }
      }

      let tx = m.x;
      let tz = m.z;
      let moveSpeed = m.patrolSpeed;
      let hasMoveTarget = false;

      if (m.alert === 'chasing' && target) {
        tx = target.x;
        tz = target.z;
        moveSpeed = extremeChaseSpeed;
        hasMoveTarget = Math.hypot(tx - m.x, tz - m.z) > 0.05;
      } else if (holdingStrike) {
        tx = m.x;
        tz = m.z;
        moveSpeed = 0;
        hasMoveTarget = false;
      } else {
        const patrolTarget = resolvePatrolTarget(m, monsterRadius, checkMonsterBlocked);
        tx = patrolTarget.tx;
        tz = patrolTarget.tz;
        hasMoveTarget = patrolTarget.hasTarget;
      }

      const isChasing = m.alert === 'chasing';
      const minSafeY = def.bounds.floorY + 0.55 * m.scale;
      let lowestNearbyPlatBottom = waterY - 0.35;
      this.getLevelGrid(def).queryRadius(m.x, m.z, isChasing ? 16 : 10, this.scratchPlats, null);
      for (let pi = 0; pi < this.scratchPlats.length; pi++) {
        const plat = def.platforms[this.scratchPlats[pi]];
        if (!plat || plat.kind === 'disappearing') continue;
        let py = plat.position[1];
        if (plat.kind === 'moving' && plat.moveOffset) {
          const factor = 0.5 - 0.5 * Math.cos(elapsedSec * (plat.moveSpeed ?? 1.0) + (plat.movePhase ?? 0));
          py += plat.moveOffset[1] * factor;
        }
        const platBot = py - plat.size[1] * 0.5;
        if (platBot <= waterY + 0.6 && platBot > def.bounds.floorY + 0.8 && platBot < lowestNearbyPlatBottom) {
          lowestNearbyPlatBottom = platBot;
        }
      }
      const deepDiveY = clamp(
        Math.min(waterY - 2.05 * m.scale, lowestNearbyPlatBottom - 0.62 * m.scale),
        minSafeY,
        waterY - 1.15 * m.scale
      );
      const diveHalfH = 0.5 * m.scale;
      const diveBotY = deepDiveY - diveHalfH;
      const diveTopY = deepDiveY + diveHalfH;

      const platformOverhead = this.isCircleBlocked(
        def,
        m.x,
        m.z,
        monsterRadius * 1.15,
        m.y - 0.12 * m.scale,
        waterY + 1.25 * m.scale,
        elapsedSec,
        false,
        true
      );

      let corridorPlatformBlocked = false;
      if (hasMoveTarget) {
        const dTgt = Math.hypot(tx - m.x, tz - m.z);
        if (dTgt > 0.5) {
          const invD = 1 / dTgt;
          const dirX = (tx - m.x) * invD;
          const dirZ = (tz - m.z) * invD;
          const maxProbe = Math.min(dTgt, isChasing ? 18.0 : 9.0);
          const stepLen = Math.max(1.0, monsterRadius * 1.45);
          for (let d = 0.45; d <= maxProbe; d += stepLen) {
            const sx = m.x + dirX * d;
            const sz = m.z + dirZ * d;
            if (this.isCircleBlocked(def, sx, sz, monsterRadius * 0.9, diveBotY, diveTopY, elapsedSec, true, false)) {
              break;
            }
            if (
              this.isCircleBlocked(
                def,
                sx,
                sz,
                monsterRadius * 1.02,
                waterY - 1.05 * m.scale,
                waterY + 1.05 * m.scale,
                elapsedSec,
                false,
                true
              ) &&
              !this.isCircleBlocked(def, sx, sz, monsterRadius * 0.86, diveBotY, diveTopY, elapsedSec, false, true)
            ) {
              corridorPlatformBlocked = true;
              break;
            }
          }
        }
        if (!corridorPlatformBlocked) {
          const fwdX = m.x + Math.sin(m.yaw) * monsterRadius * 1.45;
          const fwdZ = m.z + Math.cos(m.yaw) * monsterRadius * 1.45;
          if (
            this.isCircleBlocked(
              def,
              fwdX,
              fwdZ,
              monsterRadius * 1.02,
              waterY - 1.05 * m.scale,
              waterY + 1.05 * m.scale,
              elapsedSec,
              false,
              true
            ) &&
            !this.isCircleBlocked(def, fwdX, fwdZ, monsterRadius * 0.86, diveBotY, diveTopY, elapsedSec, false, true)
          ) {
            corridorPlatformBlocked = true;
          }
        }
      }

      if (platformOverhead || corridorPlatformBlocked || (isChasing && m.stuckTimer > 0.16)) {
        m.diveTimer = Math.max(m.diveTimer || 0, isChasing ? 0.55 : 0.75);
      } else if ((m.diveTimer || 0) > 0) {
        if (isChasing && target && targetDist < 3.6 && !platformOverhead && !corridorPlatformBlocked) {
          m.diveTimer = 0;
        } else {
          m.diveTimer = Math.max(0, (m.diveTimer || 0) - dt);
        }
      }

      const wantDive = !holdingStrike && (platformOverhead || corridorPlatformBlocked || (m.diveTimer || 0) > 0);
      if (wantDive || m.y <= waterY - 0.85 * m.scale) {
        this._cbBotY = diveBotY;
        this._cbTopY = diveTopY;
      } else {
        this._cbBotY = monsterBotY;
        this._cbTopY = monsterTopY;
      }

      const subSteps = isChasing ? 6 : 1;
      const subDt = dt / subSteps;
      const catchDist = 2.15 * m.scale;
      let startedEating = false;
      const desiredY =
        wantDive || platformOverhead
          ? deepDiveY
          : m.alert === 'chasing' && (m.emerged || holdingStrike)
            ? waterY + 0.08
            : waterY - 0.14;
      const emergedFrac = m.emerged && m.y >= waterY - 0.55 * m.scale ? 1 : 0;

      for (let step = 0; step < subSteps; step++) {
        if (desiredY < m.y) {
          const diveRate = (isChasing ? 34.0 : 12.0) * m.scale;
          m.y = Math.max(desiredY, m.y - diveRate * subDt);
        } else if (desiredY > m.y) {
          const subOverhead = this.isCircleBlocked(
            def,
            m.x,
            m.z,
            monsterRadius * 1.15,
            m.y - 0.12 * m.scale,
            waterY + 1.25 * m.scale,
            elapsedSec,
            false,
            true
          );
          if (!subOverhead) {
            const riseRate = (isChasing ? 24.0 : 7.5) * m.scale;
            m.y = Math.min(desiredY, m.y + riseRate * subDt);
          }
        }
        m.y = clamp(m.y, def.bounds.floorY + 0.72 * m.scale, waterY + 0.08);

        const physBotY = m.y - 0.72 * m.scale;
        const physTopY = m.y + (0.68 + emergedFrac * 3.45) * m.scale;
        const prevX = m.x;
        const prevZ = m.z;
        const prevYaw = m.yaw;
        const steer = hasMoveTarget
          ? computeSerpentSteerAngle(m, tx, tz, monsterRadius, isChasing, checkMonsterBlocked)
          : { valid: false, steerAngle: m.yaw };

        if (steer.valid && moveSpeed > 0.05) {
          const blend = Math.min(1, (isChasing ? 65.0 : 8.5) * subDt);
          m.velX += (Math.sin(steer.steerAngle) * moveSpeed - m.velX) * blend;
          m.velZ += (Math.cos(steer.steerAngle) * moveSpeed - m.velZ) * blend;

          m.x += m.velX * subDt;
          m.z += m.velZ * subDt;

          this.resolveMonsterCircleSolids(def, m, monsterRadius, physBotY, physTopY, elapsedSec);

          if (this.isCircleBlocked(def, m.x, m.z, monsterRadius - 0.02, physBotY, physTopY, elapsedSec)) {
            let escaped = false;
            const escRadii = [0.25, 0.5, 0.85, 1.25];
            for (const stepR of escRadii) {
              if (escaped) break;
              for (let k = 0; k < 8; k++) {
                const ang = (k * Math.PI) / 4;
                const txEsc = m.x + Math.sin(ang) * stepR;
                const tzEsc = m.z + Math.cos(ang) * stepR;
                if (!this.isCircleBlocked(def, txEsc, tzEsc, monsterRadius, physBotY, physTopY, elapsedSec)) {
                  m.x = txEsc;
                  m.z = tzEsc;
                  escaped = true;
                  break;
                }
              }
            }
            if (!escaped) {
              m.x = prevX;
              m.z = prevZ;
            }
          }
        }

        updateSerpentProgressAndYaw(
          m,
          prevX,
          prevZ,
          prevYaw,
          moveSpeed,
          subDt,
          isChasing,
          steer.valid,
          checkMonsterBlocked,
          24.0
        );
        if (wantDive && m.y > deepDiveY + 0.35 * m.scale) {
          m.stuckTimer = 0;
        }

        if (isChasing) {
          for (const p of aliveInWater) {
            if (!p.alive || p.escaped || !p.inWater || (p.beingEatenUntil && now < p.beingEatenUntil)) continue;
            const dToVictim = Math.hypot(p.x - m.x, p.z - m.z);
            if (dToVictim < catchDist) {
              const midX = (m.x + p.x) * 0.5;
              const midZ = (m.z + p.z) * 0.5;
              const wallBlocking = this.isCircleBlocked(
                def,
                midX,
                midZ,
                0.28,
                Math.min(m.y, p.y) - 0.25,
                Math.max(m.y, p.y) + 0.5,
                elapsedSec,
                true,
                false
              );
              if (wallBlocking) continue;
              p.beingEatenUntil = now + EAT_DURATION_MS;
              p.beingEatenByMonsterId = m.id;
              m.eatingUserId = p.userId;
              m.eatingStartAt = now;
              m.eatingUntil = now + EAT_DURATION_MS;
              m.eatingProgress = 0;
              m.attackHoldUntil = 0;
              m.emerged = true;
              m.targetUserId = p.userId;
              m.velX = 0;
              m.velZ = 0;
              const ev: GamePlayerEvent = {
                userId: p.userId,
                username: p.username,
                kind: 'eating_started',
                x: p.x,
                y: p.y,
                z: p.z,
                monsterId: m.id,
              };
              this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
              startedEating = true;
              break;
            }
          }
          if (startedEating) break;
        }
      }

      if (m.eatingUntil && now < m.eatingUntil) {
        m.emerged = true;
      } else if (m.attackHoldUntil && now < m.attackHoldUntil) {
        m.emerged = true;
      } else if (m.alert === 'chasing' && target) {
        m.emerged = !wantDive && m.y >= waterY - 0.55 * m.scale && Math.hypot(target.x - m.x, target.z - m.z) < 10.5;
      }
    }

    // Monster-vs-monster separation so multi-serpent rooms never overlap heads
    for (let i = 0; i < room.monsters.length; i++) {
      for (let j = i + 1; j < room.monsters.length; j++) {
        const a = room.monsters[i];
        const b = room.monsters[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const minSep = (a.scale + b.scale) * 0.92;
        if (dist < minSep && dist > 1e-4) {
          const push = (minSep - dist) * 0.5;
          const nx = dx / dist;
          const nz = dz / dist;
          a.x -= nx * push;
          a.z -= nz * push;
          b.x += nx * push;
          b.z += nz * push;
          this.resolveMonsterCircleSolids(def, a, 0.9 * a.scale, a.y - 0.72 * a.scale, a.y + 0.72 * a.scale, elapsedSec);
          this.resolveMonsterCircleSolids(def, b, 0.9 * b.scale, b.y - 0.72 * b.scale, b.y + 0.72 * b.scale, elapsedSec);
        }
      }
    }
  }

  private evaluateMatchResolution(room: InternalRoom, batch: RoomDeliveryBatch): void {
    if (room.status !== 'playing' || room.matchResult) return;

    let activeCount = 0;
    let aliveNotEscapedCount = 0;
    let escapedCount = 0;
    for (const p of room.players.values()) {
      if (!p.connected) continue;
      activeCount++;
      if (p.escaped) escapedCount++;
      else if (p.alive) aliveNotEscapedCount++;
    }

    if (activeCount === 0) {
      this.finalizeMatch(room, 'all_caught', batch);
      return;
    }

    if (aliveNotEscapedCount === 0) {
      this.finalizeMatch(room, escapedCount > 0 ? 'all_resolved' : 'all_caught', batch);
    }
  }

  private finalizeMatch(
    room: InternalRoom,
    reason: 'all_resolved' | 'timeout' | 'all_caught',
    batch: RoomDeliveryBatch
  ): void {
    if (room.matchResult) return;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const survivors = Array.from(room.players.values())
      .filter((p) => p.escaped)
      .map((p) => ({ userId: p.userId, username: p.username }));

    const elapsed = room.matchStartTime ? Math.round(((Date.now() - room.matchStartTime) / 1000) * 10) / 10 : 0;
    room.status = 'ended';
    room.matchResult = {
      outcome: survivors.length > 0 ? 'escaped' : 'failed',
      elapsed,
      survivors,
      reason,
    };

    for (const p of room.players.values()) {
      p.beingEatenUntil = 0;
      p.beingEatenByMonsterId = null;
      batch.presenceChangedUserIds!.push(p.userId);
    }
    for (const m of room.monsters) {
      m.eatingUserId = null;
      m.eatingStartAt = 0;
      m.eatingUntil = 0;
      m.eatingProgress = 0;
    }
    const summary = this.serializeRoom(room);
    batch.roomSummary = summary;
    this.pushRoomBroadcast(batch, room, 'room:state', summary);
  }

  private advanceRoomSimulation(
    room: InternalRoom,
    now: number,
    batch: RoomDeliveryBatch,
    forceBroadcast = false
  ): void {
    if (room.status !== 'playing') return;

    const elapsedMs = Math.max(0, now - room.lastTickMs);
    if (elapsedMs >= 10) {
      const dt = Math.min(0.1, elapsedMs / 1000);
      room.lastTickMs = now;
      room.timeRemaining = Math.max(0, room.timeRemaining - dt);
      this.updateRoomMonsters(room, dt, batch);

      if (room.timeRemaining <= 0 && !room.matchResult) {
        this.finalizeMatch(room, 'timeout', batch);
      } else {
        this.evaluateMatchResolution(room, batch);
      }
    }

    if (forceBroadcast || this.dirtyPlayersSinceBroadcast || now - this.lastWorldBroadcastMs >= 36) {
      this.lastWorldBroadcastMs = now;
      this.dirtyPlayersSinceBroadcast = false;
      this.pushRoomBroadcast(batch, room, 'game:world', {
        roomId: room.id,
        serverTime: now,
        timeRemaining: r2(room.timeRemaining),
        elapsedSec: room.matchStartTime ? r2(Math.max(0, (now - room.matchStartTime) / 1000)) : 0,
        players: this.serializeNetPlayers(room, true),
        monsters: this.serializeNetMonsters(room),
        matchResult: room.matchResult,
      });
    }
  }

  private async runTick(): Promise<void> {
    const room = this.room;
    if (!room || room.status !== 'playing') return;
    if (this.tickDeliverInFlight) return;

    const now = Date.now();
    // Flush immediately if player state changed since last broadcast or 40ms elapsed
    if (!this.dirtyPlayersSinceBroadcast && now - this.lastWorldBroadcastMs < 40) return;

    const batch = this.createBatch();
    this.advanceRoomSimulation(room, now, batch, true);

    this.tickDeliverInFlight = true;
    try {
      await this.deliverBatchAsync(batch);
    } finally {
      this.tickDeliverInFlight = false;
    }
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/internal/action') {
      return new Response('Not found', { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const action = String(body.action || '');
    const batch = this.createBatch();

    try {
      switch (action) {
        case 'create': {
          const roomId = String(body.roomId || '');
          const code = String(body.code || '');
          const user = body.user as PublicUser;
          const rawLevel = typeof body.levelId === 'number' ? body.levelId : 1;
          const safeLevelId = isValidLevelId(rawLevel) ? rawLevel : 1;
          const def = getLevelDef(safeLevelId);

          this.stopLoopAndTimers();
          const room: InternalRoom = {
            id: roomId,
            code,
            hostId: user.id,
            levelId: safeLevelId,
            status: 'lobby',
            players: new Map(),
            invites: new Map(),
            monsters: [],
            levelDef: def,
            matchStartTime: null,
            timeRemaining: def.timeLimit,
            matchResult: null,
            lastTickMs: Date.now(),
          };
          room.players.set(user.id, this.makeRoomPlayer(user, true, def));
          this.room = room;

          const serialized = this.serializeRoom(room);
          batch.joinedUsers!.push({ userId: user.id, roomId: room.id, code: room.code });
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          return Response.json({ room: serialized, batch });
        }

        case 'join': {
          const room = this.room;
          if (!room) {
            return Response.json(
              { error: 'Private room not found. Check the room code and try again.' },
              { status: 404 }
            );
          }
          const user = body.user as PublicUser;
          const existing = room.players.get(user.id);
          if (existing) {
            existing.connected = true;
            this.disconnectDeadlines.delete(user.id);
            const serialized = this.serializeRoom(room);
            batch.roomSummary = serialized;
            this.pushRoomBroadcast(batch, room, 'room:state', serialized);
            return Response.json({ room: serialized, batch });
          }

          if (room.status !== 'lobby') {
            return Response.json({ error: 'This match is already in progress.' }, { status: 400 });
          }
          if (room.players.size >= MAX_ROOM_PLAYERS) {
            return Response.json(
              { error: `Room is full (${MAX_ROOM_PLAYERS}/${MAX_ROOM_PLAYERS} players).` },
              { status: 400 }
            );
          }

          const pendingInvite = room.invites.get(user.id);
          if (pendingInvite) {
            room.invites.delete(user.id);
            batch.purgedInvites!.push({
              userId: user.id,
              inviteId: pendingInvite.id,
              reason: 'accepted',
            });
          }

          room.players.set(user.id, this.makeRoomPlayer(user, false, room.levelDef));
          const serialized = this.serializeRoom(room);
          batch.joinedUsers!.push({ userId: user.id, roomId: room.id, code: room.code });
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          return Response.json({ room: serialized, batch });
        }

        case 'reconnect': {
          const room = this.room;
          if (!room) return Response.json({ room: null, batch });
          const userId = String(body.userId || '');
          const rp = room.players.get(userId);
          if (rp) {
            rp.connected = true;
            this.disconnectDeadlines.delete(userId);
            const serialized = this.serializeRoom(room);
            batch.roomSummary = serialized;
            this.pushRoomBroadcast(batch, room, 'room:state', serialized);
            const gameStarted =
              room.status === 'playing'
                ? {
                    roomId: room.id,
                    levelId: room.levelId,
                    timeLimit: room.levelDef.timeLimit,
                    elapsedSec: room.matchStartTime
                      ? Math.max(0, (Date.now() - room.matchStartTime) / 1000)
                      : 0,
                    players: this.serializeNetPlayers(room),
                    monsters: this.serializeNetMonsters(room),
                  }
                : null;
            return Response.json({ room: serialized, gameStarted, batch });
          }
          return Response.json({ room: null, gameStarted: null, batch });
        }

        case 'disconnect': {
          const room = this.room;
          if (!room) return Response.json({ batch });
          const userId = String(body.userId || '');
          const player = room.players.get(userId);
          if (!player) return Response.json({ batch });

          player.connected = false;
          player.voice = {
            voiceActive: false,
            micEnabled: false,
            selfMuted: false,
            speaking: false,
          };

          if (room.status !== 'playing') {
            this.removePlayerInternal(userId, 'left', batch);
          } else {
            if (room.hostId === userId) {
              this.transferHost(room, userId, batch);
            }
            const connectedCount = Array.from(room.players.values()).filter((p) => p.connected).length;
            if (connectedCount === 0) {
              this.destroyRoomInternal('All players disconnected.', batch);
            } else {
              const serialized = this.serializeRoom(room);
              batch.roomSummary = serialized;
              this.pushRoomBroadcast(batch, room, 'room:state', serialized);

              this.disconnectDeadlines.set(userId, Date.now() + this.getDisconnectGraceMs());
              this.scheduleNextAlarm(90);
            }
          }
          return Response.json({ batch });
        }

        case 'leave': {
          const userId = String(body.userId || '');
          this.removePlayerInternal(userId, 'left', batch);
          return Response.json({ batch });
        }

        case 'close': {
          const room = this.room;
          const userId = String(body.userId || '');
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.hostId !== userId) {
            return Response.json({ error: 'Only the room host can close the room.' }, { status: 403 });
          }
          this.destroyRoomInternal('Room closed by the host.', batch);
          return Response.json({ batch });
        }

        case 'kick': {
          const room = this.room;
          const hostUserId = String(body.userId || '');
          const targetUserId = String(body.targetUserId || '');
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.hostId !== hostUserId) {
            return Response.json({ error: 'Only the room host can remove players.' }, { status: 403 });
          }
          if (targetUserId === hostUserId) {
            return Response.json({ error: 'Host cannot remove themselves.' }, { status: 400 });
          }
          if (!room.players.has(targetUserId)) {
            return Response.json({ error: 'Player is not in this room.' }, { status: 404 });
          }
          this.removePlayerInternal(targetUserId, 'kicked', batch);
          return Response.json({ room: this.room ? this.serializeRoom(this.room) : null, batch });
        }

        case 'set_level': {
          const room = this.room;
          const hostUserId = String(body.userId || '');
          const levelId = typeof body.levelId === 'number' ? body.levelId : 1;
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.hostId !== hostUserId) {
            return Response.json({ error: 'Only the room host can change the sector.' }, { status: 403 });
          }
          if (room.status !== 'lobby') {
            return Response.json({ error: 'Cannot change sector while a match is running.' }, { status: 400 });
          }
          if (!isValidLevelId(levelId)) {
            return Response.json({ error: 'Invalid sector selected.' }, { status: 400 });
          }
          room.levelId = levelId;
          room.levelDef = getLevelDef(levelId);
          room.timeRemaining = room.levelDef.timeLimit;
          const serialized = this.serializeRoom(room);
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          return Response.json({ room: serialized, batch });
        }

        case 'register_invite': {
          const room = this.room;
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.status !== 'lobby') {
            return Response.json({ error: 'Cannot send invitations while a match is in progress.' }, { status: 400 });
          }
          if (room.players.size >= MAX_ROOM_PLAYERS) {
            return Response.json(
              { error: `Room is already full (${MAX_ROOM_PLAYERS}/${MAX_ROOM_PLAYERS}).` },
              { status: 400 }
            );
          }
          const invite = body.invite as RoomInviteInfo;
          const toUserId = String(body.toUserId || '');
          if (room.players.has(toUserId)) {
            return Response.json({ error: 'This friend is already in your room.' }, { status: 400 });
          }
          if (room.invites.has(toUserId)) {
            return Response.json({ error: 'Invitation already sent to this friend.' }, { status: 400 });
          }
          room.invites.set(toUserId, invite);
          const serialized = this.serializeRoom(room);
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          return Response.json({ room: serialized, batch });
        }

        case 'clear_invite': {
          const room = this.room;
          if (!room) return Response.json({ batch });
          const toUserId = String(body.toUserId || '');
          if (room.invites.delete(toUserId)) {
            const serialized = this.serializeRoom(room);
            batch.roomSummary = serialized;
            this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          }
          return Response.json({ batch });
        }

        case 'start': {
          const room = this.room;
          const hostUserId = String(body.userId || '');
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.hostId !== hostUserId) {
            return Response.json({ error: 'Only the room host can start the match.' }, { status: 403 });
          }
          if (room.status === 'playing') {
            return Response.json({ error: 'Match is already in progress.' }, { status: 400 });
          }

          const realConnectedPlayers = Array.from(room.players.values()).filter(
            (p) => !p.isBot && p.connected
          );
          if (realConnectedPlayers.length < MIN_ROOM_PLAYERS) {
            return Response.json(
              {
                error: `At least ${MIN_ROOM_PLAYERS} real players are required to start (${realConnectedPlayers.length}/${MAX_ROOM_PLAYERS}).`,
              },
              { status: 400 }
            );
          }
          if (realConnectedPlayers.length > MAX_ROOM_PLAYERS) {
            return Response.json(
              { error: `Room exceeds maximum of ${MAX_ROOM_PLAYERS} players.` },
              { status: 400 }
            );
          }

          const def = getLevelDef(room.levelId);
          room.levelDef = def;
          room.status = 'playing';
          room.matchStartTime = Date.now();
          room.timeRemaining = def.timeLimit;
          room.matchResult = null;

          for (const [uid, inv] of room.invites.entries()) {
            batch.purgedInvites!.push({ userId: uid, inviteId: inv.id, reason: 'match_started' });
          }
          room.invites.clear();

          const playerList = Array.from(room.players.values());
          const startPlat = def.platforms[0];
          const deckCenterX = startPlat ? startPlat.position[0] : def.spawn[0];
          const deckCenterZ = startPlat ? startPlat.position[2] : def.spawn[2];
          const usableW = Math.max(1.8, (startPlat ? startPlat.size[0] : 6.4) - 1.8);
          const usableD = Math.max(1.8, (startPlat ? startPlat.size[2] : 5.4) - 1.8);
          const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(playerList.length * (usableW / usableD)))));
          const rows = Math.max(1, Math.ceil(playerList.length / cols));

          playerList.forEach((p, idx) => {
            if (playerList.length <= 1) {
              p.x = def.spawn[0];
              p.y = def.spawn[1];
              p.z = def.spawn[2];
            } else {
              const col = idx % cols;
              const row = Math.floor(idx / cols);
              const colsInThisRow = row === rows - 1 ? playerList.length - row * cols : cols;
              const fx = colsInThisRow <= 1 ? 0 : col / (colsInThisRow - 1) - 0.5;
              const fz = rows <= 1 ? 0 : row / (rows - 1) - 0.5;
              p.x = deckCenterX + fx * usableW;
              p.y = def.spawn[1];
              p.z = deckCenterZ + fz * usableD;
            }
            p.yaw = Math.PI;
            p.animState = 'idle';
            p.horizSpeed = 0;
            p.velX = 0;
            p.velY = 0;
            p.velZ = 0;
            p.inWater = false;
            p.alive = true;
            p.escaped = false;
            p.checkpointIndex = 0;
            p.lastUpdateAt = Date.now();
            p.lastPushAt = 0;
            p.pushImmunityUntil = 0;
            p.beingEatenUntil = 0;
            p.beingEatenByMonsterId = null;
          });

          const waterY = def.bounds.waterY;
          room.monsters = def.monsters.map((mc, idx) => {
            const startWp = mc.waypoints[0] || [0, -25];
            const nextWp = mc.waypoints[1] || startWp;
            const initYaw = Math.atan2(nextWp[0] - startWp[0], nextWp[1] - startWp[1]) || 0;
            return {
              id: mc.id,
              x: startWp[0],
              y: waterY - 0.14,
              z: startWp[1],
              yaw: initYaw,
              velX: 0,
              velZ: 0,
              alert: 'calm',
              targetUserId: null,
              emerged: false,
              wpIndex: 1 % Math.max(1, mc.waypoints.length),
              eatingUserId: null,
              eatingProgress: 0,
              eatingStartAt: 0,
              eatingUntil: 0,
              waypoints: mc.waypoints,
              patrolSpeed: mc.patrolSpeed,
              chaseSpeed: mc.chaseSpeed,
              waterDetectionRadius: mc.waterDetectionRadius,
              scale: mc.scale || 1.0,
              avoidDir: idx % 2 === 0 ? 1 : -1,
              avoidTimer: 0,
              stuckTimer: 0,
              navBestDist: Infinity,
              navStallTimer: 0,
              navAnchorX: startWp[0],
              navAnchorZ: startWp[1],
              navAnchorTimer: 0,
              navTurnAccum: 0,
            };
          });

          if (this.tickTimer) clearInterval(this.tickTimer);
          room.lastTickMs = Date.now();
          this.lastWorldBroadcastMs = room.lastTickMs;
          this.tickTimer = setInterval(() => {
            void this.runTick();
          }, 50);
          this.scheduleNextAlarm(90);

          for (const p of room.players.values()) {
            batch.presenceChangedUserIds!.push(p.userId);
          }

          const serialized = this.serializeRoom(room);
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          this.pushRoomBroadcast(batch, room, 'game:started', {
            roomId: room.id,
            levelId: room.levelId,
            timeLimit: def.timeLimit,
            elapsedSec: 0,
            players: this.serializeNetPlayers(room),
            monsters: this.serializeNetMonsters(room),
          });
          return Response.json({ room: serialized, batch });
        }

        case 'return_lobby': {
          const room = this.room;
          const hostUserId = String(body.userId || '');
          if (!room) return Response.json({ error: 'Room not found.' }, { status: 404 });
          if (room.hostId !== hostUserId) {
            return Response.json(
              { error: 'Only the room host can return the room to lobby.' },
              { status: 403 }
            );
          }

          if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
          }

          room.status = 'lobby';
          room.matchStartTime = null;
          room.matchResult = null;
          room.timeRemaining = room.levelDef.timeLimit;
          for (const p of room.players.values()) {
            p.alive = true;
            p.escaped = false;
            p.checkpointIndex = 0;
            p.lastPushAt = 0;
            p.pushImmunityUntil = 0;
            p.beingEatenUntil = 0;
            p.beingEatenByMonsterId = null;
          }
          for (const p of room.players.values()) {
            batch.presenceChangedUserIds!.push(p.userId);
          }
          const serialized = this.serializeRoom(room);
          batch.roomSummary = serialized;
          this.pushRoomBroadcast(batch, room, 'room:state', serialized);
          return Response.json({ room: serialized, batch });
        }

        case 'input_state': {
          const room = this.room;
          if (!room || room.status !== 'playing') return Response.json({ batch });
          const userId = String(body.userId || '');
          const p = room.players.get(userId);
          if (!p || !p.alive || (p.beingEatenUntil && Date.now() < p.beingEatenUntil)) {
            return Response.json({ batch });
          }

          const packet = body.packet as ClientPlayerInputPacket;
          if (!packet || !Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z)) {
            return Response.json({ batch });
          }

          const now = Date.now();
          const prevX = p.x;
          const prevY = p.y;
          const prevZ = p.z;
          const prevYaw = p.yaw;
          const prevAnim = p.animState;
          const prevInWater = p.inWater;
          const dtInput = Math.max(0.001, (now - p.lastUpdateAt) / 1000);

          const bounds = room.levelDef.bounds;
          p.x = clamp(packet.x, bounds.minX + 0.35, bounds.maxX - 0.35);
          p.y = clamp(packet.y, bounds.floorY, bounds.ceilingY - 0.5);
          p.z = clamp(packet.z, bounds.minZ + 0.35, bounds.maxZ - 0.35);
          if (Number.isFinite(packet.yaw)) p.yaw = packet.yaw;
          const validAnim =
            packet.animState === 'idle' ||
            packet.animState === 'walk' ||
            packet.animState === 'run' ||
            packet.animState === 'jump' ||
            packet.animState === 'fall' ||
            packet.animState === 'swim';
          p.animState = validAnim ? packet.animState : 'idle';
          p.horizSpeed = Number.isFinite(packet.horizSpeed) ? clamp(packet.horizSpeed, 0, 18) : 0;

          if (
            Number.isFinite(packet.velX) &&
            Number.isFinite(packet.velY) &&
            Number.isFinite(packet.velZ)
          ) {
            p.velX = clamp(packet.velX as number, -18, 18);
            p.velY = clamp(packet.velY as number, -18, 18);
            p.velZ = clamp(packet.velZ as number, -18, 18);
          } else if (dtInput >= 0.012 && dtInput <= 0.4) {
            p.velX = clamp((p.x - prevX) / dtInput, -18, 18);
            p.velY = clamp((p.y - prevY) / dtInput, -18, 18);
            p.velZ = clamp((p.z - prevZ) / dtInput, -18, 18);
          } else {
            p.velX = 0;
            p.velY = 0;
            p.velZ = 0;
          }

          const elapsedSec = room.matchStartTime ? Math.max(0, (now - room.matchStartTime) / 1000) : 0;
          p.inWater = this.isPlayerInWaterServer(
            room.levelDef,
            p.x,
            p.y,
            p.z,
            Boolean(packet.inWater),
            elapsedSec
          );
          if (Number.isFinite(packet.checkpointIndex)) {
            p.checkpointIndex = Math.max(p.checkpointIndex, Math.floor(packet.checkpointIndex));
          }
          if (packet.characterId !== undefined) {
            p.characterId = normalizeCharacterId(packet.characterId);
          }

          const moved =
            Math.abs(p.x - prevX) + Math.abs(p.y - prevY) + Math.abs(p.z - prevZ) > 0.004 ||
            Math.abs(shortestAngleDiff(prevYaw, p.yaw)) > 0.008;
          let urgentSync =
            prevInWater !== p.inWater ||
            prevAnim !== p.animState;

          if (moved || urgentSync) {
            this.dirtyPlayersSinceBroadcast = true;
          }

          if (packet.escaped && !p.escaped) {
            const ex = room.levelDef.exit.position;
            const dist = Math.hypot(p.x - ex[0], p.z - ex[2]);
            if (dist <= 4.5 && Math.abs(p.y - ex[1]) <= 3.5) {
              p.escaped = true;
              urgentSync = true;
              const ev: GamePlayerEvent = {
                userId: p.userId,
                username: p.username,
                kind: 'escaped',
              };
              this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
              this.evaluateMatchResolution(room, batch);
            }
          }

          p.lastUpdateAt = now;
          // Piggyback authoritative simulation & game:world directly on input_state responses so
          // real-time player movement & water chases NEVER stall even if Cloudflare pauses setInterval.
          if (urgentSync || now - this.lastWorldBroadcastMs >= 32) {
            this.advanceRoomSimulation(room, now, batch, true);
          }
          this.scheduleNextAlarm(90);
          return Response.json({ batch });
        }

        case 'push': {
          const room = this.room;
          if (!room || room.status !== 'playing') return Response.json({ batch });
          const userId = String(body.userId || '');
          const attacker = room.players.get(userId);
          const now = Date.now();
          if (
            !attacker ||
            !attacker.connected ||
            !attacker.alive ||
            attacker.escaped ||
            (attacker.beingEatenUntil && now < attacker.beingEatenUntil)
          ) {
            return Response.json({ batch });
          }

          if (now - attacker.lastPushAt < PUSH_COOLDOWN_MS) {
            return Response.json({ batch });
          }

          const packet = body.packet as ClientPushPacket | undefined;
          const yaw = packet && Number.isFinite(packet.yaw) ? packet.yaw : attacker.yaw;
          let ax = attacker.x;
          let ay = attacker.y;
          let az = attacker.z;
          const b = room.levelDef.bounds;
          if (
            packet &&
            Number.isFinite(packet.x) &&
            Number.isFinite(packet.y) &&
            Number.isFinite(packet.z)
          ) {
            const px = clamp(packet.x as number, b.minX + 0.35, b.maxX - 0.35);
            const py = clamp(packet.y as number, b.floorY, b.ceilingY - 0.5);
            const pz = clamp(packet.z as number, b.minZ + 0.35, b.maxZ - 0.35);
            if (Math.hypot(px - attacker.x, pz - attacker.z) <= 3.2 && Math.abs(py - attacker.y) <= 2.2) {
              ax = px;
              ay = py;
              az = pz;
              attacker.x = ax;
              attacker.y = ay;
              attacker.z = az;
            }
          }
          attacker.yaw = yaw;

          const elapsedSec = room.matchStartTime ? Math.max(0, (now - room.matchStartTime) / 1000) : 0;
          const candidates = Array.from(room.players.values()).filter(
            (p) =>
              p.userId !== userId &&
              p.connected &&
              p.alive &&
              !p.escaped &&
              now >= p.pushImmunityUntil &&
              (!p.beingEatenUntil || now >= p.beingEatenUntil)
          );

          const selected = selectPushTarget(
            room.levelDef,
            { userId, x: ax, y: ay, z: az, yaw },
            candidates,
            elapsedSec,
            typeof packet?.targetUserId === 'string' ? packet.targetUserId : undefined
          );
          if (!selected) {
            return Response.json({ batch });
          }

          const target = room.players.get(selected.userId);
          if (!target) {
            return Response.json({ batch });
          }

          attacker.lastPushAt = now;
          target.pushImmunityUntil = now + PUSH_RECOVERY_MS;

          // Apply immediate wall-safe impulse displacement & velocity on authoritative server state
          const nudged = computePushNudge(
            room.levelDef,
            target.x,
            target.y,
            target.z,
            selected.dirX,
            selected.dirZ,
            0.38,
            elapsedSec
          );
          target.x = nudged.x;
          target.z = nudged.z;
          target.velX = selected.dirX * PUSH_FORCE_HORIZ;
          target.velY = PUSH_FORCE_LIFT_Y;
          target.velZ = selected.dirZ * PUSH_FORCE_HORIZ;
          target.horizSpeed = PUSH_FORCE_HORIZ;
          target.animState = target.inWater ? 'swim' : 'fall';
          target.inWater = this.isPlayerInWaterServer(
            room.levelDef,
            target.x,
            target.y,
            target.z,
            target.inWater,
            elapsedSec
          );
          target.lastUpdateAt = now;
          this.dirtyPlayersSinceBroadcast = true;

          const ev: GamePlayerEvent = {
            kind: 'pushed',
            userId: target.userId,
            username: target.username,
            x: target.x,
            y: target.y,
            z: target.z,
            attackerUserId: attacker.userId,
            attackerUsername: attacker.username,
            dirX: selected.dirX,
            dirZ: selected.dirZ,
            force: PUSH_FORCE_HORIZ,
            liftY: PUSH_FORCE_LIFT_Y,
          };
          this.pushRoomBroadcast(batch, room, 'game:player_event', ev);
          this.advanceRoomSimulation(room, now, batch, true);
          return Response.json({ batch });
        }

        case 'voice_state': {
          const room = this.room;
          if (!room) return Response.json({ batch });
          const userId = String(body.userId || '');
          const player = room.players.get(userId);
          if (!player) return Response.json({ batch });

          const rawState = (body.voice || {}) as Partial<RoomVoicePeerState>;
          const voiceActive = Boolean(rawState.voiceActive);
          const micEnabled = voiceActive ? Boolean(rawState.micEnabled) : false;
          const selfMuted = Boolean(rawState.selfMuted);
          const speaking = voiceActive && micEnabled && !selfMuted ? Boolean(rawState.speaking) : false;

          const prev = player.voice;
          if (
            prev.voiceActive === voiceActive &&
            prev.micEnabled === micEnabled &&
            prev.selfMuted === selfMuted &&
            prev.speaking === speaking
          ) {
            return Response.json({ batch });
          }

          player.voice = { voiceActive, micEnabled, selfMuted, speaking };
          const msg: DeliveryMessage = {
            targetUserIds: this.roomPlayerIds(room),
            event: 'voice:peer_state',
            payload: {
              roomId: room.id,
              userId,
              voice: { ...player.voice },
            },
          };
          batch.deliveries.push(msg);
          return Response.json({ batch });
        }

        case 'voice_signal': {
          const room = this.room;
          const fromUserId = String(body.fromUserId || '');
          const targetUserId = String(body.targetUserId || '');
          const kind = body.kind as VoiceSignalKind;
          const data = body.data;

          if (!targetUserId || targetUserId === fromUserId) return Response.json({ batch });
          if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice') return Response.json({ batch });
          if (!data || typeof data !== 'object') return Response.json({ batch });

          if (!room || !room.players.has(fromUserId)) {
            return Response.json({ error: 'Join a private room before using voice chat.' }, { status: 400 });
          }
          if (!room.players.has(targetUserId)) {
            return Response.json({ batch });
          }

          const encodedSize = JSON.stringify(data).length;
          if (encodedSize > 32768) {
            return Response.json({ error: 'Voice signaling payload exceeded limit.' }, { status: 400 });
          }

          batch.deliveries.push({
            targetUserId,
            event: 'voice:signal',
            payload: {
              roomId: room.id,
              fromUserId,
              kind,
              data,
            },
          });
          return Response.json({ batch });
        }

        case 'get_state': {
          return Response.json({
            room: this.room ? this.serializeRoom(this.room) : null,
            status: this.room?.status || null,
          });
        }

        default:
          return Response.json({ error: `Unknown room action: ${action}` }, { status: 400 });
      }
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Room action failed.' },
        { status: 400 }
      );
    }
  }
}

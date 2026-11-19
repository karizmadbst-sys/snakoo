import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { getLevelById, isValidLevelId } from '../src/game/levels.ts';
import {
  computeSerpentSteerAngle,
  resetSerpentNavProgress,
  resolvePatrolTarget,
  selectClosestPatrolWaypoint,
  updateSerpentProgressAndYaw,
} from '../src/game/serpentNav.ts';
import { LevelSpatialGrid } from '../src/game/spatialGrid.ts';
import { normalizeCharacterId, type CharacterId, type LevelDef, type PlatformDef } from '../src/game/types.ts';
import {
  EAT_DURATION_MS,
  MAX_ROOM_PLAYERS,
  MIN_ROOM_PLAYERS,
  PUSH_COOLDOWN_MS,
  PUSH_FORCE_HORIZ,
  PUSH_FORCE_LIFT_Y,
  PUSH_RECOVERY_MS,
  type AvatarIcon,
  type ClientPlayerInputPacket,
  type ClientPushPacket,
  type GamePlayerEvent,
  type MatchResultSummary,
  type MonsterNetState,
  type PlayerAnimSyncState,
  type PlayerNetState,
  type RoomInviteInfo,
  type RoomPlayerInfo,
  type RoomState,
  type RoomVoicePeerState,
  type UserPresenceStatus,
  type VoiceSignalKind,
} from '../src/multiplayer/types.ts';
import { selectPushTarget } from '../src/multiplayer/pushPhysics.ts';
import { MultiplayerDatabase } from './db.ts';

interface InternalRoomPlayer extends RoomPlayerInfo {
  characterId: CharacterId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  animState: PlayerAnimSyncState;
  horizSpeed: number;
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
  invites: Map<string, RoomInviteInfo>; // key = toUserId
  monsters: InternalMonster[];
  levelDef: LevelDef;
  matchStartTime: number | null;
  timeRemaining: number;
  matchResult: MatchResultSummary | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  lastTickMs: number;
  disconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

export class MultiplayerManager {
  private db: MultiplayerDatabase;
  private socketsByUser = new Map<string, Set<WebSocket>>();
  private socketUserMap = new Map<WebSocket, string>();
  private roomsById = new Map<string, InternalRoom>();
  private roomsByCode = new Map<string, InternalRoom>();
  private userRoomId = new Map<string, string>();
  private invitesByUser = new Map<string, Map<string, RoomInviteInfo>>(); // userId -> (inviteId -> invite)
  private disconnectGraceMs: number;
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

  constructor(db: MultiplayerDatabase, disconnectGraceMs = 8000) {
    this.db = db;
    this.disconnectGraceMs = disconnectGraceMs;
  }

  private getLevelGrid(def: LevelDef): LevelSpatialGrid {
    let grid = this.spatialGrids.get(def.id);
    if (!grid) {
      grid = new LevelSpatialGrid(def, 12);
      this.spatialGrids.set(def.id, grid);
    }
    return grid;
  }

  public dispose(): void {
    for (const room of this.roomsById.values()) {
      if (room.tickTimer) {
        clearInterval(room.tickTimer);
        room.tickTimer = null;
      }
      for (const t of room.disconnectTimers.values()) {
        clearTimeout(t);
      }
      room.disconnectTimers.clear();
    }
    this.roomsById.clear();
    this.roomsByCode.clear();
    this.userRoomId.clear();
    this.invitesByUser.clear();
  }

  public getPresence(userId: string): { status: UserPresenceStatus; inRoomId: string | null } {
    const sockets = this.socketsByUser.get(userId);
    const isConnected = Boolean(sockets && sockets.size > 0);
    const roomId = this.userRoomId.get(userId) || null;
    if (!isConnected) {
      return { status: 'offline', inRoomId: roomId };
    }
    if (roomId) {
      const room = this.roomsById.get(roomId);
      if (room && room.status === 'playing') {
        return { status: 'in-game', inRoomId: roomId };
      }
    }
    return { status: 'online', inRoomId: roomId };
  }

  public getPresenceStatus(userId: string): UserPresenceStatus {
    return this.getPresence(userId).status;
  }

  public sendToUser(userId: string, event: string, payload: unknown): void {
    const set = this.socketsByUser.get(userId);
    if (!set || set.size === 0) return;
    const raw = JSON.stringify({ event, payload });
    for (const ws of set) {
      if (ws.readyState === 1) {
        ws.send(raw);
      }
    }
  }

  private broadcastRoom(room: InternalRoom, event: string, payload: unknown): void {
    const raw = JSON.stringify({ event, payload });
    for (const p of room.players.values()) {
      const set = this.socketsByUser.get(p.userId);
      if (!set) continue;
      for (const ws of set) {
        if (ws.readyState === 1) {
          ws.send(raw);
        }
      }
    }
  }

  private broadcastPresenceToFriends(userId: string): void {
    const status = this.getPresenceStatus(userId);
    const friendIds = this.db.getFriendIds(userId);
    for (const fid of friendIds) {
      this.sendToUser(fid, 'friend:presence', { userId, status });
    }
  }

  public pushFriendsSnapshot(userId: string): void {
    const friends = this.db.getFriends(userId, (id) => this.getPresence(id));
    const reqs = this.db.getFriendRequests(userId);
    this.sendToUser(userId, 'friends:updated', {
      friends,
      incomingRequests: reqs.incoming,
      outgoingRequests: reqs.outgoing,
    });
  }

  public registerSocket(userId: string, ws: WebSocket): void {
    this.socketUserMap.set(ws, userId);
    let set = this.socketsByUser.get(userId);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.socketsByUser.set(userId, set);
    }
    set.add(ws);

    // If user is in an existing room (reconnect), mark connected & cancel grace timer
    const existingRoomId = this.userRoomId.get(userId);
    const existingRoom = existingRoomId ? this.roomsById.get(existingRoomId) || null : null;
    if (existingRoom) {
      const rp = existingRoom.players.get(userId);
      if (rp) {
        rp.connected = true;
        const timer = existingRoom.disconnectTimers.get(userId);
        if (timer) {
          clearTimeout(timer);
          existingRoom.disconnectTimers.delete(userId);
        }
        this.broadcastRoomState(existingRoom);
      }
    }

    const user = this.db.getPublicUserById(userId, this.getPresenceStatus(userId));
    const friends = this.db.getFriends(userId, (id) => this.getPresence(id));
    const reqs = this.db.getFriendRequests(userId);
    const pendingInvites = Array.from(this.invitesByUser.get(userId)?.values() || []);

    const authRaw = JSON.stringify({
      event: 'auth:ok',
      payload: {
        user,
        friends,
        incomingRequests: reqs.incoming,
        outgoingRequests: reqs.outgoing,
        pendingInvites,
        activeRoom: existingRoom ? this.serializeRoom(existingRoom) : null,
      },
    });
    if (ws.readyState === 1) {
      ws.send(authRaw);
      if (existingRoom && existingRoom.status === 'playing') {
        ws.send(
          JSON.stringify({
            event: 'game:started',
            payload: {
              roomId: existingRoom.id,
              levelId: existingRoom.levelId,
              timeLimit: existingRoom.levelDef.timeLimit,
              elapsedSec: existingRoom.matchStartTime
                ? Math.max(0, (Date.now() - existingRoom.matchStartTime) / 1000)
                : 0,
              players: this.serializeNetPlayers(existingRoom),
              monsters: this.serializeNetMonsters(existingRoom),
            },
          })
        );
      }
    }

    if (wasOffline) {
      this.broadcastPresenceToFriends(userId);
    }
  }

  public handleSocketDisconnect(ws: WebSocket): void {
    const userId = this.socketUserMap.get(ws);
    this.socketUserMap.delete(ws);
    if (!userId) return;

    const set = this.socketsByUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size > 0) {
        return; // User still has another active socket
      }
      this.socketsByUser.delete(userId);
    }

    const roomId = this.userRoomId.get(userId);
    if (roomId) {
      const room = this.roomsById.get(roomId);
      if (room) {
        const player = room.players.get(userId);
        if (player) {
          player.connected = false;
          player.voice = {
            voiceActive: false,
            micEnabled: false,
            selfMuted: false,
            speaking: false,
          };
          if (room.status !== 'playing') {
            // In lobby/ended: immediately free slot and transfer host if needed
            this.removePlayerFromRoomInternal(room, userId, 'left');
          } else {
            // In active match: immediately transfer host so match control isn't orphaned
            if (room.hostId === userId) {
              this.transferHost(room, userId);
            }
            const connectedCount = Array.from(room.players.values()).filter((p) => p.connected).length;
            if (connectedCount === 0) {
              this.destroyRoom(room, 'All players disconnected.');
            } else {
              this.broadcastRoomState(room);
              const existingTimer = room.disconnectTimers.get(userId);
              if (existingTimer) clearTimeout(existingTimer);
              const timer = setTimeout(() => {
                room.disconnectTimers.delete(userId);
                const latest = room.players.get(userId);
                if (latest && !latest.connected) {
                  this.removePlayerFromRoomInternal(room, userId, 'left');
                }
              }, this.disconnectGraceMs);
              room.disconnectTimers.set(userId, timer);
            }
          }
        }
      }
    }

    this.broadcastPresenceToFriends(userId);
  }

  private generateUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 40; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        const idx = crypto.randomInt(0, CODE_CHARS.length);
        code += CODE_CHARS[idx];
      }
      if (!this.roomsByCode.has(code)) return code;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  private getLevelDef(levelId: number): LevelDef {
    return getLevelById(levelId);
  }

  public serializeRoom(room: InternalRoom): RoomState {
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

  private broadcastRoomState(room: InternalRoom): void {
    this.broadcastRoom(room, 'room:state', this.serializeRoom(room));
  }

  public getRoomById(roomId: string): RoomState | null {
    const r = this.roomsById.get(roomId);
    return r ? this.serializeRoom(r) : null;
  }

  public getUserRoom(userId: string): RoomState | null {
    const rid = this.userRoomId.get(userId);
    if (!rid) return null;
    return this.getRoomById(rid);
  }

  public createRoom(userId: string, levelId = 1): RoomState {
    const user = this.db.getPublicUserById(userId, 'online');
    if (!user) throw new Error('User not found.');

    // Leave any current room atomically before creating a new one
    this.leaveRoom(userId);

    const safeLevelId = isValidLevelId(levelId) ? levelId : 1;
    const levelDef = this.getLevelDef(safeLevelId);
    const id = crypto.randomUUID();
    const code = this.generateUniqueRoomCode();

    const room: InternalRoom = {
      id,
      code,
      hostId: userId,
      levelId: safeLevelId,
      status: 'lobby',
      players: new Map(),
      invites: new Map(),
      monsters: [],
      levelDef,
      matchStartTime: null,
      timeRemaining: levelDef.timeLimit,
      matchResult: null,
      tickTimer: null,
      lastTickMs: Date.now(),
      disconnectTimers: new Map(),
    };

    room.players.set(userId, this.makeRoomPlayer(user.id, user.username, user.avatarColor, user.avatarIcon, true, levelDef));

    this.roomsById.set(id, room);
    this.roomsByCode.set(code, room);
    this.userRoomId.set(userId, id);
    this.broadcastRoomState(room);
    return this.serializeRoom(room);
  }

  private makeRoomPlayer(
    userId: string,
    username: string,
    avatarColor: string,
    avatarIcon: AvatarIcon,
    isHost: boolean,
    levelDef: LevelDef
  ): InternalRoomPlayer {
    return {
      userId,
      username,
      avatarColor,
      avatarIcon,
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

  public joinRoomByCode(userId: string, rawCode: string): RoomState {
    const normalized = (rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 4 || normalized.length > 10) {
      throw new Error('Invalid room code format.');
    }

    const room = this.roomsByCode.get(normalized);
    if (!room) {
      throw new Error('Private room not found. Check the room code and try again.');
    }

    return this.joinRoomInternal(userId, room);
  }

  private joinRoomInternal(userId: string, room: InternalRoom): RoomState {
    const user = this.db.getPublicUserById(userId, 'online');
    if (!user) throw new Error('User not found.');

    // Idempotent check if already in this room (e.g. reconnect or double-tap)
    const existing = room.players.get(userId);
    if (existing) {
      existing.connected = true;
      const timer = room.disconnectTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        room.disconnectTimers.delete(userId);
      }
      this.broadcastRoomState(room);
      return this.serializeRoom(room);
    }

    // Reject if match already running (private lobby lock)
    if (room.status !== 'lobby') {
      throw new Error('This match is already in progress.');
    }

    // Strict server-enforced cap: NEVER exceed 12 players total (including host)
    if (room.players.size >= MAX_ROOM_PLAYERS) {
      throw new Error(`Room is full (${MAX_ROOM_PLAYERS}/${MAX_ROOM_PLAYERS} players).`);
    }

    // Leave any previous room before joining new room
    const prevRoomId = this.userRoomId.get(userId);
    if (prevRoomId && prevRoomId !== room.id) {
      this.leaveRoom(userId);
    }

    // Re-check atomic cap after leaving previous room
    if (room.players.size >= MAX_ROOM_PLAYERS) {
      throw new Error(`Room is full (${MAX_ROOM_PLAYERS}/${MAX_ROOM_PLAYERS} players).`);
    }

    // Clean up any pending invite for this user to this room
    const pendingInvite = room.invites.get(userId);
    if (pendingInvite) {
      room.invites.delete(userId);
      this.removeInviteForUser(userId, pendingInvite.id, 'accepted');
    }

    room.players.set(
      userId,
      this.makeRoomPlayer(user.id, user.username, user.avatarColor, user.avatarIcon, false, room.levelDef)
    );
    this.userRoomId.set(userId, room.id);
    this.broadcastRoomState(room);
    return this.serializeRoom(room);
  }

  public leaveRoom(userId: string): void {
    const roomId = this.userRoomId.get(userId);
    if (!roomId) return;
    const room = this.roomsById.get(roomId);
    if (!room) {
      this.userRoomId.delete(userId);
      return;
    }
    this.removePlayerFromRoomInternal(room, userId, 'left');
  }

  private transferHost(room: InternalRoom, previousHostId: string): void {
    const candidates = Array.from(room.players.values()).filter((p) => p.userId !== previousHostId);
    if (candidates.length === 0) return;

    // Prefer a connected player first
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
    this.broadcastRoom(room, 'game:player_event', ev);
  }

  private removePlayerFromRoomInternal(
    room: InternalRoom,
    userId: string,
    reason: 'left' | 'kicked'
  ): void {
    const removed = room.players.get(userId);
    if (!removed) return;

    const timer = room.disconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      room.disconnectTimers.delete(userId);
    }

    const wasHost = room.hostId === userId;
    room.players.delete(userId);
    this.userRoomId.delete(userId);
    for (const m of room.monsters) {
      if (m.eatingUserId === userId) {
        m.eatingUserId = null;
        m.eatingStartAt = 0;
        m.eatingUntil = 0;
        m.eatingProgress = 0;
      }
    }
    this.broadcastRoom(room, 'voice:peer_left', { roomId: room.id, userId });

    if (reason === 'kicked') {
      this.sendToUser(userId, 'room:kicked', {
        roomId: room.id,
        reason: 'You were removed from the room by the host.',
      });
    } else {
      this.sendToUser(userId, 'room:state', null);
    }

    if (room.players.size === 0) {
      this.destroyRoom(room, 'Room closed because all players left.');
      this.broadcastPresenceToFriends(userId);
      return;
    }

    if (wasHost) {
      this.transferHost(room, userId);
    }

    if (room.status === 'playing') {
      const ev: GamePlayerEvent = {
        userId: removed.userId,
        username: removed.username,
        kind: 'left',
      };
      this.broadcastRoom(room, 'game:player_event', ev);
      this.evaluateMatchResolution(room);
    }

    this.broadcastRoomState(room);
    this.broadcastPresenceToFriends(userId);
  }

  private destroyRoom(room: InternalRoom, reason: string): void {
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
    }
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();

    for (const [uid, inv] of room.invites.entries()) {
      this.removeInviteForUser(uid, inv.id, 'room_closed');
    }
    room.invites.clear();

    const affectedUsers = Array.from(room.players.keys());
    this.broadcastRoom(room, 'room:closed', { roomId: room.id, reason });
    for (const uid of affectedUsers) {
      this.userRoomId.delete(uid);
    }
    room.players.clear();
    this.roomsById.delete(room.id);
    this.roomsByCode.delete(room.code);
    for (const uid of affectedUsers) {
      this.broadcastPresenceToFriends(uid);
    }
  }

  public kickPlayer(hostUserId: string, targetUserId: string): RoomState {
    const roomId = this.userRoomId.get(hostUserId);
    if (!roomId) throw new Error('You are not in a room.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.hostId !== hostUserId) {
      throw new Error('Only the room host can remove players.');
    }
    if (targetUserId === hostUserId) {
      throw new Error('Host cannot remove themselves.');
    }
    if (!room.players.has(targetUserId)) {
      throw new Error('Player is not in this room.');
    }
    this.removePlayerFromRoomInternal(room, targetUserId, 'kicked');
    return this.serializeRoom(room);
  }

  public closeRoom(hostUserId: string): void {
    const roomId = this.userRoomId.get(hostUserId);
    if (!roomId) throw new Error('You are not in a room.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.hostId !== hostUserId) {
      throw new Error('Only the room host can close the room.');
    }
    this.destroyRoom(room, 'Room closed by the host.');
  }

  public setRoomLevel(hostUserId: string, levelId: number): RoomState {
    const roomId = this.userRoomId.get(hostUserId);
    if (!roomId) throw new Error('You are not in a room.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.hostId !== hostUserId) {
      throw new Error('Only the room host can change the sector.');
    }
    if (room.status !== 'lobby') {
      throw new Error('Cannot change sector while a match is running.');
    }
    if (!isValidLevelId(levelId)) {
      throw new Error('Invalid sector selected.');
    }
    room.levelId = levelId;
    room.levelDef = this.getLevelDef(levelId);
    room.timeRemaining = room.levelDef.timeLimit;
    this.broadcastRoomState(room);
    return this.serializeRoom(room);
  }

  public inviteFriend(senderUserId: string, friendUserId: string): RoomInviteInfo {
    const roomId = this.userRoomId.get(senderUserId);
    if (!roomId) throw new Error('Create or join a room before inviting friends.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.status !== 'lobby') {
      throw new Error('Cannot send invitations while a match is in progress.');
    }
    if (room.players.size >= MAX_ROOM_PLAYERS) {
      throw new Error(`Room is already full (${MAX_ROOM_PLAYERS}/${MAX_ROOM_PLAYERS}).`);
    }
    if (!this.db.areFriends(senderUserId, friendUserId)) {
      throw new Error('You can only invite confirmed friends.');
    }
    if (room.players.has(friendUserId)) {
      throw new Error('This friend is already in your room.');
    }
    if (room.invites.has(friendUserId)) {
      throw new Error('Invitation already sent to this friend.');
    }
    const friendPresence = this.getPresenceStatus(friendUserId);
    if (friendPresence === 'offline') {
      throw new Error('This friend is currently offline.');
    }

    const sender = this.db.getPublicUserById(senderUserId, 'online');
    if (!sender) throw new Error('Sender account not found.');

    const invite: RoomInviteInfo = {
      id: crypto.randomUUID(),
      roomId: room.id,
      roomCode: room.code,
      fromUserId: sender.id,
      fromUsername: sender.username,
      fromAvatarColor: sender.avatarColor,
      fromAvatarIcon: sender.avatarIcon,
      levelId: room.levelId,
      createdAt: Date.now(),
    };

    room.invites.set(friendUserId, invite);
    let userMap = this.invitesByUser.get(friendUserId);
    if (!userMap) {
      userMap = new Map();
      this.invitesByUser.set(friendUserId, userMap);
    }
    userMap.set(invite.id, invite);

    this.sendToUser(friendUserId, 'invite:received', invite);
    this.broadcastRoomState(room);
    return invite;
  }

  private removeInviteForUser(userId: string, inviteId: string, reason: string): void {
    const userMap = this.invitesByUser.get(userId);
    if (userMap && userMap.has(inviteId)) {
      userMap.delete(inviteId);
      if (userMap.size === 0) this.invitesByUser.delete(userId);
    }
    this.sendToUser(userId, 'invite:removed', { inviteId, reason });
  }

  public respondToInvite(
    userId: string,
    inviteId: string,
    accept: boolean
  ): { accepted: boolean; room: RoomState | null } {
    const userMap = this.invitesByUser.get(userId);
    const invite = userMap?.get(inviteId);
    if (!invite) {
      throw new Error('Invitation no longer exists or has expired.');
    }

    const room = this.roomsById.get(invite.roomId);
    if (room) {
      room.invites.delete(userId);
    }
    this.removeInviteForUser(userId, inviteId, accept ? 'accepted' : 'declined');

    if (!accept) {
      if (room) this.broadcastRoomState(room);
      return { accepted: false, room: null };
    }

    if (!room) {
      throw new Error('The private room was closed.');
    }

    const joined = this.joinRoomInternal(userId, room);
    return { accepted: true, room: joined };
  }

  public startGame(hostUserId: string): RoomState {
    const roomId = this.userRoomId.get(hostUserId);
    if (!roomId) throw new Error('You are not in a room.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.hostId !== hostUserId) {
      throw new Error('Only the room host can start the match.');
    }
    if (room.status === 'playing') {
      throw new Error('Match is already in progress.');
    }

    const realConnectedPlayers = Array.from(room.players.values()).filter(
      (p) => !p.isBot && p.connected
    );
    if (realConnectedPlayers.length < MIN_ROOM_PLAYERS) {
      throw new Error(
        `At least ${MIN_ROOM_PLAYERS} real players are required to start (${realConnectedPlayers.length}/${MAX_ROOM_PLAYERS}).`
      );
    }
    if (realConnectedPlayers.length > MAX_ROOM_PLAYERS) {
      throw new Error(`Room exceeds maximum of ${MAX_ROOM_PLAYERS} players.`);
    }

    const def = this.getLevelDef(room.levelId);
    room.levelDef = def;
    room.status = 'playing';
    room.matchStartTime = Date.now();
    room.timeRemaining = def.timeLimit;
    room.matchResult = null;

    // Purge pending room invites once match starts
    for (const [uid, inv] of room.invites.entries()) {
      this.removeInviteForUser(uid, inv.id, 'match_started');
    }
    room.invites.clear();

    // Arrange spawn positions smoothly across start deck so up to 12 players have generous spacing
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

    // Spawn authoritative sea serpents from level config
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

    if (room.tickTimer) clearInterval(room.tickTimer);
    room.lastTickMs = Date.now();
    room.tickTimer = setInterval(() => this.tickRoom(room), 50);

    for (const p of room.players.values()) {
      this.broadcastPresenceToFriends(p.userId);
    }

    this.broadcastRoomState(room);
    this.broadcastRoom(room, 'game:started', {
      roomId: room.id,
      levelId: room.levelId,
      timeLimit: def.timeLimit,
      elapsedSec: 0,
      players: this.serializeNetPlayers(room),
      monsters: this.serializeNetMonsters(room),
    });

    return this.serializeRoom(room);
  }

  public returnToLobby(hostUserId: string): RoomState {
    const roomId = this.userRoomId.get(hostUserId);
    if (!roomId) throw new Error('You are not in a room.');
    const room = this.roomsById.get(roomId);
    if (!room) throw new Error('Room not found.');
    if (room.hostId !== hostUserId) {
      throw new Error('Only the room host can return the room to lobby.');
    }

    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
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
      this.broadcastPresenceToFriends(p.userId);
    }

    this.broadcastRoomState(room);
    return this.serializeRoom(room);
  }

  public handlePlayerInputState(userId: string, packet: ClientPlayerInputPacket): void {
    const roomId = this.userRoomId.get(userId);
    if (!roomId) return;
    const room = this.roomsById.get(roomId);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(userId);
    if (!p || !p.alive || (p.beingEatenUntil && Date.now() < p.beingEatenUntil)) return;

    const bounds = room.levelDef.bounds;
    if (!Number.isFinite(packet.x) || !Number.isFinite(packet.y) || !Number.isFinite(packet.z)) {
      return;
    }

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
    p.horizSpeed = Number.isFinite(packet.horizSpeed) ? clamp(packet.horizSpeed, 0, 15) : 0;
    const elapsedSec = room.matchStartTime ? Math.max(0, (Date.now() - room.matchStartTime) / 1000) : 0;
    p.inWater = this.isPlayerInWaterServer(room.levelDef, p.x, p.y, p.z, Boolean(packet.inWater), elapsedSec);
    if (Number.isFinite(packet.checkpointIndex)) {
      p.checkpointIndex = Math.max(p.checkpointIndex, Math.floor(packet.checkpointIndex));
    }
    if (packet.characterId !== undefined) {
      p.characterId = normalizeCharacterId(packet.characterId);
    }

    // Validate exit portal proximity before accepting escape
    if (packet.escaped && !p.escaped) {
      const ex = room.levelDef.exit.position;
      const dist = Math.hypot(p.x - ex[0], p.z - ex[2]);
      if (dist <= 4.5 && Math.abs(p.y - ex[1]) <= 3.5) {
        p.escaped = true;
        const ev: GamePlayerEvent = {
          userId: p.userId,
          username: p.username,
          kind: 'escaped',
        };
        this.broadcastRoom(room, 'game:player_event', ev);
        this.evaluateMatchResolution(room);
      }
    }

    p.lastUpdateAt = Date.now();
  }

  public handlePushPlayer(userId: string, packet: ClientPushPacket): void {
    const roomId = this.userRoomId.get(userId);
    if (!roomId) return;
    const room = this.roomsById.get(roomId);
    if (!room || room.status !== 'playing') return;

    const attacker = room.players.get(userId);
    const now = Date.now();
    if (
      !attacker ||
      !attacker.connected ||
      !attacker.alive ||
      attacker.escaped ||
      (attacker.beingEatenUntil && now < attacker.beingEatenUntil)
    ) {
      return;
    }

    if (now - attacker.lastPushAt < PUSH_COOLDOWN_MS) return;

    const yaw = Number.isFinite(packet?.yaw) ? packet.yaw : attacker.yaw;
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
      if (Math.hypot(px - attacker.x, pz - attacker.z) <= 2.5 && Math.abs(py - attacker.y) <= 2.0) {
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
      elapsedSec
    );
    if (!selected) return;

    const target = room.players.get(selected.userId);
    if (!target) return;

    attacker.lastPushAt = now;
    target.pushImmunityUntil = now + PUSH_RECOVERY_MS;

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
    this.broadcastRoom(room, 'game:player_event', ev);
  }

  private isPlayerOnPlatform(
    def: LevelDef,
    x: number,
    y: number,
    z: number,
    elapsedSec = 0
  ): boolean {
    const margin = 0.45;
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
        const rotMargin = 0.65;
        if (axis === 'y') {
          const topY = py + hh;
          if (Math.abs(y - topY) <= 0.55) {
            const [lx, , lz] = worldToRotatedPlatformLocal(x - px, 0, z - pz, plat, elapsedSec);
            if (Math.abs(lx) <= hw + rotMargin && Math.abs(lz) <= hd + rotMargin) {
              return true;
            }
          }
        } else if (y >= def.bounds.waterY - 0.16) {
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
      if (Math.abs(y - topY) <= 0.4) {
        if (plat.kind === 'moving' && plat.moveOffset) {
          // Account for slight clock skew between server & client on moving decks
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
    if (this.isPlayerOnPlatform(def, x, y, z, elapsedSec)) return false;
    return y < def.bounds.waterY - 0.06 && (clientInWater || y < def.bounds.waterY - 0.08);
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
            // Rotate local push back via YXZ (Z -> X -> Y)
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

  private tickRoom(room: InternalRoom): void {
    if (room.status !== 'playing') return;

    const now = Date.now();
    const dt = Math.min(0.1, Math.max(0.01, (now - room.lastTickMs) / 1000));
    room.lastTickMs = now;

    room.timeRemaining = Math.max(0, room.timeRemaining - dt);
    this.updateRoomMonsters(room, dt);

    if (room.timeRemaining <= 0 && !room.matchResult) {
      this.finalizeMatch(room, 'timeout');
    } else {
      this.evaluateMatchResolution(room);
    }

    this.broadcastRoom(room, 'game:world', {
      roomId: room.id,
      serverTime: now,
      timeRemaining: r2(room.timeRemaining),
      elapsedSec: room.matchStartTime ? r2(Math.max(0, (now - room.matchStartTime) / 1000)) : 0,
      players: this.serializeNetPlayers(room, true),
      monsters: this.serializeNetMonsters(room),
      matchResult: room.matchResult,
    });
  }

  private updateRoomMonsters(room: InternalRoom, dt: number): void {
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

    for (let i = 0; i < room.monsters.length; i++) {
      const m = room.monsters[i];

      // Handle active eating sequence before normal patrol/chase
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
          // Swallowing completed -> eliminate victim ONLY now
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
          this.broadcastRoom(room, 'game:player_event', ev);
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

      // Pick nearest unclaimed swimmer in water within detection range, or fallback to nearest swimmer
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

      let target: InternalRoomPlayer | null = null;
      let targetDist = Infinity;
      if (unclaimedTarget && unclaimedDist <= m.waterDetectionRadius) {
        target = unclaimedTarget;
        targetDist = unclaimedDist;
      } else if (anyTarget && (anyDist <= m.waterDetectionRadius || i === 0)) {
        target = anyTarget;
        targetDist = anyDist;
      }

      const shouldChase = Boolean(target && (targetDist <= m.waterDetectionRadius || i === 0));
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
      const minSafeY = def.bounds.floorY + 0.78 * m.scale;
      const deepDiveY = Math.max(minSafeY, waterY - 1.95 * m.scale);
      const diveBotY = deepDiveY - 0.68 * m.scale;
      const diveTopY = deepDiveY + 0.68 * m.scale;

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
          const maxProbe = Math.min(dTgt, isChasing ? 15.0 : 9.0);
          const stepLen = Math.max(1.2, monsterRadius * 1.65);
          for (let d = 0.5; d <= maxProbe; d += stepLen) {
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
                monsterRadius * 0.98,
                waterY - 0.9 * m.scale,
                waterY + 1.05 * m.scale,
                elapsedSec,
                false,
                true
              ) &&
              !this.isCircleBlocked(def, sx, sz, monsterRadius * 0.92, diveBotY, diveTopY, elapsedSec, false, true)
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
              monsterRadius * 0.98,
              waterY - 0.9 * m.scale,
              waterY + 1.05 * m.scale,
              elapsedSec,
              false,
              true
            ) &&
            !this.isCircleBlocked(def, fwdX, fwdZ, monsterRadius * 0.92, diveBotY, diveTopY, elapsedSec, false, true)
          ) {
            corridorPlatformBlocked = true;
          }
        }
      }

      if (platformOverhead || corridorPlatformBlocked) {
        m.diveTimer = Math.max(m.diveTimer || 0, isChasing ? 0.45 : 0.75);
      } else if ((m.diveTimer || 0) > 0) {
        if (isChasing && target && targetDist < 4.8 && !platformOverhead && !corridorPlatformBlocked) {
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
      const catchDist = 2.05 * m.scale;
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

        // Server-authoritative two-phase catch: start eating sequence, eliminate only when eating finishes
        if (isChasing) {
          for (const p of aliveInWater) {
            if (!p.alive || p.escaped || !p.inWater || (p.beingEatenUntil && now < p.beingEatenUntil)) continue;
            if (
              Math.hypot(p.x - m.x, p.z - m.z) < catchDist &&
              !this.isCircleBlocked(def, m.x, m.z, monsterRadius * 0.65, waterY - 0.4, waterY + 0.9, elapsedSec, false, true)
            ) {
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
              this.broadcastRoom(room, 'game:player_event', ev);
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

  private evaluateMatchResolution(room: InternalRoom): void {
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
      this.finalizeMatch(room, 'all_caught');
      return;
    }

    if (aliveNotEscapedCount === 0) {
      this.finalizeMatch(room, escapedCount > 0 ? 'all_resolved' : 'all_caught');
    }
  }

  private finalizeMatch(
    room: InternalRoom,
    reason: 'all_resolved' | 'timeout' | 'all_caught'
  ): void {
    if (room.matchResult) return;
    if (room.tickTimer) {
      clearInterval(room.tickTimer);
      room.tickTimer = null;
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
      this.broadcastPresenceToFriends(p.userId);
    }
    for (const m of room.monsters) {
      m.eatingUserId = null;
      m.eatingStartAt = 0;
      m.eatingUntil = 0;
      m.eatingProgress = 0;
    }
    this.broadcastRoomState(room);
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

  public updateVoiceState(userId: string, rawState: Partial<RoomVoicePeerState>): void {
    const roomId = this.userRoomId.get(userId);
    if (!roomId) return;
    const room = this.roomsById.get(roomId);
    if (!room) return;
    const player = room.players.get(userId);
    if (!player) return;

    const voiceActive = Boolean(rawState?.voiceActive);
    const micEnabled = voiceActive ? Boolean(rawState?.micEnabled) : false;
    const selfMuted = Boolean(rawState?.selfMuted);
    const speaking = voiceActive && micEnabled && !selfMuted ? Boolean(rawState?.speaking) : false;

    const prev = player.voice;
    if (
      prev.voiceActive === voiceActive &&
      prev.micEnabled === micEnabled &&
      prev.selfMuted === selfMuted &&
      prev.speaking === speaking
    ) {
      return;
    }

    player.voice = {
      voiceActive,
      micEnabled,
      selfMuted,
      speaking,
    };

    this.broadcastRoom(room, 'voice:peer_state', {
      roomId: room.id,
      userId,
      voice: { ...player.voice },
    });
  }

  public relayVoiceSignal(
    fromUserId: string,
    targetUserId: string,
    kind: VoiceSignalKind,
    data: unknown
  ): void {
    if (!targetUserId || targetUserId === fromUserId) return;
    if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice') return;
    if (!data || typeof data !== 'object') return;

    const roomId = this.userRoomId.get(fromUserId);
    if (!roomId) {
      throw new Error('Join a private room before using voice chat.');
    }
    const room = this.roomsById.get(roomId);
    if (!room || !room.players.has(fromUserId)) {
      throw new Error('Room not found.');
    }
    // Strict room-scoped security: only forward signals to authorized players inside the exact same room
    const target = room.players.get(targetUserId);
    if (!target) {
      return;
    }

    // Bound serialized signal payload size to prevent abuse
    const encodedSize = JSON.stringify(data).length;
    if (encodedSize > 32768) {
      throw new Error('Voice signaling payload exceeded limit.');
    }

    this.sendToUser(targetUserId, 'voice:signal', {
      roomId: room.id,
      fromUserId,
      kind,
      data,
    });
  }
}

import type { CharacterId } from '../game/types.ts';

export const MIN_ROOM_PLAYERS = 2;
export const MAX_ROOM_PLAYERS = 12;

export type UserPresenceStatus = 'offline' | 'online' | 'in-game';

export const AVATAR_COLORS = [
  '#52e0b6',
  '#38bdf8',
  '#f59e0b',
  '#f43f5e',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#60a5fa',
] as const;

export const AVATAR_ICONS = [
  'diver',
  'anchor',
  'wave',
  'compass',
  'shield',
  'bolt',
] as const;

export type AvatarIcon = (typeof AVATAR_ICONS)[number];

export interface PublicUser {
  id: string;
  username: string;
  avatarColor: string;
  avatarIcon: AvatarIcon;
  status: UserPresenceStatus;
}

export interface FriendInfo extends PublicUser {
  inRoomId: string | null;
}

export interface FriendRequestInfo {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromAvatarColor: string;
  fromAvatarIcon: AvatarIcon;
  toUserId: string;
  toUsername: string;
  toAvatarColor: string;
  toAvatarIcon: AvatarIcon;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export interface UserSearchResult extends PublicUser {
  relationship: 'none' | 'friends' | 'outgoing_pending' | 'incoming_pending';
}

export interface RoomVoicePeerState {
  voiceActive: boolean;
  micEnabled: boolean;
  selfMuted: boolean;
  speaking: boolean;
}

export interface RoomPlayerInfo {
  userId: string;
  username: string;
  avatarColor: string;
  avatarIcon: AvatarIcon;
  characterId?: CharacterId;
  isHost: boolean;
  isBot: false;
  connected: boolean;
  alive: boolean;
  escaped: boolean;
  checkpointIndex: number;
  voice: RoomVoicePeerState;
}

export interface RoomState {
  id: string;
  code: string;
  hostId: string;
  levelId: number;
  status: 'lobby' | 'playing' | 'ended';
  isPrivate: true;
  minPlayers: number;
  maxPlayers: number;
  players: RoomPlayerInfo[];
  invitedFriendIds: string[];
  matchStartTime: number | null;
}

export interface RoomInviteInfo {
  id: string;
  roomId: string;
  roomCode: string;
  fromUserId: string;
  fromUsername: string;
  fromAvatarColor: string;
  fromAvatarIcon: AvatarIcon;
  levelId: number;
  createdAt: number;
}

export type PlayerAnimSyncState = 'idle' | 'walk' | 'run' | 'jump' | 'fall' | 'swim';

export interface PlayerNetState {
  userId: string;
  username?: string;
  avatarColor?: string;
  characterId?: CharacterId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  animState: PlayerAnimSyncState;
  horizSpeed: number;
  velX?: number;
  velY?: number;
  velZ?: number;
  inWater: boolean;
  alive: boolean;
  escaped: boolean;
  checkpointIndex: number;
}

export interface MonsterNetState {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  velX: number;
  velZ: number;
  alert: 'calm' | 'searching' | 'chasing';
  targetUserId: string | null;
  emerged: boolean;
  wpIndex: number;
  eatingUserId?: string | null;
  eatingProgress?: number;
}

export interface MatchResultSummary {
  outcome: 'escaped' | 'failed';
  elapsed: number;
  survivors: Array<{ userId: string; username: string }>;
  reason: 'all_resolved' | 'timeout' | 'all_caught';
}

export interface WorldSyncPayload {
  roomId: string;
  serverTime: number;
  elapsedSec?: number;
  timeRemaining: number;
  players: PlayerNetState[];
  monsters: MonsterNetState[];
  matchResult: MatchResultSummary | null;
}

export const EAT_DURATION_MS = 2300;
export const PUSH_COOLDOWN_MS = 2500;
export const PUSH_RECOVERY_MS = 1800;
export const PUSH_MAX_DISTANCE = 2.85;
export const PUSH_MAX_Y_DIFF = 1.8;
export const PUSH_MIN_FACING_DOT = 0.25;
export const PUSH_FORCE_HORIZ = 10.5;
export const PUSH_FORCE_LIFT_Y = 2.8;

export interface GamePlayerEvent {
  userId: string;
  username: string;
  kind: 'eating_started' | 'caught' | 'escaped' | 'checkpoint' | 'left' | 'host_transferred' | 'pushed';
  x?: number;
  y?: number;
  z?: number;
  monsterId?: string;
  attackerUserId?: string;
  attackerUsername?: string;
  dirX?: number;
  dirZ?: number;
  force?: number;
  liftY?: number;
}

export interface ClientPlayerInputPacket {
  x: number;
  y: number;
  z: number;
  yaw: number;
  animState: PlayerAnimSyncState;
  horizSpeed: number;
  velX?: number;
  velY?: number;
  velZ?: number;
  inWater: boolean;
  checkpointIndex: number;
  escaped: boolean;
  characterId?: CharacterId;
}

export interface ClientPushPacket {
  yaw: number;
  x?: number;
  y?: number;
  z?: number;
  targetUserId?: string;
}

export type VoiceSignalKind = 'offer' | 'answer' | 'ice';

export interface VoiceSignalPayload {
  roomId: string;
  fromUserId: string;
  kind: VoiceSignalKind;
  data: unknown;
}

export interface VoicePeerStateEvent {
  roomId: string;
  userId: string;
  voice: RoomVoicePeerState;
}

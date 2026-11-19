import type { RoomInviteInfo, RoomState, UserPresenceStatus } from '../../src/multiplayer/types.ts';

export interface Env {
  DB: D1Database;
  PRESENCE_HUB: DurableObjectNamespace;
  GAME_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  DISCONNECT_GRACE_MS?: string;
  VOICE_TURN_URL?: string;
  VOICE_TURN_USERNAME?: string;
  VOICE_TURN_CREDENTIAL?: string;
}

export interface DeliveryMessage {
  targetUserId?: string;
  targetUserIds?: string[];
  event: string;
  payload: unknown;
}

export interface RoomDeliveryBatch {
  deliveries: DeliveryMessage[];
  joinedUsers?: Array<{ userId: string; roomId: string; code: string }>;
  removedUsers?: Array<{ userId: string; roomId: string }>;
  closedRoom?: { roomId: string; code: string; affectedUserIds: string[] };
  presenceChangedUserIds?: string[];
  purgedInvites?: Array<{ userId: string; inviteId: string; reason: string }>;
  roomSummary?: RoomState | null;
}

export interface HubPresenceLookup {
  status: UserPresenceStatus;
  inRoomId: string | null;
}

export interface InviteCreateResult {
  invite: RoomInviteInfo;
  room: RoomState;
}

import type {
  PublicUser,
  RoomInviteInfo,
  RoomState,
  UserPresenceStatus,
} from '../../src/multiplayer/types.ts';
import { CloudflareD1Database } from './db.ts';
import type { DeliveryMessage, Env, HubPresenceLookup, RoomDeliveryBatch } from './types.ts';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRandomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

export class PresenceHubDO {
  private ctx: DurableObjectState;
  private env: Env;
  private db: CloudflareD1Database;

  private socketsByUser = new Map<string, Set<WebSocket>>();
  private socketUser = new Map<WebSocket, string>();
  private userRoom = new Map<string, { roomId: string; code: string }>();
  private codeToRoomId = new Map<string, string>();
  private roomStatus = new Map<string, 'lobby' | 'playing' | 'ended'>();
  private invitesByUser = new Map<string, Map<string, RoomInviteInfo>>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.db = new CloudflareD1Database(env.DB);
  }

  private getRoomStub(roomId: string): DurableObjectStub {
    const id = this.env.GAME_ROOM.idFromName(roomId);
    return this.env.GAME_ROOM.get(id);
  }

  public getPresence(userId: string): HubPresenceLookup {
    const sockets = this.socketsByUser.get(userId);
    const connected = Boolean(sockets && sockets.size > 0);
    const roomInfo = this.userRoom.get(userId) || null;
    if (!connected) {
      return { status: 'offline', inRoomId: roomInfo?.roomId || null };
    }
    if (roomInfo && this.roomStatus.get(roomInfo.roomId) === 'playing') {
      return { status: 'in-game', inRoomId: roomInfo.roomId };
    }
    return { status: 'online', inRoomId: roomInfo?.roomId || null };
  }

  public getPresenceStatus(userId: string): UserPresenceStatus {
    return this.getPresence(userId).status;
  }

  private sendToUser(userId: string, event: string, payload: unknown): void {
    const set = this.socketsByUser.get(userId);
    if (!set || set.size === 0) return;
    const raw = JSON.stringify({ event, payload });
    for (const ws of set) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(raw);
        }
      } catch {
        // ignore closed sockets
      }
    }
  }

  private async broadcastPresenceToFriends(userId: string): Promise<void> {
    const status = this.getPresenceStatus(userId);
    const friendIds = await this.db.getFriendIds(userId);
    for (const fid of friendIds) {
      this.sendToUser(fid, 'friend:presence', { userId, status });
    }
  }

  public async pushFriendsSnapshot(userId: string): Promise<void> {
    const [friends, reqs] = await Promise.all([
      this.db.getFriends(userId, (id) => this.getPresence(id)),
      this.db.getFriendRequests(userId),
    ]);
    this.sendToUser(userId, 'friends:updated', {
      friends,
      incomingRequests: reqs.incoming,
      outgoingRequests: reqs.outgoing,
    });
  }

  private removeInviteLocal(userId: string, inviteId: string, reason: string): void {
    const map = this.invitesByUser.get(userId);
    if (map && map.has(inviteId)) {
      map.delete(inviteId);
      if (map.size === 0) this.invitesByUser.delete(userId);
    }
    this.sendToUser(userId, 'invite:removed', { inviteId, reason });
  }

  private async applyBatch(batch: RoomDeliveryBatch | undefined): Promise<void> {
    if (!batch) return;

    if (batch.joinedUsers) {
      for (const j of batch.joinedUsers) {
        this.userRoom.set(j.userId, { roomId: j.roomId, code: j.code });
        this.codeToRoomId.set(j.code, j.roomId);
      }
    }

    if (batch.removedUsers) {
      for (const r of batch.removedUsers) {
        const cur = this.userRoom.get(r.userId);
        if (cur && cur.roomId === r.roomId) {
          this.userRoom.delete(r.userId);
        }
      }
    }

    if (batch.closedRoom) {
      this.codeToRoomId.delete(batch.closedRoom.code);
      this.roomStatus.delete(batch.closedRoom.roomId);
      for (const uid of batch.closedRoom.affectedUserIds) {
        const cur = this.userRoom.get(uid);
        if (cur && cur.roomId === batch.closedRoom.roomId) {
          this.userRoom.delete(uid);
        }
      }
    }

    if (batch.roomSummary) {
      this.roomStatus.set(batch.roomSummary.id, batch.roomSummary.status);
    }

    if (batch.purgedInvites) {
      for (const inv of batch.purgedInvites) {
        this.removeInviteLocal(inv.userId, inv.inviteId, inv.reason);
      }
    }

    if (batch.deliveries) {
      for (const d of batch.deliveries as DeliveryMessage[]) {
        if (d.targetUserId) {
          this.sendToUser(d.targetUserId, d.event, d.payload);
        } else if (d.targetUserIds) {
          const raw = JSON.stringify({ event: d.event, payload: d.payload });
          for (const uid of d.targetUserIds) {
            const set = this.socketsByUser.get(uid);
            if (!set) continue;
            for (const ws of set) {
              try {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(raw);
                }
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }

    if (batch.presenceChangedUserIds && batch.presenceChangedUserIds.length > 0) {
      const unique = Array.from(new Set(batch.presenceChangedUserIds));
      await Promise.all(unique.map((uid) => this.broadcastPresenceToFriends(uid)));
    }
  }

  private async callRoomAction(
    roomId: string,
    payload: Record<string, unknown>
  ): Promise<{ room?: RoomState | null; gameStarted?: unknown; error?: string; batch?: RoomDeliveryBatch }> {
    const stub = this.getRoomStub(roomId);
    const res = await stub.fetch('https://room/internal/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as {
      room?: RoomState | null;
      gameStarted?: unknown;
      error?: string;
      batch?: RoomDeliveryBatch;
    };
    if (data.batch) {
      await this.applyBatch(data.batch);
    }
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Action rejected by server.');
    }
    return data;
  }

  private generateUniqueRoomCode(): string {
    for (let i = 0; i < 40; i++) {
      const candidate = generateRandomCode();
      if (!this.codeToRoomId.has(candidate)) return candidate;
    }
    return generateRandomCode();
  }

  private async leaveCurrentRoom(userId: string): Promise<void> {
    const cur = this.userRoom.get(userId);
    if (!cur) return;
    this.userRoom.delete(userId);
    try {
      await this.callRoomAction(cur.roomId, { action: 'leave', userId });
    } catch {
      // Room already expired
    }
  }

  private async createRoomForUser(userId: string, levelId: number): Promise<RoomState> {
    const user = await this.db.getPublicUserById(userId, 'online');
    if (!user) throw new Error('User not found.');

    await this.leaveCurrentRoom(userId);

    const roomId = crypto.randomUUID();
    const code = this.generateUniqueRoomCode();
    this.codeToRoomId.set(code, roomId);
    this.roomStatus.set(roomId, 'lobby');

    const res = await this.callRoomAction(roomId, {
      action: 'create',
      roomId,
      code,
      user,
      levelId,
    });
    if (!res.room) {
      this.codeToRoomId.delete(code);
      this.roomStatus.delete(roomId);
      throw new Error('Failed to create room.');
    }
    return res.room;
  }

  private async joinRoomByIdForUser(userId: string, roomId: string): Promise<RoomState> {
    const user = await this.db.getPublicUserById(userId, 'online');
    if (!user) throw new Error('User not found.');

    const current = this.userRoom.get(userId);
    if (current && current.roomId !== roomId) {
      // Check room availability before leaving existing room
      const checkStub = this.getRoomStub(roomId);
      const stateRes = await checkStub.fetch('https://room/internal/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_state' }),
      });
      const stateData = (await stateRes.json()) as { room: RoomState | null };
      if (!stateData.room) {
        throw new Error('Private room not found. Check the room code and try again.');
      }
      if (stateData.room.status !== 'lobby') {
        throw new Error('This match is already in progress.');
      }
      if (stateData.room.players.length >= stateData.room.maxPlayers) {
        throw new Error(`Room is full (${stateData.room.maxPlayers}/${stateData.room.maxPlayers} players).`);
      }
      await this.leaveCurrentRoom(userId);
    }

    const res = await this.callRoomAction(roomId, { action: 'join', user });
    if (!res.room) {
      throw new Error('Private room not found.');
    }
    return res.room;
  }

  private async joinRoomByCodeForUser(userId: string, rawCode: string): Promise<RoomState> {
    const normalized = (rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 4 || normalized.length > 10) {
      throw new Error('Invalid room code format.');
    }
    const roomId = this.codeToRoomId.get(normalized);
    if (!roomId) {
      throw new Error('Private room not found. Check the room code and try again.');
    }
    return this.joinRoomByIdForUser(userId, roomId);
  }

  private async inviteFriend(senderUserId: string, friendUserId: string): Promise<RoomInviteInfo> {
    const roomInfo = this.userRoom.get(senderUserId);
    if (!roomInfo) throw new Error('Create or join a room before inviting friends.');

    const isFriend = await this.db.areFriends(senderUserId, friendUserId);
    if (!isFriend) throw new Error('You can only invite confirmed friends.');

    const friendPresence = this.getPresenceStatus(friendUserId);
    if (friendPresence === 'offline') {
      throw new Error('This friend is currently offline.');
    }

    const sender = await this.db.getPublicUserById(senderUserId, 'online');
    if (!sender) throw new Error('Sender account not found.');

    const stateRes = await this.callRoomAction(roomInfo.roomId, { action: 'get_state' });
    if (!stateRes.room) throw new Error('Room not found.');

    const invite: RoomInviteInfo = {
      id: crypto.randomUUID(),
      roomId: roomInfo.roomId,
      roomCode: roomInfo.code,
      fromUserId: sender.id,
      fromUsername: sender.username,
      fromAvatarColor: sender.avatarColor,
      fromAvatarIcon: sender.avatarIcon,
      levelId: stateRes.room.levelId,
      createdAt: Date.now(),
    };

    await this.callRoomAction(roomInfo.roomId, {
      action: 'register_invite',
      invite,
      toUserId: friendUserId,
    });

    let userMap = this.invitesByUser.get(friendUserId);
    if (!userMap) {
      userMap = new Map();
      this.invitesByUser.set(friendUserId, userMap);
    }
    userMap.set(invite.id, invite);
    this.sendToUser(friendUserId, 'invite:received', invite);
    return invite;
  }

  private async respondToInvite(userId: string, inviteId: string, accept: boolean): Promise<void> {
    const userMap = this.invitesByUser.get(userId);
    const invite = userMap?.get(inviteId);
    if (!invite) {
      throw new Error('Invitation no longer exists or has expired.');
    }

    this.removeInviteLocal(userId, inviteId, accept ? 'accepted' : 'declined');
    try {
      await this.callRoomAction(invite.roomId, { action: 'clear_invite', toUserId: userId });
    } catch {
      // Room may no longer exist
    }

    if (!accept) return;
    await this.joinRoomByIdForUser(userId, invite.roomId);
  }

  private async handleAuthenticateSocket(ws: WebSocket, token: string): Promise<void> {
    const user = await this.db.getUserByToken(token);
    if (!user) {
      ws.send(
        JSON.stringify({
          event: 'auth:error',
          payload: { message: 'Session expired. Please sign in again.' },
        })
      );
      ws.close();
      return;
    }

    this.socketUser.set(ws, user.id);
    let set = this.socketsByUser.get(user.id);
    const wasOffline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.socketsByUser.set(user.id, set);
    }
    set.add(ws);

    let activeRoom: RoomState | null = null;
    let reconnectGameStarted: unknown = null;
    const existingRoom = this.userRoom.get(user.id);
    if (existingRoom) {
      try {
        const res = await this.callRoomAction(existingRoom.roomId, {
          action: 'reconnect',
          userId: user.id,
        });
        activeRoom = res.room ?? null;
        reconnectGameStarted = res.gameStarted ?? null;
        if (!activeRoom) {
          this.userRoom.delete(user.id);
        }
      } catch {
        this.userRoom.delete(user.id);
      }
    }

    const [friends, reqs] = await Promise.all([
      this.db.getFriends(user.id, (id) => this.getPresence(id)),
      this.db.getFriendRequests(user.id),
    ]);
    const pendingInvites = Array.from(this.invitesByUser.get(user.id)?.values() || []);
    const liveUser: PublicUser = {
      ...user,
      status: this.getPresenceStatus(user.id),
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          event: 'auth:ok',
          payload: {
            user: liveUser,
            friends,
            incomingRequests: reqs.incoming,
            outgoingRequests: reqs.outgoing,
            pendingInvites,
            activeRoom,
          },
        })
      );
      if (reconnectGameStarted) {
        ws.send(
          JSON.stringify({
            event: 'game:started',
            payload: reconnectGameStarted,
          })
        );
      }
    }

    if (wasOffline) {
      await this.broadcastPresenceToFriends(user.id);
    }
  }

  private async handleDisconnectSocket(ws: WebSocket): Promise<void> {
    const userId = this.socketUser.get(ws);
    this.socketUser.delete(ws);
    if (!userId) return;

    const set = this.socketsByUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size > 0) return;
      this.socketsByUser.delete(userId);
    }

    const roomInfo = this.userRoom.get(userId);
    if (roomInfo) {
      try {
        await this.callRoomAction(roomInfo.roomId, { action: 'disconnect', userId });
      } catch {
        this.userRoom.delete(userId);
      }
    }

    await this.broadcastPresenceToFriends(userId);
  }

  private async handleWsMessage(ws: WebSocket, rawData: string): Promise<void> {
    let msg: { event?: string; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }

    const event = msg?.event;
    const payload = msg?.payload || {};

    if (event === 'auth') {
      const token = typeof payload.token === 'string' ? payload.token : '';
      await this.handleAuthenticateSocket(ws, token);
      return;
    }

    const userId = this.socketUser.get(ws);
    if (!userId) {
      ws.send(JSON.stringify({ event: 'auth:error', payload: { message: 'Not authenticated.' } }));
      return;
    }

    try {
      switch (event) {
        case 'presence:ping': {
          ws.send(JSON.stringify({ event: 'presence:pong', payload: { t: Date.now() } }));
          break;
        }
        case 'room:create': {
          const levelId = typeof payload.levelId === 'number' ? payload.levelId : 1;
          await this.createRoomForUser(userId, levelId);
          break;
        }
        case 'room:join_code': {
          const code = typeof payload.code === 'string' ? payload.code : '';
          await this.joinRoomByCodeForUser(userId, code);
          break;
        }
        case 'room:leave': {
          await this.leaveCurrentRoom(userId);
          break;
        }
        case 'room:close': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('You are not in a room.');
          await this.callRoomAction(info.roomId, { action: 'close', userId });
          break;
        }
        case 'room:kick': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('You are not in a room.');
          const targetUserId = typeof payload.targetUserId === 'string' ? payload.targetUserId : '';
          await this.callRoomAction(info.roomId, { action: 'kick', userId, targetUserId });
          break;
        }
        case 'room:set_level': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('You are not in a room.');
          const levelId = typeof payload.levelId === 'number' ? payload.levelId : 1;
          await this.callRoomAction(info.roomId, { action: 'set_level', userId, levelId });
          break;
        }
        case 'room:invite': {
          const friendUserId = typeof payload.friendUserId === 'string' ? payload.friendUserId : '';
          await this.inviteFriend(userId, friendUserId);
          break;
        }
        case 'room:invite_respond': {
          const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId : '';
          const accept = Boolean(payload.accept);
          await this.respondToInvite(userId, inviteId, accept);
          break;
        }
        case 'room:start': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('You are not in a room.');
          await this.callRoomAction(info.roomId, { action: 'start', userId });
          break;
        }
        case 'room:return_lobby': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('You are not in a room.');
          await this.callRoomAction(info.roomId, { action: 'return_lobby', userId });
          break;
        }
        case 'game:input_state': {
          const info = this.userRoom.get(userId);
          if (!info) break;
          await this.callRoomAction(info.roomId, { action: 'input_state', userId, packet: payload });
          break;
        }
        case 'game:push': {
          const info = this.userRoom.get(userId);
          if (!info) break;
          await this.callRoomAction(info.roomId, { action: 'push', userId, packet: payload });
          break;
        }
        case 'voice:state': {
          const info = this.userRoom.get(userId);
          if (!info) break;
          await this.callRoomAction(info.roomId, { action: 'voice_state', userId, voice: payload });
          break;
        }
        case 'voice:signal': {
          const info = this.userRoom.get(userId);
          if (!info) throw new Error('Join a private room before using voice chat.');
          const targetUserId = typeof payload.targetUserId === 'string' ? payload.targetUserId : '';
          await this.callRoomAction(info.roomId, {
            action: 'voice_signal',
            fromUserId: userId,
            targetUserId,
            kind: payload.kind,
            data: payload.data,
          });
          break;
        }
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          event: 'room:error',
          payload: {
            message: err instanceof Error ? err.message : 'Action rejected by server.',
          },
        })
      );
    }
  }

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade path
    if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      server.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        void this.handleWsMessage(server, text);
      });
      server.addEventListener('close', () => {
        void this.handleDisconnectSocket(server);
      });
      server.addEventListener('error', () => {
        void this.handleDisconnectSocket(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    if (url.pathname === '/internal/deliver') {
      await this.applyBatch(body as unknown as RoomDeliveryBatch);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/internal/presence') {
      const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
      const map: Record<string, HubPresenceLookup> = {};
      for (const uid of userIds) {
        map[uid] = this.getPresence(uid);
      }
      let activeRoom: RoomState | null = null;
      const roomUserId = typeof body.activeRoomForUserId === 'string' ? body.activeRoomForUserId : '';
      if (roomUserId) {
        const info = this.userRoom.get(roomUserId);
        if (info) {
          try {
            const res = await this.callRoomAction(info.roomId, { action: 'get_state' });
            activeRoom = res.room ?? null;
          } catch {
            this.userRoom.delete(roomUserId);
          }
        }
      }
      return Response.json({ presence: map, activeRoom });
    }

    if (url.pathname === '/internal/push-friends') {
      const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
      await Promise.all(userIds.map((uid) => this.pushFriendsSnapshot(uid)));
      return Response.json({ ok: true });
    }

    if (url.pathname === '/internal/rest-create-room') {
      try {
        const userId = String(body.userId || '');
        const levelId = typeof body.levelId === 'number' ? body.levelId : 1;
        const room = await this.createRoomForUser(userId, levelId);
        return Response.json({ room }, { status: 201 });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : 'Failed to create room.' },
          { status: 400 }
        );
      }
    }

    if (url.pathname === '/internal/rest-join-room') {
      try {
        const userId = String(body.userId || '');
        const code = String(body.code || '');
        const room = await this.joinRoomByCodeForUser(userId, code);
        return Response.json({ room });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : 'Failed to join room.' },
          { status: 400 }
        );
      }
    }

    return new Response('Not found', { status: 404 });
  }
}

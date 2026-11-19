import type {
  ClientPlayerInputPacket,
  ClientPushPacket,
  FriendInfo,
  FriendRequestInfo,
  GamePlayerEvent,
  MonsterNetState,
  PlayerNetState,
  PublicUser,
  RoomInviteInfo,
  RoomState,
  RoomVoicePeerState,
  UserPresenceStatus,
  UserSearchResult,
  VoicePeerStateEvent,
  VoiceSignalKind,
  VoiceSignalPayload,
  WorldSyncPayload,
} from './types';

const TOKEN_STORAGE_KEY = 'deep_tile_mp_token_v1';

const CONFIGURED_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const CONFIGURED_WS_BASE = (import.meta.env.VITE_WS_BASE_URL || '').trim().replace(/\/+$/, '');

function resolveApiUrl(path: string): string {
  if (!CONFIGURED_API_BASE) return path;
  return path.startsWith('/') ? `${CONFIGURED_API_BASE}${path}` : `${CONFIGURED_API_BASE}/${path}`;
}

function resolveWsUrl(): string {
  if (CONFIGURED_WS_BASE) {
    try {
      const parsed = new URL(CONFIGURED_WS_BASE);
      if (parsed.pathname === '' || parsed.pathname === '/') {
        parsed.pathname = '/ws';
      }
      return parsed.toString();
    } catch {
      return CONFIGURED_WS_BASE.endsWith('/ws') ? CONFIGURED_WS_BASE : `${CONFIGURED_WS_BASE}/ws`;
    }
  }
  if (CONFIGURED_API_BASE) {
    try {
      const apiUrl = new URL(CONFIGURED_API_BASE);
      const wsProto = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProto}//${apiUrl.host}/ws`;
    } catch {
      // Fall back to location host below
    }
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export interface MultiplayerSnapshot {
  connected: boolean;
  connecting: boolean;
  user: PublicUser | null;
  friends: FriendInfo[];
  incomingRequests: FriendRequestInfo[];
  outgoingRequests: FriendRequestInfo[];
  pendingInvites: RoomInviteInfo[];
  room: RoomState | null;
  error: string | null;
  lastEvent: GamePlayerEvent | null;
}

export interface GameStartedPayload {
  roomId: string;
  levelId: number;
  timeLimit: number;
  elapsedSec?: number;
  players: PlayerNetState[];
  monsters: MonsterNetState[];
}

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  private state: MultiplayerSnapshot = {
    connected: false,
    connecting: false,
    user: null,
    friends: [],
    incomingRequests: [],
    outgoingRequests: [],
    pendingInvites: [],
    room: null,
    error: null,
    lastEvent: null,
  };

  private snapshotListeners = new Set<(snap: MultiplayerSnapshot) => void>();
  private gameStartListeners = new Set<(payload: GameStartedPayload) => void>();
  private worldListeners = new Set<(world: WorldSyncPayload) => void>();
  private playerEventListeners = new Set<(ev: GamePlayerEvent) => void>();
  private roomNoticeListeners = new Set<(msg: string) => void>();
  private voiceSignalListeners = new Set<(sig: VoiceSignalPayload) => void>();
  private voicePeerStateListeners = new Set<(ev: VoicePeerStateEvent) => void>();
  private voicePeerLeftListeners = new Set<(ev: { roomId: string; userId: string }) => void>();
  private playerMetaById = new Map<string, { username: string; avatarColor: string }>();

  private cachePlayerMeta(
    players?: Array<{ userId: string; username?: string; avatarColor?: string }> | null
  ): void {
    if (!players) return;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.userId && p.username) {
        this.playerMetaById.set(p.userId, {
          username: p.username,
          avatarColor: p.avatarColor || '#52e0b6',
        });
      }
    }
  }

  constructor() {
    try {
      this.token = localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      this.token = null;
    }
  }

  public getSnapshot(): MultiplayerSnapshot {
    return this.state;
  }

  public getToken(): string | null {
    return this.token;
  }

  public subscribe(fn: (snap: MultiplayerSnapshot) => void): () => void {
    this.snapshotListeners.add(fn);
    fn(this.state);
    return () => this.snapshotListeners.delete(fn);
  }

  public onGameStarted(fn: (payload: GameStartedPayload) => void): () => void {
    this.gameStartListeners.add(fn);
    return () => this.gameStartListeners.delete(fn);
  }

  public onWorldSync(fn: (world: WorldSyncPayload) => void): () => void {
    this.worldListeners.add(fn);
    return () => this.worldListeners.delete(fn);
  }

  public onPlayerEvent(fn: (ev: GamePlayerEvent) => void): () => void {
    this.playerEventListeners.add(fn);
    return () => this.playerEventListeners.delete(fn);
  }

  public onRoomNotice(fn: (msg: string) => void): () => void {
    this.roomNoticeListeners.add(fn);
    return () => this.roomNoticeListeners.delete(fn);
  }

  public onVoiceSignal(fn: (sig: VoiceSignalPayload) => void): () => void {
    this.voiceSignalListeners.add(fn);
    return () => this.voiceSignalListeners.delete(fn);
  }

  public onVoicePeerState(fn: (ev: VoicePeerStateEvent) => void): () => void {
    this.voicePeerStateListeners.add(fn);
    return () => this.voicePeerStateListeners.delete(fn);
  }

  public onVoicePeerLeft(fn: (ev: { roomId: string; userId: string }) => void): () => void {
    this.voicePeerLeftListeners.add(fn);
    return () => this.voicePeerLeftListeners.delete(fn);
  }

  private emitState(patch: Partial<MultiplayerSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.snapshotListeners) {
      fn(this.state);
    }
  }

  public clearError(): void {
    if (this.state.error) this.emitState({ error: null });
  }

  private setToken(token: string | null): void {
    this.token = token;
    try {
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    const res = await fetch(resolveApiUrl(url), { ...init, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data as T;
  }

  public async restoreSession(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const res = await this.api<{ user: PublicUser; activeRoom: RoomState | null }>('/api/auth/me');
      this.emitState({ user: res.user, room: res.activeRoom, error: null });
      this.connectWebSocket();
      return true;
    } catch {
      this.setToken(null);
      this.emitState({ user: null, room: null, connected: false });
      return false;
    }
  }

  public async register(
    username: string,
    password: string,
    avatarColor: string,
    avatarIcon: string
  ): Promise<PublicUser> {
    const res = await this.api<{ user: PublicUser; token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, avatarColor, avatarIcon }),
    });
    this.setToken(res.token);
    this.emitState({ user: res.user, error: null });
    this.connectWebSocket();
    return res.user;
  }

  public async login(username: string, password: string): Promise<PublicUser> {
    const res = await this.api<{ user: PublicUser; token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.setToken(res.token);
    this.emitState({ user: res.user, error: null });
    this.connectWebSocket();
    return res.user;
  }

  public logout(): void {
    this.setToken(null);
    this.disconnectWebSocket();
    this.playerMetaById.clear();
    this.emitState({
      connected: false,
      connecting: false,
      user: null,
      friends: [],
      incomingRequests: [],
      outgoingRequests: [],
      pendingInvites: [],
      room: null,
      error: null,
      lastEvent: null,
    });
  }

  public async searchUsers(query: string): Promise<UserSearchResult[]> {
    const res = await this.api<{ users: UserSearchResult[] }>(
      `/api/users/search?q=${encodeURIComponent(query)}`
    );
    return res.users;
  }

  public async sendFriendRequest(targetUserId: string): Promise<void> {
    await this.api('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
  }

  public async respondFriendRequest(requestId: string, action: 'accept' | 'reject'): Promise<void> {
    await this.api('/api/friends/respond', {
      method: 'POST',
      body: JSON.stringify({ requestId, action }),
    });
  }

  public async removeFriend(friendId: string): Promise<void> {
    await this.api(`/api/friends/${encodeURIComponent(friendId)}`, {
      method: 'DELETE',
    });
  }

  public connectWebSocket(): void {
    if (this.disposed || !this.token) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = resolveWsUrl();
    this.emitState({ connecting: true });

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({ event: 'auth', payload: { token: this.token } }));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ event: 'presence:ping', payload: {} }));
        }
      }, 15000);
    };

    ws.onmessage = (msgEv) => {
      let msg: { event?: string; payload?: any };
      try {
        msg = JSON.parse(String(msgEv.data));
      } catch {
        return;
      }

      switch (msg.event) {
        case 'auth:ok': {
          const p = msg.payload;
          if (p.user?.id) {
            this.playerMetaById.set(p.user.id, {
              username: p.user.username,
              avatarColor: p.user.avatarColor || '#52e0b6',
            });
          }
          this.cachePlayerMeta(p.activeRoom?.players);
          this.emitState({
            connected: true,
            connecting: false,
            user: p.user,
            friends: p.friends || [],
            incomingRequests: p.incomingRequests || [],
            outgoingRequests: p.outgoingRequests || [],
            pendingInvites: p.pendingInvites || [],
            room: p.activeRoom || null,
            error: null,
          });
          break;
        }
        case 'auth:error': {
          this.setToken(null);
          this.disconnectWebSocket();
          this.emitState({
            connected: false,
            connecting: false,
            user: null,
            room: null,
            error: msg.payload?.message || 'Authentication failed.',
          });
          break;
        }
        case 'friends:updated': {
          this.emitState({
            friends: msg.payload.friends || [],
            incomingRequests: msg.payload.incomingRequests || [],
            outgoingRequests: msg.payload.outgoingRequests || [],
          });
          break;
        }
        case 'friend:presence': {
          const { userId, status } = msg.payload as { userId: string; status: UserPresenceStatus };
          this.emitState({
            friends: this.state.friends.map((f) => (f.id === userId ? { ...f, status } : f)),
          });
          break;
        }
        case 'invite:received': {
          const inv = msg.payload as RoomInviteInfo;
          const exists = this.state.pendingInvites.some((i) => i.id === inv.id);
          if (!exists) {
            this.emitState({ pendingInvites: [inv, ...this.state.pendingInvites] });
          }
          break;
        }
        case 'invite:removed': {
          const { inviteId } = msg.payload as { inviteId: string };
          this.emitState({
            pendingInvites: this.state.pendingInvites.filter((i) => i.id !== inviteId),
          });
          break;
        }
        case 'room:state': {
          const room = msg.payload as RoomState | null;
          this.cachePlayerMeta(room?.players);
          this.emitState({ room, error: null });
          break;
        }
        case 'room:closed': {
          this.emitState({ room: null });
          const reason = msg.payload?.reason || 'Room was closed.';
          for (const fn of this.roomNoticeListeners) fn(reason);
          break;
        }
        case 'room:kicked': {
          this.emitState({ room: null, error: msg.payload?.reason || 'Removed from room.' });
          const reason = msg.payload?.reason || 'Removed from room.';
          for (const fn of this.roomNoticeListeners) fn(reason);
          break;
        }
        case 'room:error': {
          this.emitState({ error: msg.payload?.message || 'Action failed.' });
          break;
        }
        case 'game:started': {
          const started = msg.payload as GameStartedPayload;
          this.cachePlayerMeta(started?.players);
          for (const fn of this.gameStartListeners) fn(started);
          break;
        }
        case 'game:world': {
          const world = msg.payload as WorldSyncPayload;
          if (world && Array.isArray(world.players)) {
            for (let i = 0; i < world.players.length; i++) {
              const wp = world.players[i];
              if (!wp.username || !wp.avatarColor) {
                const meta = this.playerMetaById.get(wp.userId);
                if (!wp.username) wp.username = meta?.username || 'Diver';
                if (!wp.avatarColor) wp.avatarColor = meta?.avatarColor || '#52e0b6';
              } else {
                this.playerMetaById.set(wp.userId, {
                  username: wp.username,
                  avatarColor: wp.avatarColor,
                });
              }
            }
          }
          for (const fn of this.worldListeners) fn(world);
          break;
        }
        case 'game:player_event': {
          const ev = msg.payload as GamePlayerEvent;
          this.emitState({ lastEvent: ev });
          for (const fn of this.playerEventListeners) fn(ev);
          break;
        }
        case 'voice:signal': {
          const sig = msg.payload as VoiceSignalPayload;
          for (const fn of this.voiceSignalListeners) fn(sig);
          break;
        }
        case 'voice:peer_state': {
          const ev = msg.payload as VoicePeerStateEvent;
          if (this.state.room && this.state.room.id === ev.roomId) {
            const target = this.state.room.players.find((p) => p.userId === ev.userId);
            const curV = target?.voice;
            const changed =
              !curV ||
              curV.voiceActive !== ev.voice.voiceActive ||
              curV.micEnabled !== ev.voice.micEnabled ||
              curV.selfMuted !== ev.voice.selfMuted ||
              curV.speaking !== ev.voice.speaking;
            if (changed) {
              const updatedRoom: RoomState = {
                ...this.state.room,
                players: this.state.room.players.map((p) =>
                  p.userId === ev.userId ? { ...p, voice: ev.voice } : p
                ),
              };
              this.emitState({ room: updatedRoom });
            }
          }
          for (const fn of this.voicePeerStateListeners) fn(ev);
          break;
        }
        case 'voice:peer_left': {
          const ev = msg.payload as { roomId: string; userId: string };
          for (const fn of this.voicePeerLeftListeners) fn(ev);
          break;
        }
      }
    };

    ws.onclose = () => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.ws === ws) this.ws = null;
      this.emitState({ connected: false, connecting: false });

      if (!this.disposed && this.token) {
        const delay = Math.min(8000, 800 * Math.pow(1.6, this.reconnectAttempt++));
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
      }
    };
  }

  public disconnectWebSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.disconnectWebSocket();
  }

  private sendWs(event: string, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitState({ error: 'Not connected to multiplayer server. Reconnecting...' });
      this.connectWebSocket();
      return false;
    }
    this.ws.send(JSON.stringify({ event, payload }));
    return true;
  }

  public createRoom(levelId: number): void {
    this.clearError();
    this.sendWs('room:create', { levelId });
  }

  public joinRoomByCode(code: string): void {
    this.clearError();
    this.sendWs('room:join_code', { code });
  }

  public leaveRoom(): void {
    this.clearError();
    this.sendWs('room:leave', {});
  }

  public closeRoom(): void {
    this.clearError();
    this.sendWs('room:close', {});
  }

  public kickPlayer(targetUserId: string): void {
    this.clearError();
    this.sendWs('room:kick', { targetUserId });
  }

  public setRoomLevel(levelId: number): void {
    this.clearError();
    this.sendWs('room:set_level', { levelId });
  }

  public inviteFriend(friendUserId: string): void {
    this.clearError();
    this.sendWs('room:invite', { friendUserId });
  }

  public respondToInvite(inviteId: string, accept: boolean): void {
    this.clearError();
    this.sendWs('room:invite_respond', { inviteId, accept });
  }

  public startGame(): void {
    this.clearError();
    this.sendWs('room:start', {});
  }

  public returnToLobby(): void {
    this.clearError();
    this.sendWs('room:return_lobby', {});
  }

  public sendPlayerInputState(packet: ClientPlayerInputPacket): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'game:input_state', payload: packet }));
  }

  public sendPush(packet: ClientPushPacket): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'game:push', payload: packet }));
  }

  public sendVoiceState(voice: RoomVoicePeerState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'voice:state', payload: voice }));
  }

  public sendVoiceSignal(targetUserId: string, kind: VoiceSignalKind, data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'voice:signal', payload: { targetUserId, kind, data } }));
  }

  public async getVoiceIceConfig(): Promise<{ iceServers: RTCIceServer[] }> {
    return this.api<{ iceServers: RTCIceServer[] }>('/api/voice/ice-config');
  }
}

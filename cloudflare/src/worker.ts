import type { PublicUser, RoomState } from '../../src/multiplayer/types.ts';
import { CloudflareD1Database } from './db.ts';
import { PresenceHubDO } from './hubDO.ts';
import { GameRoomDO } from './roomDO.ts';
import type { Env, HubPresenceLookup } from './types.ts';

export { GameRoomDO, PresenceHubDO };

function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowedRaw = (env.ALLOWED_ORIGINS || '*').trim();

  let allowOrigin = '*';
  if (allowedRaw !== '*') {
    const allowedList = allowedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (origin && allowedList.includes(origin)) {
      allowOrigin = origin;
    } else if (
      origin &&
      (origin === 'https://localhost' ||
        origin === 'http://localhost' ||
        origin === 'capacitor://localhost' ||
        origin === 'tauri://localhost' ||
        origin === 'http://tauri.localhost' ||
        origin === 'https://tauri.localhost')
    ) {
      // Allow Capacitor iOS/Android & Tauri desktop origins by default
      allowOrigin = origin;
    } else if (allowedList.length > 0) {
      allowOrigin = allowedList[0];
    }
  } else if (origin) {
    allowOrigin = origin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function getHubStub(env: Env): DurableObjectStub {
  return env.PRESENCE_HUB.get(env.PRESENCE_HUB.idFromName('global-presence-hub'));
}

async function queryHubPresence(
  env: Env,
  userIds: string[],
  activeRoomForUserId?: string
): Promise<{ presence: Record<string, HubPresenceLookup>; activeRoom: RoomState | null }> {
  const hub = getHubStub(env);
  const res = await hub.fetch('https://presence-hub/internal/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds, activeRoomForUserId }),
  });
  return (await res.json()) as {
    presence: Record<string, HubPresenceLookup>;
    activeRoom: RoomState | null;
  };
}

async function pushFriendsUpdate(env: Env, userIds: string[]): Promise<void> {
  const hub = getHubStub(env);
  await hub.fetch('https://presence-hub/internal/push-friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });
}

async function authenticateRequest(
  request: Request,
  db: CloudflareD1Database
): Promise<PublicUser | null> {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  return db.getUserByToken(token);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Forward WebSocket upgrade directly to PresenceHubDO
    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade') || '';
      if (upgrade.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected WebSocket upgrade.' }, 426, cors);
      }
      const hub = getHubStub(env);
      return hub.fetch(request);
    }

    const db = new CloudflareD1Database(env.DB);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, runtime: 'cloudflare-workers' }, 200, cors);
    }

    if (url.pathname === '/api/auth/register' && request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const result = await db.registerUser(
          String(body.username || ''),
          String(body.password || ''),
          typeof body.avatarColor === 'string' ? body.avatarColor : undefined,
          typeof body.avatarIcon === 'string' ? body.avatarIcon : undefined
        );
        return jsonResponse(result, 201, cors);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : 'Registration failed.' },
          400,
          cors
        );
      }
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const result = await db.loginUser(String(body.username || ''), String(body.password || ''));
        const { presence } = await queryHubPresence(env, [result.user.id]);
        result.user.status = presence[result.user.id]?.status || 'offline';
        return jsonResponse(result, 200, cors);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : 'Login failed.' },
          401,
          cors
        );
      }
    }

    // Protected endpoints below
    const authUser = await authenticateRequest(request, db);
    if (!authUser) {
      return jsonResponse({ error: 'Authentication required.' }, 401, cors);
    }

    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const { presence, activeRoom } = await queryHubPresence(env, [authUser.id], authUser.id);
      return jsonResponse(
        {
          user: {
            ...authUser,
            status: presence[authUser.id]?.status || 'offline',
          },
          activeRoom,
        },
        200,
        cors
      );
    }

    if (url.pathname === '/api/users/search' && request.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const rawUsers = await db.searchUsers(authUser.id, q, () => 'offline');
      const { presence } = await queryHubPresence(
        env,
        rawUsers.map((u) => u.id)
      );
      const users = rawUsers.map((u) => ({
        ...u,
        status: presence[u.id]?.status || 'offline',
      }));
      return jsonResponse({ users }, 200, cors);
    }

    if (url.pathname === '/api/friends' && request.method === 'GET') {
      const [friendIds, reqs] = await Promise.all([
        db.getFriendIds(authUser.id),
        db.getFriendRequests(authUser.id),
      ]);
      const { presence } = await queryHubPresence(env, friendIds);
      const friends = await db.getFriends(
        authUser.id,
        (id) => presence[id] || { status: 'offline', inRoomId: null }
      );
      return jsonResponse(
        {
          friends,
          incomingRequests: reqs.incoming,
          outgoingRequests: reqs.outgoing,
        },
        200,
        cors
      );
    }

    if (url.pathname === '/api/friends/request' && request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : '';
        const reqInfo = await db.sendFriendRequest(authUser.id, targetUserId);
        await pushFriendsUpdate(env, [authUser.id, targetUserId]);
        return jsonResponse({ request: reqInfo }, 201, cors);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : 'Failed to send request.' },
          400,
          cors
        );
      }
    }

    if (url.pathname === '/api/friends/respond' && request.method === 'POST') {
      try {
        const body = await readJsonBody(request);
        const requestId = typeof body.requestId === 'string' ? body.requestId : '';
        const action = body.action === 'accept' ? 'accept' : body.action === 'reject' ? 'reject' : null;
        if (!action) {
          return jsonResponse({ error: 'Invalid friend request action.' }, 400, cors);
        }
        const outcome = await db.respondFriendRequest(authUser.id, requestId, action);
        await pushFriendsUpdate(env, [authUser.id, outcome.fromUserId]);
        return jsonResponse(outcome, 200, cors);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : 'Failed to respond to request.' },
          400,
          cors
        );
      }
    }

    if (url.pathname.startsWith('/api/friends/') && request.method === 'DELETE') {
      const friendId = decodeURIComponent(url.pathname.slice('/api/friends/'.length));
      await db.removeFriend(authUser.id, friendId);
      await pushFriendsUpdate(env, [authUser.id, friendId]);
      return jsonResponse({ ok: true }, 200, cors);
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const levelId = typeof body.levelId === 'number' ? body.levelId : 1;
      const hub = getHubStub(env);
      const res = await hub.fetch('https://presence-hub/internal/rest-create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: authUser.id, levelId }),
      });
      const data = await res.json();
      return jsonResponse(data, res.status, cors);
    }

    if (url.pathname === '/api/rooms/join' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const code = typeof body.code === 'string' ? body.code : '';
      const hub = getHubStub(env);
      const res = await hub.fetch('https://presence-hub/internal/rest-join-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: authUser.id, code }),
      });
      const data = await res.json();
      return jsonResponse(data, res.status, cors);
    }

    if (url.pathname === '/api/voice/ice-config' && request.method === 'GET') {
      const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302',
          ],
        },
      ];
      const turnUrl = env.VOICE_TURN_URL?.trim();
      if (turnUrl) {
        const turnEntry: { urls: string; username?: string; credential?: string } = { urls: turnUrl };
        if (env.VOICE_TURN_USERNAME) turnEntry.username = env.VOICE_TURN_USERNAME;
        if (env.VOICE_TURN_CREDENTIAL) turnEntry.credential = env.VOICE_TURN_CREDENTIAL;
        iceServers.push(turnEntry);
      }
      return jsonResponse({ iceServers }, 200, cors);
    }

    return jsonResponse({ error: 'Not found.' }, 404, cors);
  },
};

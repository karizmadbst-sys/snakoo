import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MultiplayerDatabase } from './server/db.ts';
import { MultiplayerManager } from './server/multiplayerManager.ts';
import type {
  ClientPlayerInputPacket,
  ClientPushPacket,
  PublicUser,
  RoomVoicePeerState,
  VoiceSignalKind,
} from './src/multiplayer/types.ts';

interface AuthedRequest extends Request {
  authUser?: PublicUser;
}

export interface ServerOptions {
  dbPath?: string;
  attachVite?: boolean;
  disconnectGraceMs?: number;
}

export async function createAppServer(options: ServerOptions = {}) {
  const db = new MultiplayerDatabase(options.dbPath);
  const manager = new MultiplayerManager(db, options.disconnectGraceMs ?? 8000);
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const authenticate = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = db.getUserByToken(token);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    req.authUser = {
      ...user,
      status: manager.getPresenceStatus(user.id),
    };
    next();
  };

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Auth routes
  app.post('/api/auth/register', (req, res) => {
    try {
      const { username, password, avatarColor, avatarIcon } = req.body || {};
      const result = db.registerUser(username, password, avatarColor, avatarIcon);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const { username, password } = req.body || {};
      const result = db.loginUser(username, password);
      result.user.status = manager.getPresenceStatus(result.user.id);
      res.json(result);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  });

  app.get('/api/auth/me', authenticate, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    res.json({
      user,
      activeRoom: manager.getUserRoom(user.id),
    });
  });

  // Searchable players & Friends routes
  app.get('/api/users/search', authenticate, (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const results = db.searchUsers(req.authUser!.id, q, (id) => manager.getPresenceStatus(id));
    res.json({ users: results });
  });

  app.get('/api/friends', authenticate, (req: AuthedRequest, res) => {
    const uid = req.authUser!.id;
    const friends = db.getFriends(uid, (id) => manager.getPresence(id));
    const reqs = db.getFriendRequests(uid);
    res.json({
      friends,
      incomingRequests: reqs.incoming,
      outgoingRequests: reqs.outgoing,
    });
  });

  app.post('/api/friends/request', authenticate, (req: AuthedRequest, res) => {
    try {
      const uid = req.authUser!.id;
      const targetUserId = typeof req.body?.targetUserId === 'string' ? req.body.targetUserId : '';
      const request = db.sendFriendRequest(uid, targetUserId);
      manager.pushFriendsSnapshot(uid);
      manager.pushFriendsSnapshot(targetUserId);
      res.status(201).json({ request });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to send request.' });
    }
  });

  app.post('/api/friends/respond', authenticate, (req: AuthedRequest, res) => {
    try {
      const uid = req.authUser!.id;
      const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
      const action = req.body?.action === 'accept' ? 'accept' : req.body?.action === 'reject' ? 'reject' : null;
      if (!action) {
        res.status(400).json({ error: 'Invalid friend request action.' });
        return;
      }
      const outcome = db.respondFriendRequest(uid, requestId, action);
      manager.pushFriendsSnapshot(uid);
      manager.pushFriendsSnapshot(outcome.fromUserId);
      res.json(outcome);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to respond to request.' });
    }
  });

  app.delete('/api/friends/:friendId', authenticate, (req: AuthedRequest, res) => {
    const uid = req.authUser!.id;
    const friendId = String(req.params.friendId || '');
    db.removeFriend(uid, friendId);
    manager.pushFriendsSnapshot(uid);
    manager.pushFriendsSnapshot(friendId);
    res.json({ ok: true });
  });

  // Private Room REST endpoints (complementing WebSocket actions, sharing exact server manager)
  app.post('/api/rooms', authenticate, (req: AuthedRequest, res) => {
    try {
      const levelId = typeof req.body?.levelId === 'number' ? req.body.levelId : 1;
      const room = manager.createRoom(req.authUser!.id, levelId);
      res.status(201).json({ room });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create room.' });
    }
  });

  app.post('/api/rooms/join', authenticate, (req: AuthedRequest, res) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const room = manager.joinRoomByCode(req.authUser!.id, code);
      res.json({ room });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to join room.' });
    }
  });

  // Authenticated WebRTC ICE server config (public STUN + optional env TURN)
  app.get('/api/voice/ice-config', authenticate, (_req: AuthedRequest, res) => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
        ],
      },
    ];
    const turnUrl = process.env.VOICE_TURN_URL?.trim();
    if (turnUrl) {
      const turnEntry: { urls: string; username?: string; credential?: string } = { urls: turnUrl };
      if (process.env.VOICE_TURN_USERNAME) turnEntry.username = process.env.VOICE_TURN_USERNAME;
      if (process.env.VOICE_TURN_CREDENTIAL) turnEntry.credential = process.env.VOICE_TURN_CREDENTIAL;
      iceServers.push(turnEntry);
    }
    res.json({ iceServers });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  const wsAuthUser = new WeakMap<WebSocket, string>();

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (rawBuf) => {
      let msg: { event?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(rawBuf.toString('utf8'));
      } catch {
        return;
      }
      const event = msg?.event;
      const payload = msg?.payload || {};

      if (event === 'auth') {
        const token = typeof payload.token === 'string' ? payload.token : '';
        const user = db.getUserByToken(token);
        if (!user) {
          ws.send(JSON.stringify({ event: 'auth:error', payload: { message: 'Session expired. Please sign in again.' } }));
          ws.close();
          return;
        }
        wsAuthUser.set(ws, user.id);
        manager.registerSocket(user.id, ws);
        return;
      }

      const userId = wsAuthUser.get(ws);
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
            manager.createRoom(userId, levelId);
            break;
          }
          case 'room:join_code': {
            const code = typeof payload.code === 'string' ? payload.code : '';
            manager.joinRoomByCode(userId, code);
            break;
          }
          case 'room:leave': {
            manager.leaveRoom(userId);
            break;
          }
          case 'room:close': {
            manager.closeRoom(userId);
            break;
          }
          case 'room:kick': {
            const targetUserId = typeof payload.targetUserId === 'string' ? payload.targetUserId : '';
            manager.kickPlayer(userId, targetUserId);
            break;
          }
          case 'room:set_level': {
            const levelId = typeof payload.levelId === 'number' ? payload.levelId : 1;
            manager.setRoomLevel(userId, levelId);
            break;
          }
          case 'room:invite': {
            const friendUserId = typeof payload.friendUserId === 'string' ? payload.friendUserId : '';
            manager.inviteFriend(userId, friendUserId);
            break;
          }
          case 'room:invite_respond': {
            const inviteId = typeof payload.inviteId === 'string' ? payload.inviteId : '';
            const accept = Boolean(payload.accept);
            manager.respondToInvite(userId, inviteId, accept);
            break;
          }
          case 'room:start': {
            manager.startGame(userId);
            break;
          }
          case 'room:return_lobby': {
            manager.returnToLobby(userId);
            break;
          }
          case 'game:input_state': {
            manager.handlePlayerInputState(userId, payload as unknown as ClientPlayerInputPacket);
            break;
          }
          case 'game:push': {
            manager.handlePushPlayer(userId, payload as unknown as ClientPushPacket);
            break;
          }
          case 'voice:state': {
            manager.updateVoiceState(userId, payload as Partial<RoomVoicePeerState>);
            break;
          }
          case 'voice:signal': {
            const targetUserId = typeof payload.targetUserId === 'string' ? payload.targetUserId : '';
            const kind = payload.kind as VoiceSignalKind;
            manager.relayVoiceSignal(userId, targetUserId, kind, payload.data);
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
    });

    ws.on('close', () => {
      manager.handleSocketDisconnect(ws);
    });
  });

  const shouldAttachVite = options.attachVite ?? process.env.NODE_ENV !== 'production';

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    if (reqUrl.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    const wsProtocol = req.headers['sec-websocket-protocol'];
    if (shouldAttachVite && (wsProtocol === 'vite-hmr' || wsProtocol === 'vite-ping')) {
      return;
    }

    socket.destroy();
  });

  // Serve Vite dev middleware in development or static dist/ in production
  let viteServer: { close: () => Promise<void> } | null = null;
  if (shouldAttachVite) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server },
      },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return {
    app,
    server,
    wss,
    db,
    manager,
    close: async () => {
      manager.dispose();
      if (viteServer) {
        await viteServer.close();
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryFile === path.resolve(currentFile)) {
  const port = Number(process.env.PORT || 3000);
  createAppServer()
    .then(({ server }) => {
      server.listen(port, '0.0.0.0', () => {
        console.log(`SERPENTIS server listening on http://0.0.0.0:${port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start SERPENTIS server:', err);
      process.exit(1);
    });
}

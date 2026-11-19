import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createAppServer } from '../server.ts';
import {
  LEVELS,
  TOTAL_LEVELS,
  getLevelById,
  getLevelSummary,
  isValidLevelId,
} from '../src/game/levels.ts';
import {
  EAT_DURATION_MS,
  MAX_ROOM_PLAYERS,
  MIN_ROOM_PLAYERS,
  PUSH_COOLDOWN_MS,
  PUSH_FORCE_HORIZ,
  PUSH_FORCE_LIFT_Y,
  PUSH_RECOVERY_MS,
  type GamePlayerEvent,
  type PublicUser,
  type RoomInviteInfo,
  type RoomState,
  type WorldSyncPayload,
} from '../src/multiplayer/types.ts';
import { isPushPathObstructed, selectPushTarget } from '../src/multiplayer/pushPhysics.ts';

interface TestPacket {
  event: string;
  payload: unknown;
}

class TestClient {
  public user!: PublicUser;
  public token!: string;
  public ws!: WebSocket;
  public currentRoom: RoomState | null = null;
  public invites: RoomInviteInfo[] = [];
  public packets: TestPacket[] = [];
  private baseUrl: string;
  private wsUrl: string;
  private waiters: Array<(pkt: TestPacket) => boolean> = [];

  constructor(baseUrl: string, wsUrl: string) {
    this.baseUrl = baseUrl;
    this.wsUrl = wsUrl;
  }

  public async register(username: string, password = 'password123'): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json()) as { user?: PublicUser; token?: string; error?: string };
    if (!res.ok || !data.token || !data.user) {
      throw new Error(data.error || `Register failed for ${username}`);
    }
    this.user = data.user;
    this.token = data.token;
    await this.connectWs();
  }

  public async connectWs(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        reject(new Error(`WS auth timeout for ${this.user?.username}`));
      }, 4000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'auth', payload: { token: this.token } }));
      });

      ws.on('message', (raw) => {
        const pkt = JSON.parse(raw.toString('utf8')) as TestPacket;
        this.packets.push(pkt);

        if (pkt.event === 'auth:ok') {
          const p = pkt.payload as {
            user: PublicUser;
            pendingInvites: RoomInviteInfo[];
            activeRoom: RoomState | null;
          };
          this.user = p.user;
          this.invites = p.pendingInvites;
          this.currentRoom = p.activeRoom;
          clearTimeout(timer);
          resolve();
        } else if (pkt.event === 'room:state') {
          this.currentRoom = pkt.payload as RoomState | null;
        } else if (pkt.event === 'room:closed' || pkt.event === 'room:kicked') {
          this.currentRoom = null;
        } else if (pkt.event === 'invite:received') {
          this.invites.push(pkt.payload as RoomInviteInfo);
        } else if (pkt.event === 'invite:removed') {
          const rm = pkt.payload as { inviteId: string };
          this.invites = this.invites.filter((i) => i.id !== rm.inviteId);
        }

        this.waiters = this.waiters.filter((fn) => !fn(pkt));
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  public send(event: string, payload: Record<string, unknown> = {}): void {
    this.ws.send(JSON.stringify({ event, payload }));
  }

  public waitFor(
    predicate: (pkt: TestPacket) => boolean,
    label: string,
    timeoutMs = 3500
  ): Promise<TestPacket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${label} (${this.user?.username})`));
      }, timeoutMs);

      const matcher = (pkt: TestPacket): boolean => {
        if (predicate(pkt)) {
          clearTimeout(timer);
          resolve(pkt);
          return true;
        }
        return false;
      };
      this.waiters.push(matcher);
    });
  }

  public async http(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json()) as Record<string, unknown>;
    return { status: res.status, data };
  }

  public close(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
  }
}

async function runTests() {
  const srv = await createAppServer({
    dbPath: ':memory:',
    attachVite: false,
    disconnectGraceMs: 60,
  });

  await new Promise<void>((resolve) => srv.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const clients: TestClient[] = [];
  const makeClient = async (name: string) => {
    const c = new TestClient(baseUrl, wsUrl);
    await c.register(name);
    clients.push(c);
    return c;
  };

  try {
    console.log('1. Testing user accounts, search, and friend requests...');
    const host = await makeClient('HostPlayer');
    const friend = await makeClient('FriendPlayer');
    const stranger = await makeClient('StrangerPlayer');

    // Search returns real users only
    const searchRes = await host.http('/api/users/search?q=Friend');
    assert.equal(searchRes.status, 200);
    const searchUsers = searchRes.data.users as Array<{ id: string; username: string; relationship: string }>;
    assert.equal(searchUsers.length, 1);
    assert.equal(searchUsers[0].username, 'FriendPlayer');
    assert.equal(searchUsers[0].relationship, 'none');

    // Send & prevent duplicate friend request
    const frRes = await host.http('/api/friends/request', 'POST', { targetUserId: friend.user.id });
    assert.equal(frRes.status, 201);
    const dupFrRes = await host.http('/api/friends/request', 'POST', { targetUserId: friend.user.id });
    assert.equal(dupFrRes.status, 400);

    // Reject flow works
    const rejectFr = await stranger.http('/api/friends/request', 'POST', { targetUserId: friend.user.id });
    assert.equal(rejectFr.status, 201);
    const friendListBefore = await friend.http('/api/friends');
    const incomingList = friendListBefore.data.incomingRequests as Array<{ id: string; fromUserId: string }>;
    const strangerReq = incomingList.find((r) => r.fromUserId === stranger.user.id)!;
    const hostReq = incomingList.find((r) => r.fromUserId === host.user.id)!;

    await friend.http('/api/friends/respond', 'POST', { requestId: strangerReq.id, action: 'reject' });
    await friend.http('/api/friends/respond', 'POST', { requestId: hostReq.id, action: 'accept' });

    const hostFriendsRes = await host.http('/api/friends');
    const hostFriends = hostFriendsRes.data.friends as Array<{ id: string; status: string }>;
    assert.equal(hostFriends.length, 1);
    assert.equal(hostFriends[0].id, friend.user.id);
    assert.equal(hostFriends[0].status, 'online');
    console.log('   PASS: Real accounts, search, friend request accept/reject & live presence verified.');

    console.log('2. Testing Scenario 1: 1 player cannot start match (min 2 players enforced)...');
    const roomCreatedWait = host.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'room:create');
    host.send('room:create', { levelId: 1 });
    await roomCreatedWait;
    assert.ok(host.currentRoom);
    assert.equal(host.currentRoom.players.length, 1);
    assert.equal(host.currentRoom.minPlayers, MIN_ROOM_PLAYERS);
    assert.equal(host.currentRoom.maxPlayers, MAX_ROOM_PLAYERS);

    const startBlockedWait = host.waitFor((p) => p.event === 'room:error', 'room:start blocked for 1 player');
    host.send('room:start');
    const blockedErr = await startBlockedWait;
    assert.match((blockedErr.payload as { message: string }).message, /At least 2 real players/i);
    console.log('   PASS: 1 player strictly prevented from starting.');

    console.log('3. Testing Invalid room code, private invites, and Scenario 2 (2 players start + shared serpent sync)...');
    const invalidJoin = await stranger.http('/api/rooms/join', 'POST', { code: 'ZZZZZZ' });
    assert.equal(invalidJoin.status, 400);

    // Send invite & test duplicate invite prevention
    const inviteReceivedWait = friend.waitFor((p) => p.event === 'invite:received', 'invite received');
    host.send('room:invite', { friendUserId: friend.user.id });
    const invPkt = await inviteReceivedWait;
    const inv = invPkt.payload as RoomInviteInfo;

    const dupInvWait = host.waitFor((p) => p.event === 'room:error', 'duplicate invite blocked');
    host.send('room:invite', { friendUserId: friend.user.id });
    await dupInvWait;

    // Non-host cannot start
    const acceptJoinWait = friend.waitFor(
      (p) => p.event === 'room:state' && (p.payload as RoomState | null)?.players.length === 2,
      'friend joined via invite'
    );
    friend.send('room:invite_respond', { inviteId: inv.id, accept: true });
    await acceptJoinWait;
    assert.equal(friend.currentRoom?.players.length, 2);
    assert.ok(friend.currentRoom?.players.every((p) => p.isBot === false));

    const nonHostStartWait = friend.waitFor((p) => p.event === 'room:error', 'non-host start blocked');
    friend.send('room:start');
    await nonHostStartWait;

    // 2 real players CAN start match
    const hostStartWait = host.waitFor((p) => p.event === 'game:started', 'host game:started');
    const friendStartWait = friend.waitFor((p) => p.event === 'game:started', 'friend game:started');
    host.send('room:start');
    await Promise.all([hostStartWait, friendStartWait]);

    // Verify shared sea serpent chases friend in water, triggers synchronized eating_started, allows host to play normally during swallow, and emits caught only after EAT_DURATION_MS
    const hostEatStartWait = host.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'eating_started',
      'shared serpent eating_started on host'
    );
    const friendEatStartWait = friend.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'eating_started',
      'shared serpent eating_started on friend'
    );
    const hostCatchEventWait = host.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'caught',
      'shared serpent catch event on host',
      EAT_DURATION_MS + 3500
    );
    const friendCatchEventWait = friend.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'caught',
      'shared serpent catch event on friend',
      EAT_DURATION_MS + 3500
    );

    // Place friend directly in water (-1.1 below surface) near serpent waypoint (0, -25) while host stays safe on spawn deck
    const friendInWaterInterval = setInterval(() => {
      friend.send('game:input_state', {
        x: 0,
        y: -1.1,
        z: -24,
        yaw: 0,
        animState: 'swim',
        horizSpeed: 2,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });
    }, 45);

    const worldChaseWait = host.waitFor(
      (p) =>
        p.event === 'game:world' &&
        (p.payload as WorldSyncPayload).monsters.some((m) => m.alert === 'chasing' && m.targetUserId === friend.user.id),
      'shared serpent targets player in water'
    );

    await worldChaseWait;
    const [hostEatPkt, friendEatPkt] = await Promise.all([hostEatStartWait, friendEatStartWait]);
    const eatStartMs = Date.now();
    clearInterval(friendInWaterInterval);
    const hostEatEv = hostEatPkt.payload as GamePlayerEvent;
    const friendEatEv = friendEatPkt.payload as GamePlayerEvent;
    assert.equal(hostEatEv.userId, friend.user.id);
    assert.equal(friendEatEv.userId, friend.user.id);
    assert.ok(hostEatEv.monsterId, 'eating_started must identify monsterId');
    assert.equal(hostEatEv.x, friendEatEv.x);
    assert.equal(hostEatEv.z, friendEatEv.z);

    // Mid-swallow (~400ms): friend must STILL be alive=true, monster must broadcast eatingUserId + eatingProgress, and host must move normally
    await new Promise((r) => setTimeout(r, 400));
    const level1Spawn = LEVELS.find((l) => l.id === 1)!.spawn;
    const midSwallowHostX = level1Spawn[0] + 1.25;
    host.send('game:input_state', {
      x: midSwallowHostX,
      y: level1Spawn[1],
      z: level1Spawn[2],
      yaw: Math.PI,
      animState: 'walk',
      horizSpeed: 4,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    });
    const midEatWorldPkt = await host.waitFor(
      (p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const hState = w.players.find((pl) => pl.userId === host.user.id);
        const fState = w.players.find((pl) => pl.userId === friend.user.id);
        const mState = w.monsters.find((m) => m.eatingUserId === friend.user.id);
        return Boolean(
          hState &&
            Math.abs(hState.x - midSwallowHostX) < 0.05 &&
            fState &&
            fState.alive === true &&
            mState &&
            typeof mState.eatingProgress === 'number' &&
            mState.eatingProgress > 0 &&
            mState.eatingProgress < 1
        );
      },
      'mid-swallow world sync shows victim alive, monster eatingProgress in (0,1), and host moving freely'
    );
    assert.ok(midEatWorldPkt);

    const [hostCatchPkt, friendCatchPkt] = await Promise.all([hostCatchEventWait, friendCatchEventWait]);
    const eatElapsedMs = Date.now() - eatStartMs;
    assert.ok(
      eatElapsedMs >= EAT_DURATION_MS - 180,
      `caught must not fire before eating finishes (elapsed=${eatElapsedMs}ms, expected>=${EAT_DURATION_MS - 180}ms)`
    );
    const hostCatchEv = hostCatchPkt.payload as GamePlayerEvent;
    const friendCatchEv = friendCatchPkt.payload as GamePlayerEvent;
    assert.equal(hostCatchEv.userId, friend.user.id);
    assert.equal(friendCatchEv.userId, friend.user.id);
    assert.ok(Number.isFinite(hostCatchEv.x) && Number.isFinite(hostCatchEv.y) && Number.isFinite(hostCatchEv.z), 'Caught event must include 3D coordinates');
    assert.equal(hostCatchEv.x, friendCatchEv.x);
    assert.equal(hostCatchEv.z, friendCatchEv.z);

    // Host returns room to lobby cleanly
    const backLobbyWait = friend.waitFor(
      (p) => p.event === 'room:state' && (p.payload as RoomState | null)?.status === 'lobby',
      'return to lobby'
    );
    host.send('room:return_lobby');
    await backLobbyWait;
    console.log('   PASS: 2 players start match, synchronized two-phase eating plays over EAT_DURATION_MS while teammate moves freely, then eliminates victim.');

    console.log('4. Testing Scenario 3 (Max 12 players), Scenario 4 (13th rejected), Scenario 5 (Leave opens slot)...');
    // Currently room has 2 players (host + friend). Add 10 more = 12 total!
    const roomCode = host.currentRoom!.code;
    const extraPlayers: TestClient[] = [];
    for (let i = 3; i <= 12; i++) {
      const p = await makeClient(`SquadMember_${i}`);
      extraPlayers.push(p);
      const joinRes = await p.http('/api/rooms/join', 'POST', { code: roomCode });
      assert.equal(joinRes.status, 200, `Player ${i} failed to join`);
    }

    // Wait briefly for room:state propagation
    await new Promise((r) => setTimeout(r, 40));
    const roomRes12 = await host.http('/api/auth/me');
    const active12 = roomRes12.data.activeRoom as RoomState;
    assert.equal(active12.players.length, 12, 'Room must hold exactly 12/12 players');

    // Scenario 4: 13th player must be rejected (HTTP + WS)
    const p13 = await makeClient('Player13');
    const reject13Http = await p13.http('/api/rooms/join', 'POST', { code: roomCode });
    assert.equal(reject13Http.status, 400);
    assert.match(String(reject13Http.data.error), /full \(12\/12/i);

    const reject13WsWait = p13.waitFor((p) => p.event === 'room:error', '13th WS join rejected');
    p13.send('room:join_code', { code: roomCode });
    const reject13Ws = await reject13WsWait;
    assert.match((reject13Ws.payload as { message: string }).message, /full \(12\/12/i);

    // Scenario 5: One player leaves -> slot opens -> Player 13 joins!
    const leaver = extraPlayers[0];
    const leaveWait = host.waitFor(
      (p) => p.event === 'room:state' && (p.payload as RoomState | null)?.players.length === 11,
      'slot opens to 11/12'
    );
    leaver.send('room:leave');
    await leaveWait;

    const join13AfterLeave = await p13.http('/api/rooms/join', 'POST', { code: roomCode });
    assert.equal(join13AfterLeave.status, 200);
    assert.equal((join13AfterLeave.data.room as RoomState).players.length, 12);
    console.log('   PASS: 12-player cap enforced, 13th rejected, leaving freed 1 slot for 13th player.');

    console.log('5. Testing Scenario 6: Host disconnect safely transfers ownership...');
    const oldHostId = host.user.id;
    const transferWait = friend.waitFor(
      (p) =>
        p.event === 'room:state' &&
        (p.payload as RoomState | null)?.hostId !== undefined &&
        (p.payload as RoomState | null)?.hostId !== oldHostId,
      'host ownership transfer'
    );
    host.close();
    const transferPkt = await transferWait;
    const afterTransfer = transferPkt.payload as RoomState;
    assert.equal(afterTransfer.players.length, 11);
    assert.notEqual(afterTransfer.hostId, oldHostId);
    const newHost = clients.find((c) => c.user.id === afterTransfer.hostId)!;
    assert.ok(newHost, 'New host must be one of the remaining connected players');
    assert.ok(afterTransfer.players.find((p) => p.userId === newHost.user.id)?.isHost === true);

    // Verify new host actually holds host privileges (can close room!)
    const roomClosedWait = friend.waitFor((p) => p.event === 'room:closed', 'new host closes room');
    newHost.send('room:close');
    await roomClosedWait;
    console.log('   PASS: Host disconnect immediately transferred ownership and privileges to connected player.');

    console.log('6. Testing Scenario 7: Simultaneous joins race condition never exceed 12...');
    const raceHost = await makeClient('RaceHost');
    const raceCreated = raceHost.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'race room created');
    raceHost.send('room:create', { levelId: 2 });
    await raceCreated;
    const raceCode = raceHost.currentRoom!.code;

    const racers: TestClient[] = [];
    for (let i = 1; i <= 20; i++) {
      racers.push(await makeClient(`Racer_${i}`));
    }

    const raceResults = await Promise.all(
      racers.map((r) => r.http('/api/rooms/join', 'POST', { code: raceCode }))
    );

    const successes = raceResults.filter((r) => r.status === 200);
    const failures = raceResults.filter((r) => r.status === 400);
    assert.equal(successes.length, 11, 'Only 11 racers may join a room that already has 1 host');
    assert.equal(failures.length, 9, 'Remaining 9 simultaneous joiners must be rejected');

    const finalRaceMe = await raceHost.http('/api/auth/me');
    const finalRaceRoom = finalRaceMe.data.activeRoom as RoomState;
    assert.equal(finalRaceRoom.players.length, 12, 'Room player count after concurrent burst must be exactly 12');
    console.log('   PASS: 20 simultaneous joins strictly capped at 12/12.');

    console.log('7. Testing Scenario 8: Huge Sector 55 with 12 players spawns wide apart & multi-serpent AI distributes targets...');
    const level55Wait = raceHost.waitFor(
      (p) => p.event === 'room:state' && (p.payload as RoomState | null)?.levelId === 55,
      'set sector 55'
    );
    raceHost.send('room:set_level', { levelId: 55 });
    await level55Wait;

    const hugeStartWait = raceHost.waitFor((p) => p.event === 'game:started', '12-player huge sector start');
    raceHost.send('room:start');
    const hugeStartPkt = await hugeStartWait;
    const hugePayload = hugeStartPkt.payload as {
      levelId: number;
      players: Array<{ userId: string; x: number; y: number; z: number }>;
      monsters: Array<{ id: string; x: number; z: number }>;
    };
    assert.equal(hugePayload.levelId, 55);
    assert.equal(hugePayload.players.length, 12);
    assert.ok(hugePayload.monsters.length >= 3, 'Huge Sector 55 must spawn multiple sea serpents');

    let minPairDist = Infinity;
    for (let i = 0; i < hugePayload.players.length; i++) {
      for (let j = i + 1; j < hugePayload.players.length; j++) {
        const a = hugePayload.players[i];
        const b = hugePayload.players[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < minPairDist) minPairDist = d;
      }
    }
    assert.ok(minPairDist >= 2.2, `12 players on huge start deck must be well spaced (minPairDist=${minPairDist.toFixed(2)})`);

    // Place 2 players in water near serpent 1 and serpent 2 waypoints -> confirm distinct target assignment
    const swimmer1 = raceHost;
    const swimmer2 = racers.find((r) => finalRaceRoom.players.some((p) => p.userId === r.user.id))!;
    const m1 = hugePayload.monsters[0];
    const m2 = hugePayload.monsters[1];
    const sendSwimmerStates = () => {
      swimmer1.send('game:input_state', {
        x: m1.x,
        y: -1.1,
        z: m1.z + 18,
        yaw: 0,
        animState: 'swim',
        horizSpeed: 2,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });
      swimmer2.send('game:input_state', {
        x: m2.x,
        y: -1.1,
        z: m2.z + 18,
        yaw: 0,
        animState: 'swim',
        horizSpeed: 2,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });
    };
    sendSwimmerStates();
    const swimTimer = setInterval(sendSwimmerStates, 45);

    const multiTargetSync = await raceHost.waitFor(
      (p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const targets = new Set(w.monsters.filter((m) => m.alert === 'chasing' && m.targetUserId).map((m) => m.targetUserId));
        return targets.size >= 2;
      },
      'multiple serpents target distinct swimmers'
    );
    clearInterval(swimTimer);
    assert.ok(multiTargetSync);
    console.log(`   PASS: 12 players spawned >= ${minPairDist.toFixed(2)}m apart and ${hugePayload.monsters.length} serpents hunted distinct swimmers.`);

    console.log('9. Testing Real-Time Voice Chat Backend (ICE config, room-scoped WebRTC signaling, voice state & privacy cleanup)...');
    // Unauthenticated ICE config must return 401
    const unauthIceRes = await fetch(`${baseUrl}/api/voice/ice-config`);
    assert.equal(unauthIceRes.status, 401, 'ICE config must require authentication');

    // Authenticated ICE config must return STUN servers
    const authIceRes = await fetch(`${baseUrl}/api/voice/ice-config`, {
      headers: { Authorization: `Bearer ${raceHost.token}` },
    });
    assert.equal(authIceRes.status, 200);
    const iceJson = (await authIceRes.json()) as { iceServers: Array<{ urls: string | string[] }> };
    assert.ok(Array.isArray(iceJson.iceServers) && iceJson.iceServers.length >= 1, 'ICE config must provide STUN servers');

    // Outsider outside the 12-player room cannot receive or inject signals into the room
    const outsider = await makeClient('VoiceOutsider');
    const peerWaitVoice = swimmer2.waitFor(
      (p) =>
        p.event === 'voice:peer_state' &&
        (p.payload as { userId: string; voice: { speaking: boolean; micEnabled: boolean } }).userId === raceHost.user.id &&
        (p.payload as { userId: string; voice: { speaking: boolean; micEnabled: boolean } }).voice.speaking === true,
      'teammate receives speaking voice state'
    );
    raceHost.send('voice:state', {
      voiceActive: true,
      micEnabled: true,
      selfMuted: false,
      speaking: true,
    });
    await peerWaitVoice;

    // Server invariant: micEnabled=false forces speaking=false even if client claims speaking=true
    const mutedInvariantWait = swimmer2.waitFor(
      (p) =>
        p.event === 'voice:peer_state' &&
        (p.payload as { userId: string; voice: { speaking: boolean; micEnabled: boolean } }).userId === raceHost.user.id &&
        (p.payload as { userId: string; voice: { speaking: boolean; micEnabled: boolean } }).voice.micEnabled === false &&
        (p.payload as { userId: string; voice: { speaking: boolean; micEnabled: boolean } }).voice.speaking === false,
      'server enforces speaking=false when mic is off'
    );
    raceHost.send('voice:state', {
      voiceActive: true,
      micEnabled: false,
      selfMuted: false,
      speaking: true,
    });
    await mutedInvariantWait;

    // WebRTC offer signaling relays between authorized peers in the same room
    const signalRelayWait = swimmer2.waitFor(
      (p) =>
        p.event === 'voice:signal' &&
        (p.payload as { fromUserId: string; kind: string }).fromUserId === raceHost.user.id &&
        (p.payload as { kind: string }).kind === 'offer',
      'WebRTC offer relayed inside room'
    );
    raceHost.send('voice:signal', {
      targetUserId: swimmer2.user.id,
      kind: 'offer',
      data: { type: 'offer', sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n' },
    });
    await signalRelayWait;

    // Cross-room signaling attempt from outsider is rejected cleanly
    const outsiderSignalErr = outsider.waitFor(
      (p) => p.event === 'room:error',
      'outsider voice signal rejected'
    );
    outsider.send('voice:signal', {
      targetUserId: raceHost.user.id,
      kind: 'offer',
      data: { type: 'offer', sdp: 'fake' },
    });
    await outsiderSignalErr;

    // Leaving room emits voice:peer_left to teammates
    const peerLeftWait = raceHost.waitFor(
      (p) =>
        p.event === 'voice:peer_left' &&
        (p.payload as { userId: string }).userId === swimmer2.user.id,
      'voice:peer_left emitted when teammate leaves room'
    );
    swimmer2.send('room:leave', {});
    await peerLeftWait;
    console.log('   PASS: Authenticated ICE config, 12-player voice state sync, same-room WebRTC signaling, outsider blocking & peer-left cleanup verified.');

    console.log('10. Testing mid-match WebSocket reconnect delivers auth:ok followed by game:started...');
    const reconnectTarget = racers.find(
      (r) => r.user.id !== swimmer2.user.id && finalRaceRoom.players.some((p) => p.userId === r.user.id)
    )!;
    const prevPacketCount = reconnectTarget.packets.length;
    reconnectTarget.close();
    await new Promise((r) => setTimeout(r, 25));
    const reconnectedStartWait = reconnectTarget.waitFor(
      (p) => p.event === 'game:started',
      'mid-match reconnect receives game:started'
    );
    await reconnectTarget.connectWs();
    await reconnectedStartWait;
    const reconnectSeq = reconnectTarget.packets.slice(prevPacketCount).map((p) => p.event);
    const authOkIdx = reconnectSeq.indexOf('auth:ok');
    const gameStartedIdx = reconnectSeq.indexOf('game:started');
    assert.ok(authOkIdx >= 0, 'Reconnect sequence must include auth:ok');
    assert.ok(gameStartedIdx > authOkIdx, 'game:started must arrive immediately after auth:ok on mid-match reconnect');
    const reconnectGameStarted = reconnectTarget.packets
      .slice(prevPacketCount)
      .find((p) => p.event === 'game:started')!.payload as { elapsedSec?: number };
    assert.equal(typeof reconnectGameStarted.elapsedSec, 'number', 'Reconnect game:started must include elapsedSec');
    assert.ok((reconnectGameStarted.elapsedSec ?? -1) >= 0, 'elapsedSec must be non-negative');
    console.log('   PASS: Mid-match WebSocket reconnect restored auth:ok -> game:started ordering with elapsedSec.');

    console.log('11. Testing Scenario 11: Rotating-platform multiplayer elapsedSec sync & accurate OBB water detection...');
    const rotHost = await makeClient('RotHost');
    const rotGuest = await makeClient('RotGuest');
    const rotRoomCreated = rotHost.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'rot room created');
    rotHost.send('room:create', { levelId: 3 });
    await rotRoomCreated;
    const rotJoinRes = await rotGuest.http('/api/rooms/join', 'POST', { code: rotHost.currentRoom!.code });
    assert.equal(rotJoinRes.status, 200);
    await new Promise((r) => setTimeout(r, 40));

    const rotStartWait = rotHost.waitFor((p) => p.event === 'game:started', 'rot game:started');
    rotHost.send('room:start');
    const rotStartPkt = await rotStartWait;
    assert.equal((rotStartPkt.payload as { elapsedSec?: number }).elapsedSec, 0, 'Initial game:started elapsedSec must be 0');

    // Sector 3 rotating bridge at [-2.37, 0.54, -4.45], size [2.99, 1.16, 6.78], axis 'y', waterY = 0
    // rotHost stands on center of rotating bridge (y = 0.54 + 0.58 = 1.12) -> must be inWater = false
    // rotGuest swims in water right next to the rotating bridge -> must be inWater = true (would falsely be false under old cylinder check!)
    const rotInputTimer = setInterval(() => {
      rotHost.send('game:input_state', {
        x: -2.37,
        y: 1.12,
        z: -4.45,
        yaw: 0,
        animState: 'idle',
        horizSpeed: 0,
        inWater: false,
        checkpointIndex: 0,
        escaped: false,
      });
      rotGuest.send('game:input_state', {
        x: -2.37 + 3.1,
        y: -0.45,
        z: -4.45,
        yaw: 0,
        animState: 'swim',
        horizSpeed: 2,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });
    }, 40);

    const rotWorldSync = await rotHost.waitFor(
      (p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const hState = w.players.find((pl) => pl.userId === rotHost.user.id);
        const gState = w.players.find((pl) => pl.userId === rotGuest.user.id);
        return (
          typeof w.elapsedSec === 'number' &&
          w.elapsedSec > 0 &&
          Boolean(hState && !hState.inWater) &&
          Boolean(gState && gState.inWater)
        );
      },
      'rotating platform OBB water check & elapsedSec broadcast'
    );
    clearInterval(rotInputTimer);
    assert.ok(rotWorldSync);
    console.log('   PASS: Rotating-platform elapsedSec sync and exact OBB water/platform discrimination verified.');

    console.log('12. Testing Scenario 12: Sea serpent initial yaw/depth, obstacle patrol & dynamic emerged transition...');
    const level3Def = LEVELS.find((l) => l.id === 3)!;
    const initMonsters = (rotStartPkt.payload as {
      monsters: Array<{ id: string; x: number; y: number; z: number; yaw: number; emerged: boolean }>;
    }).monsters;
    assert.ok(initMonsters.length >= 1, 'Level 3 must spawn at least one serpent');
    const firstMc = level3Def.monsters[0];
    const expectedYaw = Math.atan2(
      (firstMc.waypoints[1]?.[0] ?? firstMc.waypoints[0][0]) - firstMc.waypoints[0][0],
      (firstMc.waypoints[1]?.[1] ?? firstMc.waypoints[0][1]) - firstMc.waypoints[0][1]
    ) || 0;
    assert.ok(
      Math.abs(initMonsters[0].y - (level3Def.bounds.waterY - 0.14)) < 0.02,
      `Serpent must spawn at calm waterY - 0.14 (got ${initMonsters[0].y})`
    );
    assert.ok(
      Math.abs(initMonsters[0].yaw - expectedYaw) < 0.02,
      `Serpent initial yaw must face waypoint[1] (got ${initMonsters[0].yaw}, expected ${expectedYaw})`
    );
    assert.equal(initMonsters[0].emerged, false);

    // Create a fresh room on Level 1 and place swimmer ~25m laterally from monster[0] in open water
    const sHost = await makeClient('SerpentHost');
    const sGuest = await makeClient('SerpentGuest');
    const sCreated = sHost.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'serpent room created');
    sHost.send('room:create', { levelId: 1 });
    await sCreated;
    const sJoinRes = await sGuest.http('/api/rooms/join', 'POST', { code: sHost.currentRoom!.code });
    assert.equal(sJoinRes.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    const sStartWait = sHost.waitFor((p) => p.event === 'game:started', 'serpent game:started');
    sHost.send('room:start');
    const sStartPkt = await sStartWait;
    const level1Def = LEVELS.find((l) => l.id === 1)!;
    const sInitM = (sStartPkt.payload as { monsters: Array<{ x: number; z: number }> }).monsters[0];
    const farX = sInitM.x > 0 ? level1Def.bounds.minX + 4 : level1Def.bounds.maxX - 4;
    const farZ = sInitM.z;

    let sawUnemergedChase = false;
    let sawEmergedChase = false;
    const sInputTimer = setInterval(() => {
      sHost.send('game:input_state', {
        x: level1Def.spawn[0],
        y: level1Def.spawn[1],
        z: level1Def.spawn[2],
        yaw: Math.PI,
        animState: 'idle',
        horizSpeed: 0,
        inWater: false,
        checkpointIndex: 0,
        escaped: false,
      });
      sGuest.send('game:input_state', {
        x: farX,
        y: level1Def.bounds.waterY - 0.5,
        z: farZ,
        yaw: 0,
        animState: 'swim',
        horizSpeed: 2,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });
    }, 35);

    await sHost.waitFor(
      (p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const m = w.monsters[0];
        assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z), 'Monster coords finite');
        assert.ok(
          m.x >= level1Def.bounds.minX && m.x <= level1Def.bounds.maxX &&
          m.z >= level1Def.bounds.minZ && m.z <= level1Def.bounds.maxZ,
          'Monster stays inside arena bounds'
        );
        if (m.alert === 'chasing' && !m.emerged) sawUnemergedChase = true;
        if (m.alert === 'chasing' && m.emerged) sawEmergedChase = true;
        return sawUnemergedChase && sawEmergedChase;
      },
      'serpent starts chase un-emerged at long distance then emerges < 10.5m'
    );
    clearInterval(sInputTimer);
    assert.ok(sawUnemergedChase, 'Serpent should begin long-range chase un-emerged');
    assert.ok(sawEmergedChase, 'Serpent should dynamically emerge once within 10.5m');
    console.log('   PASS: Sea serpent spawn yaw/depth, bounds safety & dynamic emerged transition verified.');

    console.log('13. Testing Scenario 13: Push targeting physics (self, distance, facing cone, wall & platform obstruction)...');
    const wallTestDef = LEVELS.find((l) => l.id === 1)!;
    // Cannot push self
    assert.equal(
      selectPushTarget(wallTestDef, { userId: 'a', x: 0, y: 1.2, z: 0, yaw: 0 }, [{ userId: 'a', x: 0, y: 1.2, z: 1.0 }], 0),
      null,
      'Player must never be able to push self'
    );
    // Out-of-range rejected (> 2.6m)
    assert.equal(
      selectPushTarget(wallTestDef, { userId: 'a', x: 0, y: 1.2, z: 0, yaw: 0 }, [{ userId: 'b', x: 0, y: 1.2, z: 3.1 }], 0),
      null,
      'Out-of-range target must be rejected'
    );
    // Target behind attacker rejected (facing +Z with yaw=0, target at -Z)
    assert.equal(
      selectPushTarget(wallTestDef, { userId: 'a', x: 0, y: 1.2, z: 0, yaw: 0 }, [{ userId: 'b', x: 0, y: 1.2, z: -1.5 }], 0),
      null,
      'Target behind attacker must be rejected'
    );
    // Valid target in front on open deck
    const [sx, sy, sz] = wallTestDef.spawn;
    const validSel = selectPushTarget(
      wallTestDef,
      { userId: 'a', x: sx, y: sy, z: sz, yaw: Math.PI },
      [{ userId: 'b', x: sx + 0.2, y: sy, z: sz - 1.4 }],
      0
    );
    assert.ok(validSel, 'Valid nearby teammate in front must be selectable');
    assert.equal(validSel.userId, 'b');
    assert.ok(validSel.dirZ < -0.7, `Push direction should point toward -Z (got dirZ=${validSel.dirZ})`);

    // Wall / platform obstruction between two positions
    const firstWall = wallTestDef.walls[0];
    if (firstWall) {
      const [wx, wy, wz] = firstWall.position;
      const [ww, , wd] = firstWall.size;
      const blocked = isPushPathObstructed(
        wallTestDef,
        wx,
        wy - 0.5,
        wz - wd * 0.5 - 0.5,
        wx,
        wy - 0.5,
        wz + wd * 0.5 + 0.5,
        0
      );
      assert.equal(blocked || ww <= 0, true, 'Push path through solid wall must be obstructed');
    }
    console.log('   PASS: Push physics rules (self, distance, facing cone, obstruction) verified.');

    console.log('14. Testing Scenario 14: Authoritative Friends-Mode Push sync, cooldown, recovery immunity & eligibility...');
    const pHost = await makeClient('PushHost');
    const pFriend = await makeClient('PushFriend');
    const pHelper = await makeClient('PushHelper');
    const pCreated = pHost.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'push room created');
    pHost.send('room:create', { levelId: 3 });
    await pCreated;
    assert.equal((await pFriend.http('/api/rooms/join', 'POST', { code: pHost.currentRoom!.code })).status, 200);
    assert.equal((await pHelper.http('/api/rooms/join', 'POST', { code: pHost.currentRoom!.code })).status, 200);
    await new Promise((r) => setTimeout(r, 40));

    const pStarted = pHost.waitFor((p) => p.event === 'game:started', 'push match started');
    pHost.send('room:start');
    await pStarted;

    // Place all 3 players on Sector 3 rotating bridge at [-2.37, 1.12, -4.45]
    pHost.send('game:input_state', {
      x: -2.37,
      y: 1.12,
      z: -3.8,
      yaw: Math.PI, // facing -Z toward pFriend
      animState: 'idle',
      horizSpeed: 0,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    });
    pFriend.send('game:input_state', {
      x: -2.37,
      y: 1.12,
      z: -5.1,
      yaw: 0,
      animState: 'idle',
      horizSpeed: 0,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    });
    pHelper.send('game:input_state', {
      x: -1.9,
      y: 1.12,
      z: -3.9,
      yaw: Math.PI,
      animState: 'idle',
      horizSpeed: 0,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    });
    await new Promise((r) => setTimeout(r, 60));

    // Host pushes Friend -> all 3 clients must receive the exact pushed event
    const hostPushEv = pHost.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed',
      'host receives pushed event'
    );
    const friendPushEv = pFriend.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed',
      'target receives pushed event'
    );
    const helperPushEv = pHelper.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed',
      'spectating friend receives pushed event'
    );
    pHost.send('game:push', { yaw: Math.PI, x: -2.37, y: 1.12, z: -3.8 });
    const [evH, evF, evHl] = await Promise.all([hostPushEv, friendPushEv, helperPushEv]);
    const pushPayload = evF.payload as GamePlayerEvent;
    assert.equal(pushPayload.userId, pFriend.user.id);
    assert.equal(pushPayload.attackerUserId, pHost.user.id);
    assert.equal(pushPayload.force, PUSH_FORCE_HORIZ);
    assert.equal(pushPayload.liftY, PUSH_FORCE_LIFT_Y);
    assert.ok((pushPayload.dirZ ?? 0) < -0.7, 'Push event dirZ should send target toward -Z');
    assert.deepEqual(evH.payload, evF.payload);
    assert.deepEqual(evHl.payload, evF.payload);

    // Spam guard: immediate second push from pHost must be ignored by cooldown, and pHelper cannot instant chain-push pFriend during recovery immunity
    const prevFriendPushCount = pFriend.packets.filter(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed'
    ).length;
    pHost.send('game:push', { yaw: Math.PI, x: -2.37, y: 1.12, z: -3.8 });
    pHelper.send('game:push', { yaw: Math.PI, x: -1.9, y: 1.12, z: -3.9 });
    await new Promise((r) => setTimeout(r, 90));
    const afterSpamCount = pFriend.packets.filter(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed'
    ).length;
    assert.equal(afterSpamCount, prevFriendPushCount, 'Cooldown & recovery immunity must block rapid / chained pushes');

    // Escaped player cannot be pushed once recovery expires
    const level3 = LEVELS.find((l) => l.id === 3)!;
    await new Promise((r) => setTimeout(r, Math.max(PUSH_COOLDOWN_MS, PUSH_RECOVERY_MS) + 60));
    const escapedEvWait = pHost.waitFor(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'escaped',
      'friend escaped'
    );
    pFriend.send('game:input_state', {
      x: level3.exit.position[0],
      y: level3.exit.position[1],
      z: level3.exit.position[2],
      yaw: 0,
      animState: 'idle',
      horizSpeed: 0,
      inWater: false,
      checkpointIndex: 0,
      escaped: true,
    });
    await escapedEvWait;
    pHost.send('game:input_state', {
      x: level3.exit.position[0],
      y: level3.exit.position[1],
      z: level3.exit.position[2] + 1.0,
      yaw: Math.PI,
      animState: 'idle',
      horizSpeed: 0,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    });
    await new Promise((r) => setTimeout(r, 40));
    pHost.send('game:push', {
      yaw: Math.PI,
      x: level3.exit.position[0],
      y: level3.exit.position[1],
      z: level3.exit.position[2] + 1.0,
    });
    await new Promise((r) => setTimeout(r, 80));
    const afterEscapedPushCount = pFriend.packets.filter(
      (p) => p.event === 'game:player_event' && (p.payload as GamePlayerEvent).kind === 'pushed'
    ).length;
    assert.equal(afterEscapedPushCount, prevFriendPushCount, 'Escaped players must not be pushable');
    console.log('   PASS: Authoritative Friends-Mode Push sync, cooldown, recovery immunity & escaped exclusion verified.');

    console.log('15. Testing Scenario 15: Spin-free sea serpent waypoint navigation (Friends Mode & Level 1 pockets)...');
    {
      const {
        resolvePatrolTarget,
        computeSerpentSteerAngle,
        updateSerpentProgressAndYaw,
        shortestAngleDiffNav,
      } = await import('../src/game/serpentNav.ts');
      const { LevelSpatialGrid } = await import('../src/game/spatialGrid.ts');

      // Edge case A: zero-length direction vector must damp drift & keep yaw steady without spinning
      const navZero = {
        x: 5,
        z: -20,
        yaw: 1.23,
        velX: 0.1,
        velZ: -0.1,
        wpIndex: 0,
        waypoints: [[5, -20]] as [number, number][],
        avoidDir: 1 as const,
        avoidTimer: 0,
        stuckTimer: 0,
        navBestDist: Infinity,
        navStallTimer: 0,
        navAnchorX: 5,
        navAnchorZ: -20,
        navAnchorTimer: 0,
        navTurnAccum: 0,
      };
      const tgtZero = resolvePatrolTarget(navZero, 0.88, () => false);
      assert.equal(tgtZero.hasTarget, false);
      const steerZero = computeSerpentSteerAngle(navZero, tgtZero.tx, tgtZero.tz, 0.88, false, () => false);
      assert.equal(steerZero.valid, false);
      for (let k = 0; k < 30; k++) {
        updateSerpentProgressAndYaw(navZero, navZero.x, navZero.z, navZero.yaw, 3.1, 1 / 30, false, false, () => false);
      }
      assert.equal(navZero.yaw, 1.23, 'Zero-length target must preserve yaw without spinning');

      // Edge case B: already-reached & blocked nearby waypoints skip cleanly to next valid waypoint
      const navSkip = {
        x: 0,
        z: 0,
        yaw: 0,
        velX: 0,
        velZ: 0,
        wpIndex: 0,
        waypoints: [
          [0.2, 0.2],
          [1.0, -0.5],
          [4, -3],
          [30, -30],
        ] as [number, number][],
        avoidDir: 1 as const,
        avoidTimer: 0,
        stuckTimer: 0,
        navBestDist: Infinity,
        navStallTimer: 0,
        navAnchorX: 0,
        navAnchorZ: 0,
        navAnchorTimer: 0,
        navTurnAccum: 0,
      };
      const tgtSkip = resolvePatrolTarget(navSkip, 0.88, (x, z) => Math.hypot(x - 4, z + 3) < 1.5);
      assert.equal(navSkip.wpIndex, 3);
      assert.equal(tgtSkip.hasTarget, true);

      // Edge case C: Exact Level 1 m2 bug pocket (s1_m1_p2 between [-20.48,-64] and [15.36,-66.56])
      const lv1 = LEVELS.find((l) => l.id === 1)!;
      const lv1Grid = new LevelSpatialGrid(lv1);
      const lv1M2 = lv1.monsters[1];
      const m2Scale = lv1M2.scale || 1;
      const sp: number[] = [];
      const sw: number[] = [];
      const blockedLv1 = (x: number, z: number, rad: number) => {
        const b = lv1.bounds;
        if (x - rad < b.minX || x + rad > b.maxX || z - rad < b.minZ || z + rad > b.maxZ) return true;
        const rSq = rad * rad;
        lv1Grid.queryRadius(x, z, rad + 0.5, sp, sw);
        for (const pi of sp) {
          const p = lv1.platforms[pi];
          const [px, py, pz] = p.position;
          const [pw, ph, pd] = p.size;
          if (b.waterY + 4.2 * m2Scale <= py - ph * 0.5 + 0.05 || b.waterY - 1.5 >= py + ph * 0.5 - 0.05) continue;
          const dx = x - Math.max(px - pw * 0.5, Math.min(x, px + pw * 0.5));
          const dz = z - Math.max(pz - pd * 0.5, Math.min(z, pz + pd * 0.5));
          if (dx * dx + dz * dz < rSq) return true;
        }
        return false;
      };
      const navM2 = {
        x: lv1M2.waypoints[0][0],
        z: lv1M2.waypoints[0][1],
        yaw: Math.atan2(lv1M2.waypoints[1][0] - lv1M2.waypoints[0][0], lv1M2.waypoints[1][1] - lv1M2.waypoints[0][1]),
        velX: 0,
        velZ: 0,
        wpIndex: 1,
        waypoints: lv1M2.waypoints,
        avoidDir: -1 as const,
        avoidTimer: 0,
        stuckTimer: 0,
        navBestDist: Infinity,
        navStallTimer: 0,
        navAnchorX: lv1M2.waypoints[0][0],
        navAnchorZ: lv1M2.waypoints[0][1],
        navAnchorTimer: 0,
        navTurnAccum: 0,
      };
      let reachedWp2 = false;
      let maxM2YawRate = 0;
      let wYaw = 0;
      let wT = 0;
      const dtSim = 1 / 30;
      for (let s = 0; s < 30 * 30; s++) {
        const tgt = resolvePatrolTarget(navM2, 0.88 * m2Scale, blockedLv1);
        if (navM2.wpIndex >= 2) reachedWp2 = true;
        const prevY = navM2.yaw;
        const st = tgt.hasTarget
          ? computeSerpentSteerAngle(navM2, tgt.tx, tgt.tz, 0.88 * m2Scale, false, blockedLv1)
          : { valid: false, steerAngle: navM2.yaw };
        if (st.valid) {
          const blend = Math.min(1, 8.5 * dtSim);
          navM2.velX += (Math.sin(st.steerAngle) * lv1M2.patrolSpeed - navM2.velX) * blend;
          navM2.velZ += (Math.cos(st.steerAngle) * lv1M2.patrolSpeed - navM2.velZ) * blend;
        }
        const px = navM2.x;
        const pz = navM2.z;
        navM2.x += navM2.velX * dtSim;
        navM2.z += navM2.velZ * dtSim;
        updateSerpentProgressAndYaw(navM2, px, pz, prevY, lv1M2.patrolSpeed, dtSim, false, st.valid, blockedLv1);
        wYaw += Math.abs(shortestAngleDiffNav(prevY, navM2.yaw));
        wT += dtSim;
        if (wT >= 2.0) {
          maxM2YawRate = Math.max(maxM2YawRate, wYaw / wT);
          wYaw = 0;
          wT = 0;
        }
      }
      assert.ok(reachedWp2, 'Lv1 m2 must navigate cleanly past s1_m1_p2 to subsequent waypoints');
      assert.ok(maxM2YawRate < 2.8, `Lv1 m2 must not spin (maxYawRate=${maxM2YawRate.toFixed(2)})`);

      // Live Friends-Mode server patrol check on Level 1
      const navHost = await makeClient('NavHost');
      const navGuest = await makeClient('NavGuest');
      const navCreated = navHost.waitFor((p) => p.event === 'room:state' && p.payload !== null, 'nav room created');
      navHost.send('room:create', { levelId: 1 });
      await navCreated;
      const navJoin = await navGuest.http('/api/rooms/join', 'POST', { code: navHost.currentRoom!.code });
      assert.equal(navJoin.status, 200);
      await new Promise((r) => setTimeout(r, 30));
      const navStart = navHost.waitFor((p) => p.event === 'game:started', 'nav game:started');
      navHost.send('room:start');
      await navStart;

      let prevServerYaw: number | null = null;
      let serverMaxDelta = 0;
      let serverTicks = 0;
      let m2MovedDist = 0;
      let m2StartPos: [number, number] | null = null;
      await navHost.waitFor((p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const m2 = w.monsters[1];
        if (!m2StartPos) m2StartPos = [m2.x, m2.z];
        m2MovedDist = Math.hypot(m2.x - m2StartPos[0], m2.z - m2StartPos[1]);
        if (prevServerYaw !== null) {
          const d = Math.abs(shortestAngleDiffNav(prevServerYaw, m2.yaw));
          if (d > serverMaxDelta) serverMaxDelta = d;
        }
        prevServerYaw = m2.yaw;
        serverTicks++;
        return serverTicks >= 12;
      }, 'server serpent patrol ticks');
      assert.ok(m2MovedDist > 1.0, `Friends-mode serpent m2 must swim smoothly (moved ${m2MovedDist.toFixed(2)}m)`);
      assert.ok(serverMaxDelta < 0.8, `Friends-mode serpent yaw must change smoothly (maxStep=${serverMaxDelta.toFixed(2)})`);

      // Verify characterId ('female') syncs through authoritative server WorldSyncPayload
      const guestSpawn = navGuest.currentRoom!.players.find((p) => p.userId === navGuest.user.id);
      assert.ok(guestSpawn);
      navGuest.send('game:input_state', {
        x: 0,
        y: 1.2,
        z: 3,
        yaw: Math.PI,
        animState: 'idle',
        horizSpeed: 0,
        inWater: false,
        checkpointIndex: 0,
        escaped: false,
        characterId: 'female',
      });
      await navHost.waitFor((p) => {
        if (p.event !== 'game:world') return false;
        const w = p.payload as WorldSyncPayload;
        const g = w.players.find((pl) => pl.userId === navGuest.user.id);
        return g?.characterId === 'female';
      }, 'guest female characterId synced in world snapshot');
      console.log('   PASS: Spin-free serpent patrol, zero-length yaw hold, blocked waypoint skip, character sync & Friends-Mode sync verified.');
    }

    console.log('16. Testing Scenario 16: Lazy level catalog equivalence & swept spatial grid coverage...');
    {
      const { LevelSpatialGrid } = await import('../src/game/spatialGrid.ts');
      assert.equal(TOTAL_LEVELS, 100);
      assert.equal(isValidLevelId(1), true);
      assert.equal(isValidLevelId(100), true);
      assert.equal(isValidLevelId(0), false);
      assert.equal(isValidLevelId(101), false);

      for (let id = 1; id <= TOTAL_LEVELS; id++) {
        const sum = getLevelSummary(id);
        const full = getLevelById(id);
        assert.ok(sum, `getLevelSummary(${id}) must exist`);
        assert.ok(full, `getLevelById(${id}) must exist`);
        assert.equal(sum.id, full.id);
        assert.equal(sum.code, full.code);
        assert.equal(sum.name, full.name);
        assert.equal(sum.subtitle, full.subtitle);
        assert.equal(sum.difficulty, full.difficulty);
        assert.equal(sum.timeLimit, full.timeLimit);
        assert.deepEqual(sum.parTimes, full.parTimes);
      }

      // Synthetic level covering static, moving, Y-rotating, and X/Z/XY/ZY tilted rotating platforms
      const synthDef = {
        bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60, floorY: -4, waterY: 0, ceilingY: 14 },
        platforms: [
          { id: 'static_p', kind: 'static' as const, position: [-40, 1, -40] as [number, number, number], size: [4, 1, 4] as [number, number, number] },
          { id: 'moving_p', kind: 'moving' as const, position: [0, 1, 0] as [number, number, number], size: [4, 1, 4] as [number, number, number], moveOffset: [22, 0, -18] as [number, number, number], moveSpeed: 1 },
          { id: 'rot_y', kind: 'static' as const, position: [25, 1, 25] as [number, number, number], size: [12, 1, 2] as [number, number, number], rotationSpeed: 0.9, rotationAxis: 'y' as const },
          { id: 'rot_x', kind: 'static' as const, position: [-25, 2, 25] as [number, number, number], size: [2, 10, 2] as [number, number, number], rotationSpeed: 0.8, rotationAxis: 'x' as const },
          { id: 'rot_z', kind: 'static' as const, position: [-25, 2, -5] as [number, number, number], size: [10, 6, 2] as [number, number, number], rotationSpeed: 0.8, rotationAxis: 'z' as const },
          { id: 'rot_xy', kind: 'static' as const, position: [35, 2, -25] as [number, number, number], size: [8, 8, 2] as [number, number, number], rotationSpeed: 0.7, rotationAxis: 'xy' as const },
          { id: 'rot_zy', kind: 'static' as const, position: [0, 2, -45] as [number, number, number], size: [2, 8, 8] as [number, number, number], rotationSpeed: 0.7, rotationAxis: 'zy' as const },
        ],
        walls: [],
      };
      const grid = new LevelSpatialGrid(synthDef, 12);
      assert.equal(grid.dynamicPlatIndices.length, 0, 'All platforms must be indexed in swept spatial buckets');

      const foundPlats: number[] = [];
      // Moving platform start & end offset corners
      grid.queryBox(-1.5, 1.5, -1.5, 1.5, foundPlats, null);
      assert.ok(foundPlats.includes(1), 'Moving platform must be found at origin');
      grid.queryBox(21, 23, -19, -17, foundPlats, null);
      assert.ok(foundPlats.includes(1), 'Moving platform must be found at end of moveOffset');

      // Y-rotating long beam rotated 90 degrees (reaches Z = 25 +- 6)
      grid.queryBox(24.5, 25.5, 30.2, 31.0, foundPlats, null);
      assert.ok(foundPlats.includes(2), 'Y-rotating platform must be found across rotated sweep radius');

      // Tilted X/Z/XY/ZY platforms across their swept bounding spheres
      grid.queryBox(-25.5, -24.5, 29.5, 30.1, foundPlats, null);
      assert.ok(foundPlats.includes(3), 'X-tilted platform must be found across 3D sweep');
      grid.queryBox(-30.5, -29.8, -5.5, -4.5, foundPlats, null);
      assert.ok(foundPlats.includes(4), 'Z-tilted platform must be found across 3D sweep');
      grid.queryBox(39.8, 40.5, -25.5, -24.5, foundPlats, null);
      assert.ok(foundPlats.includes(5), 'XY-tilted platform must be found across 3D sweep');
      grid.queryBox(4.8, 5.5, -45.5, -44.5, foundPlats, null);
      assert.ok(foundPlats.includes(6), 'ZY-tilted platform must be found across 3D sweep');
      console.log('   PASS: All 100 level summaries match full definitions & swept spatial grid covers all moving/rotating envelopes.');
    }

    console.log('\nALL 16 MULTIPLAYER, SERPENT NAVIGATION, PUSH, OPTIMIZATION & VOICE CHAT SCENARIOS PASSED!');
  } finally {
    for (const c of clients) {
      c.close();
    }
    await srv.close();
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});

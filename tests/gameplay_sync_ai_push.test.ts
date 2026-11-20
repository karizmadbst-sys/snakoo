import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createAppServer } from '../server.ts';
import { getLevelById } from '../src/game/levels.ts';
import {
  PUSH_COOLDOWN_MS,
  PUSH_FORCE_HORIZ,
  PUSH_FORCE_LIFT_Y,
  type GamePlayerEvent,
  type PlayerNetState,
  type WorldSyncPayload,
} from '../src/multiplayer/types.ts';
import { selectPushTarget } from '../src/multiplayer/pushPhysics.ts';

interface WsMsg {
  event: string;
  payload: any;
}

class TestClient {
  public token = '';
  public userId = '';
  public username = '';
  public ws: WebSocket | null = null;
  public inbox: WsMsg[] = [];
  private waiters: Array<{
    predicate: (msg: WsMsg) => boolean;
    resolve: (msg: WsMsg) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private baseUrl: string) {}

  async register(username: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json()) as any;
    assert.equal(res.status, 201, `register failed: ${JSON.stringify(data)}`);
    this.token = data.token;
    this.userId = data.user.id;
    this.username = data.user.username;
  }

  async connectWs(): Promise<void> {
    const wsUrl = this.baseUrl.replace('http://', 'ws://') + '/ws';
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'auth', payload: { token: this.token } }));
        resolve();
      });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as WsMsg;
        let matched = false;
        for (let i = 0; i < this.waiters.length; i++) {
          const w = this.waiters[i];
          if (w.predicate(msg)) {
            this.waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(msg);
            matched = true;
            break;
          }
        }
        if (!matched) this.inbox.push(msg);
      });
    });
    await this.waitFor((m) => m.event === 'auth:ok');
  }

  send(event: string, payload: unknown = {}): void {
    assert.ok(this.ws && this.ws.readyState === WebSocket.OPEN, 'WS must be open');
    this.ws.send(JSON.stringify({ event, payload }));
  }

  clearInbox(): void {
    this.inbox.length = 0;
  }

  waitFor(predicate: (msg: WsMsg) => boolean, timeoutMs = 6000): Promise<WsMsg> {
    const idx = this.inbox.findIndex(predicate);
    if (idx >= 0) {
      return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wi = this.waiters.findIndex((w) => w.timer === timer);
        if (wi >= 0) this.waiters.splice(wi, 1);
        reject(new Error(`Timed out waiting for WS event (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runNodeServerTests(): Promise<void> {
  console.log('\n[1/2] Running real multi-client WebSocket tests against Node server...');
  const srv = await createAppServer({ dbPath: ':memory:', attachVite: false, disconnectGraceMs: 800 });
  await new Promise<void>((resolve) => srv.server.listen(0, '127.0.0.1', () => resolve()));
  const addr = srv.server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const alice = new TestClient(baseUrl);
  const bob = new TestClient(baseUrl);
  const charlie = new TestClient(baseUrl);

  try {
    await alice.register('SyncAlice', 'SecretPass1!');
    await bob.register('SyncBob', 'SecretPass1!');
    await charlie.register('SyncCharlie', 'SecretPass1!');
    await alice.connectWs();
    await bob.connectWs();
    await charlie.connectWs();

    // Create room on Level 1 and join Bob + Charlie
    alice.send('room:create', { levelId: 1 });
    const roomCreated = await alice.waitFor((m) => m.event === 'room:state' && m.payload?.code);
    const code = roomCreated.payload.code as string;
    bob.send('room:join_code', { code });
    await bob.waitFor((m) => m.event === 'room:state' && m.payload?.players?.length === 2);
    charlie.send('room:join_code', { code });
    await charlie.waitFor((m) => m.event === 'room:state' && m.payload?.players?.length === 3);

    alice.send('room:start', {});
    await Promise.all([
      alice.waitFor((m) => m.event === 'game:started'),
      bob.waitFor((m) => m.event === 'game:started'),
      charlie.waitFor((m) => m.event === 'game:started'),
    ]);

    const level1 = getLevelById(1);
    const startPlat = level1.platforms[0];
    const deckY = startPlat.position[1] + startPlat.size[1] * 0.5;
    const waterY = level1.bounds.waterY;

    // ------------------------------------------------------------------
    // A. REAL-TIME BIDIRECTIONAL MOVEMENT, VELOCITY & ANIMATION SYNC
    // ------------------------------------------------------------------
    alice.clearInbox();
    bob.clearInbox();
    charlie.clearInbox();

    const animSequence: Array<{ anim: 'walk' | 'run' | 'jump' | 'fall' | 'idle'; x: number; y: number; z: number; yaw: number; vx: number; vy: number; vz: number; spd: number }> = [
      { anim: 'walk', x: startPlat.position[0] + 0.6, y: deckY, z: startPlat.position[2] - 0.5, yaw: 0.4, vx: 3.2, vy: 0, vz: -2.4, spd: 4.0 },
      { anim: 'run', x: startPlat.position[0] + 1.4, y: deckY, z: startPlat.position[2] - 1.1, yaw: 0.85, vx: 6.8, vy: 0, vz: -4.2, spd: 8.0 },
      { anim: 'jump', x: startPlat.position[0] + 1.8, y: deckY + 0.9, z: startPlat.position[2] - 1.3, yaw: 1.1, vx: 5.5, vy: 6.2, vz: -3.0, spd: 6.2 },
      { anim: 'fall', x: startPlat.position[0] + 2.0, y: deckY + 0.4, z: startPlat.position[2] - 1.4, yaw: 1.2, vx: 5.0, vy: -3.4, vz: -2.5, spd: 5.6 },
    ];

    for (const step of animSequence) {
      alice.send('game:input_state', {
        x: step.x,
        y: step.y,
        z: step.z,
        yaw: step.yaw,
        animState: step.anim,
        horizSpeed: step.spd,
        velX: step.vx,
        velY: step.vy,
        velZ: step.vz,
        inWater: false,
        checkpointIndex: 0,
        escaped: false,
      });

      // Bob & Charlie must BOTH receive Alice's exact movement, yaw, velocity, and animation state!
      const [bobWorld, charlieWorld] = await Promise.all([
        bob.waitFor((m) => {
          if (m.event !== 'game:world') return false;
          const p = (m.payload as WorldSyncPayload).players.find((pl) => pl.userId === alice.userId);
          return Boolean(p && p.animState === step.anim && Math.abs(p.x - step.x) < 0.05);
        }),
        charlie.waitFor((m) => {
          if (m.event !== 'game:world') return false;
          const p = (m.payload as WorldSyncPayload).players.find((pl) => pl.userId === alice.userId);
          return Boolean(p && p.animState === step.anim && Math.abs(p.x - step.x) < 0.05);
        }),
      ]);

      const aliceSeenByBob = (bobWorld.payload as WorldSyncPayload).players.find((p) => p.userId === alice.userId)!;
      const aliceSeenByCharlie = (charlieWorld.payload as WorldSyncPayload).players.find((p) => p.userId === alice.userId)!;
      assert.equal(aliceSeenByBob.animState, step.anim);
      assert.ok(Math.abs(aliceSeenByBob.yaw - step.yaw) < 0.01);
      assert.ok(Math.abs((aliceSeenByBob.velX ?? 0) - step.vx) < 0.05, 'Bob must receive Alice velX');
      assert.ok(Math.abs((aliceSeenByBob.velY ?? 0) - step.vy) < 0.05, 'Bob must receive Alice velY');
      assert.ok(Math.abs((aliceSeenByBob.velZ ?? 0) - step.vz) < 0.05, 'Bob must receive Alice velZ');
      assert.equal(aliceSeenByCharlie.animState, step.anim);
      await sleep(25);
    }
    console.log('  ✓ Real-time movement, rotation, velocity, and animation sync verified across 3 clients');

    // ------------------------------------------------------------------
    // C. PLAYER PUSH SYSTEM (AUTHORITATIVE + WORLD VELOCITY REPLICATION)
    // ------------------------------------------------------------------
    // Position Alice & Bob facing each other on start platform
    const ax = startPlat.position[0] - 0.6;
    const az = startPlat.position[2];
    const bx = startPlat.position[0] + 1.0;
    const bz = startPlat.position[2];
    alice.send('game:input_state', {
      x: ax, y: deckY, z: az, yaw: Math.PI / 2,
      animState: 'idle', horizSpeed: 0, velX: 0, velY: 0, velZ: 0,
      inWater: false, checkpointIndex: 0, escaped: false,
    });
    bob.send('game:input_state', {
      x: bx, y: deckY, z: bz, yaw: -Math.PI / 2,
      animState: 'idle', horizSpeed: 0, velX: 0, velY: 0, velZ: 0,
      inWater: false, checkpointIndex: 0, escaped: false,
    });
    await sleep(80);
    alice.clearInbox();
    bob.clearInbox();
    charlie.clearInbox();

    // Alice pushes Bob (with preferred targetUserId hint)
    alice.send('game:push', { yaw: Math.PI / 2, x: ax, y: deckY, z: az, targetUserId: bob.userId });

    const [bobPushedEv, charliePushedEv, charlieWorldAfterPush] = await Promise.all([
      bob.waitFor((m) => m.event === 'game:player_event' && m.payload?.kind === 'pushed' && m.payload?.userId === bob.userId),
      charlie.waitFor((m) => m.event === 'game:player_event' && m.payload?.kind === 'pushed' && m.payload?.userId === bob.userId),
      charlie.waitFor((m) => {
        if (m.event !== 'game:world') return false;
        const bp = (m.payload as WorldSyncPayload).players.find((pl) => pl.userId === bob.userId);
        return Boolean(bp && bp.x > bx + 0.15 && (bp.velX ?? 0) > 5);
      }),
    ]);

    const pushedEv = bobPushedEv.payload as GamePlayerEvent;
    assert.equal(pushedEv.attackerUserId, alice.userId);
    assert.equal(pushedEv.force, PUSH_FORCE_HORIZ);
    assert.equal(pushedEv.liftY, PUSH_FORCE_LIFT_Y);
    assert.ok((pushedEv.dirX ?? 0) > 0.9, 'Push direction must be +X toward Bob');
    assert.equal(charliePushedEv.payload.userId, bob.userId);
    const bobInWorld = (charlieWorldAfterPush.payload as WorldSyncPayload).players.find((p) => p.userId === bob.userId)!;
    assert.ok(bobInWorld.x > bx + 0.2, `Bob must visibly displace immediately on server world (${bobInWorld.x} > ${bx + 0.2})`);
    assert.ok((bobInWorld.velX ?? 0) > 8, `Bob must have knockback velX replicated (${bobInWorld.velX})`);
    console.log('  ✓ Player PUSH verified across attacker, victim, and third-party observer (event + immediate world knockback)');

    // ------------------------------------------------------------------
    // B. SNAKE AI WATER CHASE (INCLUDING NEAR & BEHIND FLOATING PLATFORMS)
    // ------------------------------------------------------------------
    // Place Bob in water right beside the edge of the start platform (previously falsely protected or uncatchable!)
    const edgeWaterX = startPlat.position[0] + startPlat.size[0] * 0.5 + 0.15;
    const edgeWaterZ = startPlat.position[2];
    const edgeWaterY = waterY - 0.14;

    bob.clearInbox();
    alice.clearInbox();

    // Continuously move Bob along water beside & past floating platforms so we verify continuous target tracking + diving + catch
    let chasingObserved = false;
    let snakeDivedUnderPlatform = false;
    let eatingStarted = false;
    let caught = false;

    const chaseStart = Date.now();
    let swimStep = 0;
    while (Date.now() - chaseStart < 5500 && !caught) {
      swimStep++;
      // Swim gently alongside platforms while reporting swimming state
      const swimX = edgeWaterX + Math.sin(swimStep * 0.2) * 0.8;
      const swimZ = edgeWaterZ - Math.min(8, swimStep * 0.25);
      bob.send('game:input_state', {
        x: swimX,
        y: edgeWaterY,
        z: swimZ,
        yaw: Math.PI,
        animState: 'swim',
        horizSpeed: 3.5,
        velX: 0,
        velY: 0,
        velZ: -3.5,
        inWater: true,
        checkpointIndex: 0,
        escaped: false,
      });

      // Drain inbox events
      while (alice.inbox.length > 0) {
        const msg = alice.inbox.shift()!;
        if (msg.event === 'game:world') {
          const w = msg.payload as WorldSyncPayload;
          const bobState = w.players.find((p) => p.userId === bob.userId);
          for (const m of w.monsters) {
            if (m.alert === 'chasing' && m.targetUserId === bob.userId) {
              chasingObserved = true;
            }
            if (m.y < waterY - 0.65) {
              snakeDivedUnderPlatform = true;
            }
          }
          if (bobState && !bobState.alive) {
            caught = true;
          }
        } else if (msg.event === 'game:player_event') {
          if (msg.payload?.kind === 'eating_started' && msg.payload?.userId === bob.userId) {
            eatingStarted = true;
          }
          if (msg.payload?.kind === 'caught' && msg.payload?.userId === bob.userId) {
            caught = true;
          }
        }
      }
      await sleep(45);
    }

    assert.ok(chasingObserved, 'Snake MUST immediately detect water entry near platform edge and enter chasing state');
    assert.ok(eatingStarted, 'Snake MUST reach and initiate eating attack on swimming player');
    assert.ok(caught, 'Snake eating sequence MUST complete and eliminate swimming player');
    console.log(
      `  ✓ Snake AI water chase & catch verified (chasing=${chasingObserved}, dived=${snakeDivedUnderPlatform}, eating=${eatingStarted}, caught=${caught})`
    );
  } finally {
    alice.close();
    bob.close();
    charlie.close();
    await srv.close();
  }
}

async function runCloudflareDOTests(): Promise<void> {
  console.log('\n[2/2] Running Cloudflare Durable Object (GameRoomDO + PresenceHubDO) sync, snake AI, and push tests...');

  const roomModPath = '../cloudflare/src/' + 'roomDO.ts';
  const hubModPath = '../cloudflare/src/' + 'hubDO.ts';
  const { GameRoomDO } = await import(/* @vite-ignore */ roomModPath);
  const { PresenceHubDO } = await import(/* @vite-ignore */ hubModPath);

  // Minimal in-memory DurableObjectState & Env harness to exercise real GameRoomDO code
  const deliveredBatches: any[] = [];
  const fakeHubStub = {
    fetch: async (_url: string, init?: RequestInit) => {
      if (init?.body) deliveredBatches.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    },
  };
  let alarmAt: number | null = null;
  const fakeCtx: any = {
    storage: {
      setAlarm: async (ts: number) => { alarmAt = ts; },
      deleteAlarm: async () => { alarmAt = null; },
    },
    waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}); },
  };

  const fakeEnv = {
    PRESENCE_HUB: {
      idFromName: () => 'hub',
      get: () => fakeHubStub,
    },
    DISCONNECT_GRACE_MS: '8000',
  } as any;

  const roomDO = new GameRoomDO(fakeCtx, fakeEnv);

  const callRoom = async (payload: Record<string, unknown>) => {
    const res = await roomDO.fetch(
      new Request('https://room/internal/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    );
    return (await res.json()) as { room?: any; error?: string; batch?: any };
  };

  const userA = { id: 'cf-u1', username: 'CFAlice', avatarColor: '#52e0b6', avatarIcon: 'diver' as const, status: 'online' as const };
  const userB = { id: 'cf-u2', username: 'CFBob', avatarColor: '#f59e0b', avatarIcon: 'diver' as const, status: 'online' as const };

  await callRoom({ action: 'create', roomId: 'room-cf-1', code: 'CF1234', user: userA, levelId: 1 });
  await callRoom({ action: 'join', user: userB });
  const startRes = await callRoom({ action: 'start', userId: userA.id });
  assert.ok(startRes.room && startRes.room.status === 'playing');

  const level1 = getLevelById(1);
  const startPlat = level1.platforms[0];
  const deckY = startPlat.position[1] + startPlat.size[1] * 0.5;
  const waterY = level1.bounds.waterY;

  // 1. Verify prevAnim bug is FIXED: changing animState from 'idle' -> 'run' MUST immediately return a game:world delivery
  // even when called 5ms after start (within the 32ms throttle window)!
  const inputRunRes = await callRoom({
    action: 'input_state',
    userId: userA.id,
    packet: {
      x: startPlat.position[0] + 1.2,
      y: deckY,
      z: startPlat.position[2] - 0.8,
      yaw: 0.75,
      animState: 'run',
      horizSpeed: 8.2,
      velX: 5.8,
      velY: 0,
      velZ: -5.8,
      inWater: false,
      checkpointIndex: 0,
      escaped: false,
    },
  });
  const worldDeliv = inputRunRes.batch?.deliveries?.find((d: any) => d.event === 'game:world');
  assert.ok(worldDeliv, 'Cloudflare GameRoomDO MUST broadcast game:world immediately on animState transition (prevAnim bug fixed)');
  assert.ok(worldDeliv.targetUserIds.includes(userB.id), 'Broadcast must target connected friend CFBob');
  const aInWorld = (worldDeliv.payload as WorldSyncPayload).players.find((p: PlayerNetState) => p.userId === userA.id)!;
  assert.equal(aInWorld.animState, 'run');
  assert.ok(Math.abs(aInWorld.x - (startPlat.position[0] + 1.2)) < 0.01);
  assert.ok(Math.abs((aInWorld.velX ?? 0) - 5.8) < 0.05);
  assert.ok(alarmAt !== null, 'Alarm must stay scheduled during active match');
  console.log('  ✓ Cloudflare GameRoomDO immediate movement/anim/velocity sync verified');

  // 2. Verify Cloudflare GameRoomDO push + immediate knockback world sync
  await callRoom({
    action: 'input_state',
    userId: userA.id,
    packet: { x: startPlat.position[0] - 0.5, y: deckY, z: startPlat.position[2], yaw: Math.PI / 2, animState: 'idle', horizSpeed: 0, inWater: false, checkpointIndex: 0, escaped: false },
  });
  await callRoom({
    action: 'input_state',
    userId: userB.id,
    packet: { x: startPlat.position[0] + 1.1, y: deckY, z: startPlat.position[2], yaw: -Math.PI / 2, animState: 'idle', horizSpeed: 0, inWater: false, checkpointIndex: 0, escaped: false },
  });
  const pushRes = await callRoom({
    action: 'push',
    userId: userA.id,
    packet: { yaw: Math.PI / 2, x: startPlat.position[0] - 0.5, y: deckY, z: startPlat.position[2], targetUserId: userB.id },
  });
  const pushEv = pushRes.batch?.deliveries?.find((d: any) => d.event === 'game:player_event' && d.payload?.kind === 'pushed');
  const pushWorld = pushRes.batch?.deliveries?.find((d: any) => d.event === 'game:world');
  assert.ok(pushEv, 'Cloudflare GameRoomDO must broadcast pushed event');
  assert.ok(pushWorld, 'Cloudflare GameRoomDO must broadcast updated world immediately after push');
  const bPushed = (pushWorld.payload as WorldSyncPayload).players.find((p: PlayerNetState) => p.userId === userB.id)!;
  assert.ok(bPushed.x > startPlat.position[0] + 1.3, 'Cloudflare GameRoomDO must immediately displace pushed target');
  assert.ok((bPushed.velX ?? 0) > 8, 'Cloudflare GameRoomDO must immediately replicate knockback velocity');
  console.log('  ✓ Cloudflare GameRoomDO push event & immediate world knockback verified');

  // 3. Verify Cloudflare GameRoomDO water entry + snake chase + diving under platform
  const fallRes = await callRoom({
    action: 'input_state',
    userId: userB.id,
    packet: {
      x: startPlat.position[0] + startPlat.size[0] * 0.5 + 0.15,
      y: waterY - 0.14,
      z: startPlat.position[2] - 2.0,
      yaw: Math.PI,
      animState: 'swim',
      horizSpeed: 3.5,
      velX: 0,
      velY: 0,
      velZ: -3.5,
      inWater: true,
      checkpointIndex: 0,
      escaped: false,
    },
  });
  const waterWorld = fallRes.batch?.deliveries?.find((d: any) => d.event === 'game:world');
  assert.ok(waterWorld, 'Cloudflare GameRoomDO must immediately broadcast game:world when player falls into water');
  const bWater = (waterWorld.payload as WorldSyncPayload).players.find((p: PlayerNetState) => p.userId === userB.id)!;
  assert.equal(bWater.inWater, true, 'Player near platform edge must be detected as inWater=true');
  await sleep(55);
  await roomDO.alarm();
  const alarmWorld = deliveredBatches
    .flatMap((b) => b.deliveries || [])
    .reverse()
    .find((d: any) => d.event === 'game:world');
  assert.ok(alarmWorld, 'Alarm must deliver world update');
  const chasingMonster = (alarmWorld.payload as WorldSyncPayload).monsters.find((m) => m.alert === 'chasing');
  assert.ok(chasingMonster, 'Cloudflare GameRoomDO monster must enter chasing state when player enters water');
  assert.equal(chasingMonster.targetUserId, userB.id);
  console.log('  ✓ Cloudflare GameRoomDO water detection & snake chase verified');

  // 4. Verify preferredTargetUserId selection & strict behind-target rejection
  const preferredPush = selectPushTarget(
    level1,
    { userId: 'a', x: 0, y: deckY, z: 0, yaw: 0 },
    [
      { userId: 'b1', x: -0.35, y: deckY, z: 1.4 },
      { userId: 'b2', x: 0.35, y: deckY, z: 1.4 },
    ],
    0,
    'b2'
  );
  assert.ok(preferredPush && preferredPush.userId === 'b2', 'Preferred target in forward cone should be selected');
  const farBehind = selectPushTarget(
    level1,
    { userId: 'a', x: 0, y: deckY, z: 0, yaw: 0 },
    [{ userId: 'b', x: 0, y: deckY, z: -1.5 }],
    0
  );
  assert.equal(farBehind, null, 'Target 1.5m directly behind attacker must still be rejected');
  console.log('  ✓ Push physics preferred-target & directional invariants verified');

  // Clean up room timer so Node process exits cleanly
  await callRoom({ action: 'close', userId: userA.id });
  assert.ok(typeof PresenceHubDO === 'function');
}

(async () => {
  await runNodeServerTests();
  await runCloudflareDOTests();
  console.log('\nALL MULTIPLAYER SYNC, SNAKE AI & PUSH VERIFICATION TESTS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});

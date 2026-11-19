import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AVATAR_COLORS,
  AVATAR_ICONS,
  type AvatarIcon,
  type FriendInfo,
  type FriendRequestInfo,
  type PublicUser,
  type UserPresenceStatus,
  type UserSearchResult,
} from '../src/multiplayer/types.ts';

export interface StoredUserRow {
  id: string;
  username: string;
  username_lower: string;
  password_hash: string;
  password_salt: string;
  avatar_color: string;
  avatar_icon: string;
  created_at: number;
}

export class MultiplayerDatabase {
  private db: DatabaseSync;

  constructor(dbPath = path.resolve(process.cwd(), 'data', 'deeptile.db')) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        avatar_icon TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        UNIQUE(from_user_id, to_user_id)
      );

      CREATE TABLE IF NOT EXISTS friendships (
        user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_a, user_b)
      );

      CREATE INDEX IF NOT EXISTS idx_users_lower ON users(username_lower);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_fr_to ON friend_requests(to_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_user_id, status);
    `);
  }

  public close(): void {
    this.db.close();
  }

  private sanitizeAvatarColor(color?: string): string {
    if (color && (AVATAR_COLORS as readonly string[]).includes(color)) {
      return color;
    }
    return AVATAR_COLORS[0];
  }

  private sanitizeAvatarIcon(icon?: string): AvatarIcon {
    if (icon && (AVATAR_ICONS as readonly string[]).includes(icon)) {
      return icon as AvatarIcon;
    }
    return AVATAR_ICONS[0];
  }

  private toPublicUser(row: StoredUserRow, status: UserPresenceStatus = 'offline'): PublicUser {
    return {
      id: row.id,
      username: row.username,
      avatarColor: row.avatar_color,
      avatarIcon: this.sanitizeAvatarIcon(row.avatar_icon),
      status,
    };
  }

  public validateUsername(raw: string): { valid: boolean; clean: string; error?: string } {
    const clean = (raw || '').trim();
    if (clean.length < 3 || clean.length > 20) {
      return { valid: false, clean, error: 'Username must be 3 to 20 characters.' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
      return {
        valid: false,
        clean,
        error: 'Username may only contain letters, numbers, underscores, and hyphens.',
      };
    }
    return { valid: true, clean };
  }

  public registerUser(
    usernameInput: string,
    password: string,
    avatarColor?: string,
    avatarIcon?: string
  ): { user: PublicUser; token: string } {
    const check = this.validateUsername(usernameInput);
    if (!check.valid) {
      throw new Error(check.error || 'Invalid username.');
    }
    if (!password || password.length < 4 || password.length > 128) {
      throw new Error('Password must be 4 to 128 characters.');
    }

    const lower = check.clean.toLowerCase();
    const existing = this.db
      .prepare('SELECT id FROM users WHERE username_lower = ?')
      .get(lower) as { id: string } | undefined;
    if (existing) {
      throw new Error('That username is already taken.');
    }

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const color = this.sanitizeAvatarColor(avatarColor);
    const icon = this.sanitizeAvatarIcon(avatarIcon);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO users (id, username, username_lower, password_hash, password_salt, avatar_color, avatar_icon, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, check.clean, lower, hash, salt, color, icon, now);

    const token = this.createSession(id);
    const row = this.getUserRowById(id)!;
    return { user: this.toPublicUser(row, 'online'), token };
  }

  public loginUser(usernameInput: string, password: string): { user: PublicUser; token: string } {
    const clean = (usernameInput || '').trim().toLowerCase();
    if (!clean || !password) {
      throw new Error('Username and password are required.');
    }
    const row = this.db
      .prepare('SELECT * FROM users WHERE username_lower = ?')
      .get(clean) as StoredUserRow | undefined;
    if (!row) {
      throw new Error('Invalid username or password.');
    }

    const candidate = crypto.scryptSync(password, row.password_salt, 64);
    const stored = Buffer.from(row.password_hash, 'hex');
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      throw new Error('Invalid username or password.');
    }

    const token = this.createSession(row.id);
    return { user: this.toPublicUser(row, 'online'), token };
  }

  public createSession(userId: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24 * 30; // 30 days
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, now, expiresAt);
    return token;
  }

  public getUserByToken(token: string): PublicUser | null {
    if (!token) return null;
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .get(token, now) as StoredUserRow | undefined;
    return row ? this.toPublicUser(row, 'offline') : null;
  }

  public getUserRowById(userId: string): StoredUserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as StoredUserRow | undefined;
  }

  public getPublicUserById(userId: string, status: UserPresenceStatus = 'offline'): PublicUser | null {
    const row = this.getUserRowById(userId);
    return row ? this.toPublicUser(row, status) : null;
  }

  private canonicalPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  public areFriends(a: string, b: string): boolean {
    const [u1, u2] = this.canonicalPair(a, b);
    const row = this.db
      .prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?')
      .get(u1, u2);
    return Boolean(row);
  }

  public getFriends(
    userId: string,
    getPresence: (id: string) => { status: UserPresenceStatus; inRoomId: string | null }
  ): FriendInfo[] {
    const rows = this.db
      .prepare(
        `SELECT u.* FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
         WHERE f.user_a = ? OR f.user_b = ?
         ORDER BY u.username_lower ASC`
      )
      .all(userId, userId, userId) as unknown as StoredUserRow[];

    return rows.map((r) => {
      const p = getPresence(r.id);
      return {
        ...this.toPublicUser(r, p.status),
        inRoomId: p.inRoomId,
      };
    });
  }

  public getFriendIds(userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS fid
         FROM friendships WHERE user_a = ? OR user_b = ?`
      )
      .all(userId, userId, userId) as unknown as Array<{ fid: string }>;
    return rows.map((r) => r.fid);
  }

  public getFriendRequests(userId: string): {
    incoming: FriendRequestInfo[];
    outgoing: FriendRequestInfo[];
  } {
    const rows = this.db
      .prepare(
        `SELECT fr.*,
                fu.username AS from_username, fu.avatar_color AS from_color, fu.avatar_icon AS from_icon,
                tu.username AS to_username, tu.avatar_color AS to_color, tu.avatar_icon AS to_icon
         FROM friend_requests fr
         JOIN users fu ON fu.id = fr.from_user_id
         JOIN users tu ON tu.id = fr.to_user_id
         WHERE fr.status = 'pending' AND (fr.from_user_id = ? OR fr.to_user_id = ?)
         ORDER BY fr.created_at DESC`
      )
      .all(userId, userId) as unknown as Array<{
      id: string;
      from_user_id: string;
      to_user_id: string;
      status: 'pending' | 'accepted' | 'rejected';
      created_at: number;
      from_username: string;
      from_color: string;
      from_icon: string;
      to_username: string;
      to_color: string;
      to_icon: string;
    }>;

    const mapped: FriendRequestInfo[] = rows.map((r) => ({
      id: r.id,
      fromUserId: r.from_user_id,
      fromUsername: r.from_username,
      fromAvatarColor: r.from_color,
      fromAvatarIcon: this.sanitizeAvatarIcon(r.from_icon),
      toUserId: r.to_user_id,
      toUsername: r.to_username,
      toAvatarColor: r.to_color,
      toAvatarIcon: this.sanitizeAvatarIcon(r.to_icon),
      status: r.status,
      createdAt: r.created_at,
    }));

    return {
      incoming: mapped.filter((r) => r.toUserId === userId),
      outgoing: mapped.filter((r) => r.fromUserId === userId),
    };
  }

  public searchUsers(
    viewerId: string,
    query: string,
    getPresence: (id: string) => UserPresenceStatus
  ): UserSearchResult[] {
    const q = (query || '').trim().toLowerCase();
    const pattern = q ? `%${q}%` : '%';
    const rows = this.db
      .prepare(
        `SELECT * FROM users
         WHERE id != ? AND username_lower LIKE ?
         ORDER BY username_lower ASC
         LIMIT 25`
      )
      .all(viewerId, pattern) as unknown as StoredUserRow[];

    const friendSet = new Set(this.getFriendIds(viewerId));
    const reqs = this.getFriendRequests(viewerId);
    const outgoingSet = new Set(reqs.outgoing.map((r) => r.toUserId));
    const incomingSet = new Set(reqs.incoming.map((r) => r.fromUserId));

    return rows.map((r) => {
      let relationship: UserSearchResult['relationship'] = 'none';
      if (friendSet.has(r.id)) relationship = 'friends';
      else if (outgoingSet.has(r.id)) relationship = 'outgoing_pending';
      else if (incomingSet.has(r.id)) relationship = 'incoming_pending';

      return {
        ...this.toPublicUser(r, getPresence(r.id)),
        relationship,
      };
    });
  }

  public sendFriendRequest(fromUserId: string, toUserId: string): FriendRequestInfo {
    if (fromUserId === toUserId) {
      throw new Error('You cannot send a friend request to yourself.');
    }
    const target = this.getUserRowById(toUserId);
    if (!target) {
      throw new Error('Player not found.');
    }
    if (this.areFriends(fromUserId, toUserId)) {
      throw new Error('You are already friends with this player.');
    }

    // Check existing pending request in either direction
    const existing = this.db
      .prepare(
        `SELECT * FROM friend_requests
         WHERE status = 'pending'
           AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`
      )
      .get(fromUserId, toUserId, toUserId, fromUserId) as { id: string; from_user_id: string } | undefined;

    if (existing) {
      if (existing.from_user_id === toUserId) {
        throw new Error('This player already sent you a friend request.');
      }
      throw new Error('Friend request already sent.');
    }

    // Remove stale non-pending record in same direction if rejected previously
    this.db
      .prepare('DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?')
      .run(fromUserId, toUserId);

    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(id, fromUserId, toUserId, now);

    const fromRow = this.getUserRowById(fromUserId)!;
    return {
      id,
      fromUserId,
      fromUsername: fromRow.username,
      fromAvatarColor: fromRow.avatar_color,
      fromAvatarIcon: this.sanitizeAvatarIcon(fromRow.avatar_icon),
      toUserId,
      toUsername: target.username,
      toAvatarColor: target.avatar_color,
      toAvatarIcon: this.sanitizeAvatarIcon(target.avatar_icon),
      status: 'pending',
      createdAt: now,
    };
  }

  public respondFriendRequest(
    viewerId: string,
    requestId: string,
    action: 'accept' | 'reject'
  ): { fromUserId: string; toUserId: string; accepted: boolean } {
    const req = this.db
      .prepare('SELECT * FROM friend_requests WHERE id = ?')
      .get(requestId) as
      | { id: string; from_user_id: string; to_user_id: string; status: string }
      | undefined;

    if (!req) {
      throw new Error('Friend request not found.');
    }
    if (req.to_user_id !== viewerId) {
      throw new Error('Not authorized to respond to this friend request.');
    }
    if (req.status !== 'pending') {
      throw new Error('Friend request was already processed.');
    }

    if (action === 'accept') {
      this.db.prepare(`UPDATE friend_requests SET status = 'accepted' WHERE id = ?`).run(requestId);
      const [u1, u2] = this.canonicalPair(req.from_user_id, req.to_user_id);
      this.db
        .prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .run(u1, u2, Date.now());
      return { fromUserId: req.from_user_id, toUserId: req.to_user_id, accepted: true };
    } else {
      this.db.prepare(`UPDATE friend_requests SET status = 'rejected' WHERE id = ?`).run(requestId);
      return { fromUserId: req.from_user_id, toUserId: req.to_user_id, accepted: false };
    }
  }

  public removeFriend(userId: string, friendId: string): void {
    const [u1, u2] = this.canonicalPair(userId, friendId);
    this.db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(u1, u2);
    this.db
      .prepare(
        'DELETE FROM friend_requests WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)'
      )
      .run(userId, friendId, friendId, userId);
  }
}

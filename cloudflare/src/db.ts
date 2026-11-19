import {
  AVATAR_COLORS,
  AVATAR_ICONS,
  type AvatarIcon,
  type FriendInfo,
  type FriendRequestInfo,
  type PublicUser,
  type UserPresenceStatus,
  type UserSearchResult,
} from '../../src/multiplayer/types.ts';
import { hashPassword, randomHex, verifyPassword } from './crypto.ts';
import type { HubPresenceLookup } from './types.ts';

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

export class CloudflareD1Database {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
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

  public async registerUser(
    usernameInput: string,
    password: string,
    avatarColor?: string,
    avatarIcon?: string
  ): Promise<{ user: PublicUser; token: string }> {
    const check = this.validateUsername(usernameInput);
    if (!check.valid) {
      throw new Error(check.error || 'Invalid username.');
    }
    if (!password || password.length < 4 || password.length > 128) {
      throw new Error('Password must be 4 to 128 characters.');
    }

    const lower = check.clean.toLowerCase();
    const existing = await this.db
      .prepare('SELECT id FROM users WHERE username_lower = ?')
      .bind(lower)
      .first<{ id: string }>();

    if (existing) {
      throw new Error('That username is already taken.');
    }

    const id = crypto.randomUUID();
    const { hash, salt } = await hashPassword(password);
    const color = this.sanitizeAvatarColor(avatarColor);
    const icon = this.sanitizeAvatarIcon(avatarIcon);
    const now = Date.now();

    await this.db
      .prepare(
        `INSERT INTO users (id, username, username_lower, password_hash, password_salt, avatar_color, avatar_icon, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, check.clean, lower, hash, salt, color, icon, now)
      .run();

    const token = await this.createSession(id);
    const row = await this.getUserRowById(id);
    if (!row) {
      throw new Error('Failed to load created user.');
    }
    return { user: this.toPublicUser(row, 'online'), token };
  }

  public async loginUser(
    usernameInput: string,
    password: string
  ): Promise<{ user: PublicUser; token: string }> {
    const clean = (usernameInput || '').trim().toLowerCase();
    if (!clean || !password) {
      throw new Error('Username and password are required.');
    }

    const row = await this.db
      .prepare('SELECT * FROM users WHERE username_lower = ?')
      .bind(clean)
      .first<StoredUserRow>();

    if (!row) {
      throw new Error('Invalid username or password.');
    }

    const ok = await verifyPassword(password, row.password_hash, row.password_salt);
    if (!ok) {
      throw new Error('Invalid username or password.');
    }

    const token = await this.createSession(row.id);
    return { user: this.toPublicUser(row, 'online'), token };
  }

  public async createSession(userId: string): Promise<string> {
    const token = randomHex(32);
    const now = Date.now();
    const expiresAt = now + 1000 * 60 * 60 * 24 * 30;
    await this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(token, userId, now, expiresAt)
      .run();
    return token;
  }

  public async getUserByToken(token: string): Promise<PublicUser | null> {
    if (!token) return null;
    const now = Date.now();
    const row = await this.db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`
      )
      .bind(token, now)
      .first<StoredUserRow>();

    return row ? this.toPublicUser(row, 'offline') : null;
  }

  public async getUserRowById(userId: string): Promise<StoredUserRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<StoredUserRow>();
    return row ?? null;
  }

  public async getPublicUserById(
    userId: string,
    status: UserPresenceStatus = 'offline'
  ): Promise<PublicUser | null> {
    const row = await this.getUserRowById(userId);
    return row ? this.toPublicUser(row, status) : null;
  }

  private canonicalPair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  public async areFriends(a: string, b: string): Promise<boolean> {
    const [u1, u2] = this.canonicalPair(a, b);
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM friendships WHERE user_a = ? AND user_b = ?')
      .bind(u1, u2)
      .first<{ ok: number }>();
    return Boolean(row);
  }

  public async getFriendIds(userId: string): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS fid
         FROM friendships WHERE user_a = ? OR user_b = ?`
      )
      .bind(userId, userId, userId)
      .all<{ fid: string }>();

    return (res.results || []).map((r) => r.fid);
  }

  public async getFriends(
    userId: string,
    getPresence: (id: string) => HubPresenceLookup
  ): Promise<FriendInfo[]> {
    const res = await this.db
      .prepare(
        `SELECT u.* FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
         WHERE f.user_a = ? OR f.user_b = ?
         ORDER BY u.username_lower ASC`
      )
      .bind(userId, userId, userId)
      .all<StoredUserRow>();

    return (res.results || []).map((r) => {
      const p = getPresence(r.id);
      return {
        ...this.toPublicUser(r, p.status),
        inRoomId: p.inRoomId,
      };
    });
  }

  public async getFriendRequests(userId: string): Promise<{
    incoming: FriendRequestInfo[];
    outgoing: FriendRequestInfo[];
  }> {
    const res = await this.db
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
      .bind(userId, userId)
      .all<{
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
      }>();

    const mapped: FriendRequestInfo[] = (res.results || []).map((r) => ({
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

  public async searchUsers(
    viewerId: string,
    query: string,
    getPresence: (id: string) => UserPresenceStatus
  ): Promise<UserSearchResult[]> {
    const q = (query || '').trim().toLowerCase();
    const pattern = q ? `%${q}%` : '%';

    const res = await this.db
      .prepare(
        `SELECT * FROM users
         WHERE id != ? AND username_lower LIKE ?
         ORDER BY username_lower ASC
         LIMIT 25`
      )
      .bind(viewerId, pattern)
      .all<StoredUserRow>();

    const [friendIds, reqs] = await Promise.all([
      this.getFriendIds(viewerId),
      this.getFriendRequests(viewerId),
    ]);

    const friendSet = new Set(friendIds);
    const outgoingSet = new Set(reqs.outgoing.map((r) => r.toUserId));
    const incomingSet = new Set(reqs.incoming.map((r) => r.fromUserId));

    return (res.results || []).map((r) => {
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

  public async sendFriendRequest(fromUserId: string, toUserId: string): Promise<FriendRequestInfo> {
    if (fromUserId === toUserId) {
      throw new Error('You cannot send a friend request to yourself.');
    }
    const target = await this.getUserRowById(toUserId);
    if (!target) {
      throw new Error('Player not found.');
    }
    if (await this.areFriends(fromUserId, toUserId)) {
      throw new Error('You are already friends with this player.');
    }

    const existing = await this.db
      .prepare(
        `SELECT * FROM friend_requests
         WHERE status = 'pending'
           AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`
      )
      .bind(fromUserId, toUserId, toUserId, fromUserId)
      .first<{ id: string; from_user_id: string }>();

    if (existing) {
      if (existing.from_user_id === toUserId) {
        throw new Error('This player already sent you a friend request.');
      }
      throw new Error('Friend request already sent.');
    }

    await this.db
      .prepare('DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?')
      .bind(fromUserId, toUserId)
      .run();

    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .bind(id, fromUserId, toUserId, now)
      .run();

    const fromRow = await this.getUserRowById(fromUserId);
    if (!fromRow) {
      throw new Error('Sender account not found.');
    }

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

  public async respondFriendRequest(
    viewerId: string,
    requestId: string,
    action: 'accept' | 'reject'
  ): Promise<{ fromUserId: string; toUserId: string; accepted: boolean }> {
    const req = await this.db
      .prepare('SELECT * FROM friend_requests WHERE id = ?')
      .bind(requestId)
      .first<{ id: string; from_user_id: string; to_user_id: string; status: string }>();

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
      await this.db.prepare(`UPDATE friend_requests SET status = 'accepted' WHERE id = ?`).bind(requestId).run();
      const [u1, u2] = this.canonicalPair(req.from_user_id, req.to_user_id);
      await this.db
        .prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)')
        .bind(u1, u2, Date.now())
        .run();
      return { fromUserId: req.from_user_id, toUserId: req.to_user_id, accepted: true };
    }

    await this.db.prepare(`UPDATE friend_requests SET status = 'rejected' WHERE id = ?`).bind(requestId).run();
    return { fromUserId: req.from_user_id, toUserId: req.to_user_id, accepted: false };
  }

  public async removeFriend(userId: string, friendId: string): Promise<void> {
    const [u1, u2] = this.canonicalPair(userId, friendId);
    await this.db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').bind(u1, u2).run();
    await this.db
      .prepare(
        'DELETE FROM friend_requests WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)'
      )
      .bind(userId, friendId, friendId, userId)
      .run();
  }
}

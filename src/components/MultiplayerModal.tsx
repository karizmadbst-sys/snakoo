import React, { useEffect, useState } from 'react';
import {
  Anchor,
  Check,
  Compass,
  Copy,
  Crown,
  DoorOpen,
  LogOut,
  Play,
  Plus,
  Search,
  Shield,
  ShieldAlert,
  UserMinus,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  Waves,
  X,
  Zap,
} from 'lucide-react';
import { getLevelSummary, LEVEL_CATALOG, SECTOR_WINGS } from '../game/levels';
import type { CharacterId } from '../game/types';
import { MultiplayerClient, type MultiplayerSnapshot } from '../multiplayer/client';
import type { VoiceChatManager, VoiceChatSnapshot } from '../multiplayer/voice';
import { CharacterSelector } from './CharacterSelector';
import { LobbyVoicePanel, VoicePlayerBadge } from './VoiceControls';
import {
  AVATAR_COLORS,
  AVATAR_ICONS,
  MIN_ROOM_PLAYERS,
  type AvatarIcon,
  type MatchResultSummary,
  type RoomInviteInfo,
  type RoomState,
  type UserPresenceStatus,
  type UserSearchResult,
} from '../multiplayer/types';

const WING_GROUPED_LEVELS = SECTOR_WINGS.map((wing) => ({
  wing,
  levels: LEVEL_CATALOG.filter((l) => l.id >= wing.startId && l.id <= wing.endId),
}));

function renderAvatarIcon(icon: AvatarIcon, className = 'w-4 h-4') {
  switch (icon) {
    case 'anchor':
      return <Anchor className={className} />;
    case 'wave':
      return <Waves className={className} />;
    case 'compass':
      return <Compass className={className} />;
    case 'shield':
      return <Shield className={className} />;
    case 'bolt':
      return <Zap className={className} />;
    default:
      return <Users className={className} />;
  }
}

export const PlayerAvatar: React.FC<{
  color: string;
  icon: AvatarIcon;
  status?: UserPresenceStatus;
  size?: 'sm' | 'md';
}> = ({ color, icon, status, size = 'md' }) => {
  const dim = size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  const statusColor =
    status === 'online'
      ? '#34d399'
      : status === 'in-game'
        ? '#f59e0b'
        : '#64748b';

  return (
    <div className="relative shrink-0">
      <div
        className={`${dim} rounded-full border-2 flex items-center justify-center text-[#071012] shadow-inner`}
        style={{ backgroundColor: color, borderColor: '#e6f4f6' }}
      >
        {renderAvatarIcon(icon, size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4')}
      </div>
      {status && (
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0e1518]"
          style={{ backgroundColor: statusColor }}
          title={status.toUpperCase()}
        />
      )}
    </div>
  );
};

/* ============================================================================
 * LIVE ROOM INVITATION NOTIFICATION BANNER
 * ==========================================================================*/
export const InviteNotifications: React.FC<{
  invites: RoomInviteInfo[];
  onAccept: (inviteId: string) => void;
  onDecline: (inviteId: string) => void;
}> = ({ invites, onAccept, onDecline }) => {
  if (invites.length === 0) return null;

  return (
    <div
      className="fixed z-50 w-72 max-w-[calc(100vw-1.5rem)] flex flex-col gap-1.5 pointer-events-none"
      style={{
        top: 'max(0.625rem, env(safe-area-inset-top))',
        right: 'max(0.625rem, env(safe-area-inset-right))',
      }}
    >
      {invites.slice(0, 3).map((inv) => {
        const lvl = getLevelSummary(inv.levelId);
        return (
          <div
            key={inv.id}
            className="pointer-events-auto rounded-lg bg-[#0e191c]/95 border border-[#52e0b6]/70 p-2.5 shadow-2xl flex flex-col gap-2"
          >
            <div className="flex items-center gap-2">
              <PlayerAvatar color={inv.fromAvatarColor} icon={inv.fromAvatarIcon} status="online" size="sm" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono text-[#6ef0c8] uppercase tracking-wider truncate">
                  Room Invite · {inv.roomCode}
                </div>
                <div className="text-xs font-bold text-[#e6f3f5] truncate">
                  {inv.fromUsername} invited you
                </div>
                <div className="text-[10px] text-[#90abb2] truncate">
                  {lvl.code} · {lvl.name}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onAccept(inv.id)}
                className="flex-1 py-1.5 rounded-md bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] font-bold text-[11px] uppercase tracking-wider flex items-center justify-center gap-1 cursor-pointer"
              >
                <Check className="w-3 h-3" />
                Accept
              </button>
              <button
                type="button"
                onClick={() => onDecline(inv.id)}
                className="flex-1 py-1.5 rounded-md bg-[#192428] hover:bg-[#243338] border border-[#3d4f54] text-[#d5e5e8] font-semibold text-[11px] uppercase tracking-wider flex items-center justify-center gap-1 cursor-pointer"
              >
                <X className="w-3 h-3" />
                Decline
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* ============================================================================
 * MAIN MULTIPLAYER HUB MODAL (AUTH + PRIVATE ROOM + FRIENDS)
 * ==========================================================================*/
interface MultiplayerModalProps {
  client: MultiplayerClient;
  snapshot: MultiplayerSnapshot;
  voiceMgr: VoiceChatManager;
  voiceSnap: VoiceChatSnapshot;
  voiceVolume: number;
  characterId: CharacterId;
  onCharacterChange: (next: CharacterId) => void;
  onMasterVoiceToggle: (enabled: boolean) => void;
  onVoiceVolumeChange: (volume: number) => void;
  onClose: () => void;
}

export const MultiplayerModal: React.FC<MultiplayerModalProps> = ({
  client,
  snapshot,
  voiceMgr,
  voiceSnap,
  voiceVolume,
  characterId,
  onCharacterChange,
  onMasterVoiceToggle,
  onVoiceVolumeChange,
  onClose,
}) => {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [avatarColor, setAvatarColor] = useState<string>(AVATAR_COLORS[0]);
  const [avatarIcon, setAvatarIcon] = useState<AvatarIcon>(AVATAR_ICONS[0]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [mobileTab, setMobileTab] = useState<'room' | 'friends'>('room');
  const [selectedLevelId, setSelectedLevelId] = useState(1);
  const [joinCode, setJoinCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'error' | 'info'; text: string } | null>(null);

  const user = snapshot.user;
  const room = snapshot.room;

  const friendIdsKey = snapshot.friends.map((f) => f.id).join(',');
  const inReqKey = snapshot.incomingRequests.map((r) => r.id).join(',');
  const outReqKey = snapshot.outgoingRequests.map((r) => r.id).join(',');

  // Search real registered users when authenticated & friend list membership changes
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchBusy(true);
      try {
        const list = await client.searchUsers(searchQuery);
        if (!cancelled) setSearchResults(list);
      } catch {
        // ignore transient search errors
      } finally {
        if (!cancelled) setSearchBusy(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, user, searchQuery, friendIdsKey, inReqKey, outReqKey]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    try {
      if (authMode === 'register') {
        await client.register(username, password, avatarColor, avatarIcon);
      } else {
        await client.login(username, password);
      }
      setPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // clipboard blocked
    }
  };

  const handleSendFriendRequest = async (targetUserId: string) => {
    setActionMsg(null);
    try {
      await client.sendFriendRequest(targetUserId);
      setActionMsg({ type: 'info', text: 'Friend request sent.' });
    } catch (err) {
      setActionMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to send request.',
      });
    }
  };

  const handleRespondFriendReq = async (reqId: string, action: 'accept' | 'reject') => {
    setActionMsg(null);
    try {
      await client.respondFriendRequest(reqId, action);
    } catch (err) {
      setActionMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to respond to request.',
      });
    }
  };

  const handleRemoveFriend = async (friendId: string) => {
    setActionMsg(null);
    try {
      await client.removeFriend(friendId);
    } catch (err) {
      setActionMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to remove friend.',
      });
    }
  };

  const isHost = Boolean(room && user && room.hostId === user.id);
  const realConnectedCount = room
    ? room.players.filter((p) => !p.isBot && p.connected).length
    : 0;
  const canStart =
    Boolean(room && isHost && room.status === 'lobby') &&
    realConnectedCount >= MIN_ROOM_PLAYERS &&
    room!.players.length <= room!.maxPlayers;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-2.5 sm:p-3.5 bg-[#060a0c]/90"
      style={{
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
      }}
    >
      <div className="w-full max-w-3xl max-h-[88dvh] flex flex-col rounded-xl bg-[#0e1518] border border-[#314247] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 sm:px-4 py-2 border-b border-[#243236] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Users className="w-4 h-4 text-[#52e0b6] shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold tracking-wider uppercase text-[#e6f1f3] truncate">
                Online Friends Multiplayer
              </h2>
              <p className="text-[10px] font-mono text-[#7c969c] truncate">
                PRIVATE CO-OP LOBBIES · 2–12 PLAYERS · SHARED SEA SERPENT
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {user && (
              <div className="hidden sm:flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#131e22] border border-[#2a3b40]">
                <PlayerAvatar
                  color={user.avatarColor}
                  icon={user.avatarIcon}
                  status={snapshot.connected ? 'online' : 'offline'}
                  size="sm"
                />
                <span className="text-[11px] font-semibold text-[#e2eff2]">{user.username}</span>
                <button
                  type="button"
                  onClick={() => client.logout()}
                  title="Sign Out"
                  className="p-0.5 text-[#8da7ad] hover:text-[#f06868] cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-[#8fa7ad] hover:text-white hover:bg-[#1a262a] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Auth Screen if not signed in */}
        {!user ? (
          <div className="p-3 sm:p-4 overflow-y-auto flex justify-center">
            <form
              onSubmit={handleAuthSubmit}
              className="w-full max-w-sm flex flex-col gap-2.5 rounded-lg bg-[#121c20] border border-[#2a3b40] p-3.5 sm:p-4"
            >
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-md bg-[#0b1114] border border-[#233236]">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError(null);
                  }}
                  className={`py-1.5 rounded text-[11px] font-bold uppercase tracking-wider cursor-pointer ${
                    authMode === 'register'
                      ? 'bg-[#52e0b6] text-[#071113]'
                      : 'text-[#90abb2] hover:text-white'
                  }`}
                >
                  Create Account
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                  }}
                  className={`py-1.5 rounded text-[11px] font-bold uppercase tracking-wider cursor-pointer ${
                    authMode === 'login'
                      ? 'bg-[#52e0b6] text-[#071113]'
                      : 'text-[#90abb2] hover:text-white'
                  }`}
                >
                  Sign In
                </button>
              </div>

              {authError && (
                <div className="px-2.5 py-1.5 rounded-md bg-[#2e1215] border border-[#a83842] text-[11px] text-[#ffb8be]">
                  {authError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[10px] font-mono text-[#9bb3b9]">
                  <span>USERNAME (3–20)</span>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="DiverName"
                    required
                    minLength={3}
                    maxLength={20}
                    className="px-2.5 py-1.5 rounded-md bg-[#0a1012] border border-[#314348] text-xs text-[#e8f4f6] focus:outline-none focus:border-[#52e0b6]"
                  />
                </label>

                <label className="flex flex-col gap-1 text-[10px] font-mono text-[#9bb3b9]">
                  <span>PASSWORD</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min 4 chars"
                    required
                    minLength={4}
                    className="px-2.5 py-1.5 rounded-md bg-[#0a1012] border border-[#314348] text-xs text-[#e8f4f6] focus:outline-none focus:border-[#52e0b6]"
                  />
                </label>
              </div>

              {authMode === 'register' && (
                <div className="flex flex-col gap-2 pt-0.5">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono text-[#9bb3b9]">SUIT COLOR</span>
                    <div className="flex flex-wrap gap-1.5">
                      {AVATAR_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setAvatarColor(c)}
                          className={`w-6 h-6 rounded-full border-2 cursor-pointer transition-transform ${
                            avatarColor === c ? 'scale-110 border-white' : 'border-transparent opacity-75'
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono text-[#9bb3b9]">DIVER EMBLEM</span>
                    <div className="grid grid-cols-6 gap-1.5">
                      {AVATAR_ICONS.map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          onClick={() => setAvatarIcon(ic)}
                          className={`py-1.5 rounded-md border flex items-center justify-center cursor-pointer ${
                            avatarIcon === ic
                              ? 'bg-[#52e0b6]/25 border-[#52e0b6] text-[#8ef5d5]'
                              : 'bg-[#0b1114] border-[#28373b] text-[#88a1a8]'
                          }`}
                        >
                          {renderAvatarIcon(ic, 'w-3.5 h-3.5')}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy}
                className="mt-0.5 py-2 rounded-md bg-[#52e0b6] hover:bg-[#6ef0c8] disabled:opacity-50 text-[#071113] font-bold text-xs uppercase tracking-wider cursor-pointer"
              >
                {authBusy
                  ? 'Connecting...'
                  : authMode === 'register'
                    ? 'Create Diver Profile'
                    : 'Sign In'}
              </button>
            </form>
          </div>
        ) : (
          /* Authenticated Multiplayer Hub */
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Compact narrow fallback switcher (hidden on landscape phones >= sm) */}
            <div className="flex sm:hidden items-center justify-between gap-2 px-3 py-1.5 border-b border-[#223034] bg-[#0b1113]">
              <div className="grid grid-cols-2 gap-1 flex-1 p-0.5 rounded-md bg-[#121c20] border border-[#243438]">
                <button
                  type="button"
                  onClick={() => setMobileTab('room')}
                  className={`py-1 rounded text-[11px] font-bold uppercase tracking-wider cursor-pointer ${
                    mobileTab === 'room' ? 'bg-[#52e0b6] text-[#071113]' : 'text-[#9ab2b8]'
                  }`}
                >
                  Room {room ? `(${room.players.length}/${room.maxPlayers})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => setMobileTab('friends')}
                  className={`py-1 rounded text-[11px] font-bold uppercase tracking-wider cursor-pointer ${
                    mobileTab === 'friends' ? 'bg-[#52e0b6] text-[#071113]' : 'text-[#9ab2b8]'
                  }`}
                >
                  Friends ({snapshot.friends.length})
                  {snapshot.incomingRequests.length > 0 ? ` · ${snapshot.incomingRequests.length}` : ''}
                </button>
              </div>
              <button
                type="button"
                onClick={() => client.logout()}
                className="p-1.5 rounded-md bg-[#162024] border border-[#2c3c40] text-[#c5d6da]"
                title="Sign Out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Global server error / status banner */}
            {(snapshot.error || actionMsg) && (
              <div
                className={`mx-3 sm:mx-4 mt-2 px-3 py-1.5 rounded-md border text-[11px] flex items-center justify-between gap-2 ${
                  snapshot.error || actionMsg?.type === 'error'
                    ? 'bg-[#2c1215] border-[#a83842] text-[#ffb8be]'
                    : 'bg-[#102923] border-[#3d9c7e] text-[#9bf5d7]'
                }`}
              >
                <span>{snapshot.error || actionMsg?.text}</span>
                <button
                  type="button"
                  onClick={() => {
                    client.clearError();
                    setActionMsg(null);
                  }}
                  className="text-xs opacity-75 hover:opacity-100 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Main Horizontal 2-Column Content (Active across all landscape phones & desktop) */}
            <div className="flex-1 min-h-0 grid grid-cols-1 sm:grid-cols-12 gap-2.5 sm:gap-3 p-2.5 sm:p-3.5 overflow-y-auto">
              {/* LEFT COLUMN: PRIVATE ROOM LOBBY */}
              <div
                className={`sm:col-span-7 flex flex-col gap-2.5 ${
                  mobileTab === 'room' ? 'flex' : 'hidden sm:flex'
                }`}
              >
                {!room ? (
                  <div className="flex flex-col gap-2.5">
                    {/* Create Private Room Card */}
                    <div className="rounded-lg bg-[#121c20] border border-[#293a3f] p-3 flex flex-col gap-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <h3 className="text-xs sm:text-sm font-bold uppercase tracking-wider text-[#e8f4f6]">
                            Create Private Room
                          </h3>
                          <p className="text-[11px] text-[#8ea8ae]">
                            Generate a private invite code for 2–12 friends.
                          </p>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-[#18292e] border border-[#324d54] text-[9px] font-mono text-[#7ce6c4] uppercase">
                          Host
                        </span>
                      </div>

                      <label className="flex flex-col gap-1 text-[10px] font-mono text-[#90aab0]">
                        <span>STARTING SECTOR</span>
                        <select
                          value={selectedLevelId}
                          onChange={(e) => setSelectedLevelId(Number(e.target.value))}
                          className="px-2.5 py-1.5 rounded-md bg-[#0b1114] border border-[#2f4247] text-xs font-sans text-[#e4f0f2] focus:outline-none focus:border-[#52e0b6]"
                        >
                          {WING_GROUPED_LEVELS.map(({ wing, levels }) => (
                            <optgroup
                              key={wing.index}
                              label={`Wing ${wing.index + 1}: ${wing.name} (${wing.startId}–${wing.endId})`}
                            >
                              {levels.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code} — {l.name} ({l.difficulty})
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>

                      <button
                        type="button"
                        onClick={() => client.createRoom(selectedLevelId)}
                        className="w-full py-2 rounded-md bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Create Private Room
                      </button>
                    </div>

                    {/* Join Private Room by Code Card */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        client.joinRoomByCode(joinCode);
                      }}
                      className="rounded-lg bg-[#121c20] border border-[#293a3f] p-3 flex flex-col gap-2"
                    >
                      <div>
                        <h3 className="text-xs sm:text-sm font-bold uppercase tracking-wider text-[#e8f4f6]">
                          Join Private Room
                        </h3>
                        <p className="text-[11px] text-[#8ea8ae]">
                          Enter a friend&apos;s room code or accept an invite notification.
                        </p>
                      </div>

                      <div className="flex flex-row gap-2">
                        <input
                          type="text"
                          value={joinCode}
                          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                          placeholder="CODE (E.G. K7M4P9)"
                          maxLength={10}
                          required
                          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-[#0b1114] border border-[#2f4247] text-xs font-mono tracking-widest uppercase text-[#e8f4f6] focus:outline-none focus:border-[#52e0b6]"
                        />
                        <button
                          type="submit"
                          className="px-3.5 py-1.5 rounded-md bg-[#1b2e33] hover:bg-[#243d44] border border-[#44666e] text-[#e2f2f5] font-bold text-[11px] uppercase tracking-wider shrink-0 cursor-pointer"
                        >
                          Join
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  /* Active Private Room Roster & Controls */
                  <div className="rounded-lg bg-[#121c20] border border-[#2e4449] p-3 flex flex-col gap-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#223338]">
                      <div className="px-2.5 py-1 rounded-md bg-[#0b1114] border border-[#3d5b61] flex items-center gap-1.5">
                        <span className="text-[10px] font-mono text-[#84a2a8]">CODE</span>
                        <span className="text-sm font-mono font-bold tracking-widest text-[#6ef0c8]">
                          {room.code}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyCode(room.code)}
                          className="p-0.5 text-[#8eaeb5] hover:text-white cursor-pointer"
                          title="Copy Code"
                        >
                          {copiedCode ? (
                            <Check className="w-3.5 h-3.5 text-[#52e0b6]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      <span
                        className={`px-2 py-0.5 rounded-md border font-mono text-[11px] font-bold tabular-nums ${
                          room.players.length >= room.maxPlayers
                            ? 'bg-[#2e1b14] border-[#c46b45] text-[#ffb997]'
                            : realConnectedCount >= MIN_ROOM_PLAYERS
                              ? 'bg-[#102c24] border-[#3d9c7e] text-[#8ef5d5]'
                              : 'bg-[#282213] border-[#967733] text-[#f5d588]'
                        }`}
                      >
                        {room.players.length}/{room.maxPlayers} PLAYERS
                      </span>
                    </div>

                    {/* Sector Selector (Host editable, guests read-only) */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono text-[#8ca6ac] uppercase shrink-0">SECTOR</span>
                      {isHost ? (
                        <select
                          value={room.levelId}
                          onChange={(e) => client.setRoomLevel(Number(e.target.value))}
                          className="min-w-0 flex-1 max-w-[260px] px-2.5 py-1 rounded-md bg-[#0b1114] border border-[#2f4247] text-[11px] font-sans text-[#e4f0f2] focus:outline-none focus:border-[#52e0b6]"
                        >
                          {WING_GROUPED_LEVELS.map(({ wing, levels }) => (
                            <optgroup
                              key={wing.index}
                              label={`Wing ${wing.index + 1}: ${wing.name} (${wing.startId}–${wing.endId})`}
                            >
                              {levels.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code} — {l.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[11px] font-mono text-[#cfe3e7] truncate">
                          {(() => {
                            const lvl = getLevelSummary(room.levelId);
                            return `${lvl.code} — ${lvl.name}`;
                          })()}
                        </span>
                      )}
                    </div>

                    {/* Visual Character Selection */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-mono text-[#8ca6ac] uppercase">CHARACTER</span>
                      <div className="max-w-[160px] w-full">
                        <CharacterSelector
                          selectedId={characterId}
                          onSelect={onCharacterChange}
                          size="compact"
                        />
                      </div>
                    </div>

                    {/* Real-Time Voice Chat Controls & Microphone Permission Banner */}
                    <LobbyVoicePanel
                      voiceMgr={voiceMgr}
                      voiceSnap={voiceSnap}
                      voiceVolume={voiceVolume}
                      onMasterVoiceToggle={onMasterVoiceToggle}
                      onVoiceVolumeChange={onVoiceVolumeChange}
                    />

                    {/* Players List inside Room */}
                    <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto pr-1">
                      {room.players.map((p) => {
                        const isSelf = p.userId === user.id;
                        const locallyMuted = !isSelf && voiceSnap.mutedPeerIds.includes(p.userId);
                        const v = isSelf
                          ? {
                              voiceActive: voiceSnap.voiceActive,
                              micEnabled: voiceSnap.micEnabled,
                              selfMuted: voiceSnap.selfMuted,
                              speaking: voiceSnap.speaking,
                            }
                          : p.voice || {
                              voiceActive: false,
                              micEnabled: false,
                              selfMuted: false,
                              speaking: false,
                            };

                        return (
                          <div
                            key={p.userId}
                            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-[#0c1316] border border-[#223034]"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <PlayerAvatar
                                color={p.avatarColor}
                                icon={p.avatarIcon}
                                status={p.connected ? 'online' : 'offline'}
                                size="sm"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <span className="text-xs font-semibold text-[#e6f2f4] truncate">
                                    {p.username}
                                  </span>
                                  {isSelf && (
                                    <span className="text-[9px] font-mono text-[#6ef0c8]">(YOU)</span>
                                  )}
                                  {p.isHost && (
                                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-[#2d2411] border border-[#9a782c] text-[9px] font-mono text-[#f7d377]">
                                      <Crown className="w-2.5 h-2.5" />
                                      HOST
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                  <span className="text-[10px] font-mono text-[#7c979e]">
                                    {p.connected ? 'READY' : 'RECONNECTING...'}
                                  </span>
                                  <VoicePlayerBadge
                                    voiceActive={v.voiceActive}
                                    micEnabled={v.micEnabled}
                                    selfMuted={v.selfMuted}
                                    speaking={v.speaking}
                                    locallyMuted={locallyMuted}
                                  />
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => voiceMgr.togglePeerMuted(p.userId)}
                                  title={locallyMuted ? `Unmute ${p.username}` : `Mute ${p.username}`}
                                  className={`p-1 rounded border cursor-pointer ${
                                    locallyMuted
                                      ? 'bg-[#2c1518] border-[#78383f] text-[#ffb5bc]'
                                      : 'bg-[#142024] border-[#2d3e44] text-[#9eb7bd] hover:text-white'
                                  }`}
                                >
                                  {locallyMuted ? (
                                    <VolumeX className="w-3 h-3" />
                                  ) : (
                                    <Volume2 className="w-3 h-3" />
                                  )}
                                </button>
                              )}
                              {isHost && !isSelf && (
                                <button
                                  type="button"
                                  onClick={() => client.kickPlayer(p.userId)}
                                  className="px-2 py-1 rounded bg-[#261416] hover:bg-[#381d20] border border-[#6e3339] text-[10px] font-mono text-[#f5a9af] flex items-center gap-1 cursor-pointer"
                                >
                                  <UserMinus className="w-3 h-3" />
                                  Kick
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Host Start / Leave / Close Actions */}
                    <div className="flex flex-col gap-1.5 pt-2 border-t border-[#223338]">
                      {isHost ? (
                        <>
                          <button
                            type="button"
                            disabled={!canStart}
                            onClick={() => client.startGame()}
                            className={`w-full py-2 rounded-md font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 transition-colors ${
                              canStart
                                ? 'bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] cursor-pointer'
                                : 'bg-[#1a2528] border border-[#2f4146] text-[#7c969c] cursor-not-allowed'
                            }`}
                          >
                            <Play className="w-3.5 h-3.5 fill-current" />
                            {realConnectedCount < MIN_ROOM_PLAYERS
                              ? `Need ${MIN_ROOM_PLAYERS}+ players (${realConnectedCount}/${room.maxPlayers})`
                              : `Start Match (${room.players.length}/${room.maxPlayers})`}
                          </button>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              type="button"
                              onClick={() => client.leaveRoom()}
                              className="py-1.5 rounded-md bg-[#162125] hover:bg-[#1e2d32] border border-[#31454a] text-[11px] font-semibold uppercase tracking-wider text-[#d2e4e8] flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <DoorOpen className="w-3 h-3" />
                              Leave
                            </button>
                            <button
                              type="button"
                              onClick={() => client.closeRoom()}
                              className="py-1.5 rounded-md bg-[#271416] hover:bg-[#361b1e] border border-[#693237] text-[11px] font-semibold uppercase tracking-wider text-[#f3a8ae] cursor-pointer"
                            >
                              Close Room
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-mono text-[#8fb0b6] truncate">
                            Waiting for host to start...
                          </span>
                          <button
                            type="button"
                            onClick={() => client.leaveRoom()}
                            className="px-3 py-1.5 rounded-md bg-[#261618] hover:bg-[#361f22] border border-[#68343a] text-[11px] font-semibold uppercase tracking-wider text-[#f3acb2] shrink-0 cursor-pointer"
                          >
                            Leave
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN: SEARCHABLE FRIENDS & REQUESTS */}
              <div
                className={`sm:col-span-5 flex flex-col gap-2.5 ${
                  mobileTab === 'friends' ? 'flex' : 'hidden sm:flex'
                }`}
              >
                {/* Incoming Friend Requests */}
                {snapshot.incomingRequests.length > 0 && (
                  <div className="rounded-lg bg-[#112022] border border-[#34695c] p-2.5 flex flex-col gap-1.5">
                    <div className="text-[11px] font-mono font-bold text-[#74e8c2] uppercase">
                      Friend Requests ({snapshot.incomingRequests.length})
                    </div>
                    {snapshot.incomingRequests.map((req) => (
                      <div
                        key={req.id}
                        className="flex items-center justify-between gap-1.5 p-1.5 rounded-md bg-[#0b1315] border border-[#22383d]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <PlayerAvatar
                            color={req.fromAvatarColor}
                            icon={req.fromAvatarIcon}
                            size="sm"
                          />
                          <span className="text-[11px] font-semibold text-[#e6f3f5] truncate">
                            {req.fromUsername}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRespondFriendReq(req.id, 'accept')}
                            className="px-2 py-0.5 rounded bg-[#52e0b6] text-[#071113] font-bold text-[10px] uppercase cursor-pointer"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRespondFriendReq(req.id, 'reject')}
                            className="px-2 py-0.5 rounded bg-[#232e31] text-[#cbdce0] text-[10px] uppercase cursor-pointer"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Friends List */}
                <div className="rounded-lg bg-[#121c20] border border-[#293a3f] p-2.5 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#b7cdd2]">
                      Friends ({snapshot.friends.length})
                    </h3>
                    <span className="text-[9px] font-mono text-[#769399]">
                      LIVE STATUS
                    </span>
                  </div>

                  {snapshot.friends.length === 0 ? (
                    <div className="py-2.5 text-center text-[11px] text-[#7f9aa0]">
                      No friends yet. Search players below to add friends.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-1">
                      {snapshot.friends.map((f) => {
                        const inSameRoom = Boolean(room?.players.some((p) => p.userId === f.id));
                        const alreadyInvited = Boolean(room?.invitedFriendIds.includes(f.id));
                        const roomFull = Boolean(room && room.players.length >= room.maxPlayers);
                        const canInvite =
                          Boolean(room && room.status === 'lobby') &&
                          f.status === 'online' &&
                          !inSameRoom &&
                          !alreadyInvited &&
                          !roomFull;

                        return (
                          <div
                            key={f.id}
                            className="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-md bg-[#0c1316] border border-[#212f33]"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <PlayerAvatar
                                color={f.avatarColor}
                                icon={f.avatarIcon}
                                status={f.status}
                                size="sm"
                              />
                              <div className="min-w-0">
                                <div className="text-[11px] font-semibold text-[#e6f2f4] truncate">
                                  {f.username}
                                </div>
                                <div className="text-[9px] font-mono uppercase text-[#7f9aa0]">
                                  {inSameRoom
                                    ? 'IN ROOM'
                                    : f.status === 'in-game'
                                      ? 'IN-GAME'
                                      : f.status === 'online'
                                        ? 'ONLINE'
                                        : 'OFFLINE'}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {room && !inSameRoom && (
                                <button
                                  type="button"
                                  disabled={!canInvite}
                                  onClick={() => client.inviteFriend(f.id)}
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                    canInvite
                                      ? 'bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] cursor-pointer'
                                      : 'bg-[#182226] text-[#6d858b] cursor-not-allowed'
                                  }`}
                                >
                                  {alreadyInvited ? 'Sent' : roomFull ? 'Full' : 'Invite'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleRemoveFriend(f.id)}
                                title="Remove Friend"
                                className="p-1 rounded text-[#789298] hover:text-[#f06868] cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Search Real Players */}
                <div className="rounded-lg bg-[#121c20] border border-[#293a3f] p-2.5 flex flex-col gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-[#789298] absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search players..."
                      className="w-full pl-7 pr-2.5 py-1.5 rounded-md bg-[#0b1114] border border-[#2b3c41] text-[11px] text-[#e6f2f4] focus:outline-none focus:border-[#52e0b6]"
                    />
                  </div>

                  <div className="flex flex-col gap-1 max-h-32 overflow-y-auto pr-1">
                    {searchBusy && searchResults.length === 0 ? (
                      <div className="py-2 text-center text-[11px] text-[#7c969c]">Searching...</div>
                    ) : searchResults.length === 0 ? (
                      <div className="py-2 text-center text-[11px] text-[#7c969c]">
                        No matching players found.
                      </div>
                    ) : (
                      searchResults.map((u) => (
                        <div
                          key={u.id}
                          className="flex items-center justify-between gap-1.5 px-2 py-1 rounded-md bg-[#0c1316] border border-[#202e32]"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <PlayerAvatar
                              color={u.avatarColor}
                              icon={u.avatarIcon}
                              status={u.status}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold text-[#e6f2f4] truncate">
                                {u.username}
                              </div>
                              <div className="text-[9px] font-mono uppercase text-[#769197]">
                                {u.status}
                              </div>
                            </div>
                          </div>

                          {u.relationship === 'friends' ? (
                            <span className="text-[9px] font-mono text-[#6ef0c8] uppercase">
                              Friend
                            </span>
                          ) : u.relationship === 'outgoing_pending' ? (
                            <span className="text-[9px] font-mono text-[#e8b354] uppercase">
                              Pending
                            </span>
                          ) : u.relationship === 'incoming_pending' ? (
                            <span className="text-[9px] font-mono text-[#68b8f8] uppercase">
                              Incoming
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleSendFriendRequest(u.id)}
                              className="px-2 py-0.5 rounded bg-[#1b2e33] hover:bg-[#253f46] border border-[#3e5e66] text-[#d9eef2] text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                            >
                              <UserPlus className="w-3 h-3" />
                              Add
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============================================================================
 * MULTIPLAYER MATCH RESULT MODAL
 * ==========================================================================*/
export const MultiplayerResultModal: React.FC<{
  result: MatchResultSummary;
  room: RoomState | null;
  localUserId: string | null;
  onReturnLobby: () => void;
  onLeaveRoom: () => void;
}> = ({ result, room, localUserId, onReturnLobby, onLeaveRoom }) => {
  const isHost = Boolean(room && localUserId && room.hostId === localUserId);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-3 bg-[#060a0c]/90">
      <div className="w-full max-w-[300px] sm:max-w-sm max-h-[90dvh] overflow-y-auto rounded-xl bg-[#0e1518] border border-[#314b4a] p-4 sm:p-5 flex flex-col gap-3 text-center shadow-2xl">
        <div>
          <div className="text-[10px] font-mono tracking-widest uppercase text-[#74e8c2]">
            {room ? `ROOM ${room.code}` : 'MULTIPLAYER MATCH'}
          </div>
          <h2 className="text-lg sm:text-xl font-black uppercase tracking-wider text-[#e8f6f4] mt-0.5">
            {result.outcome === 'escaped' ? 'MATCH COMPLETE' : 'SQUAD WIPED'}
          </h2>
          <p className="text-[11px] text-[#94b0b5] mt-0.5">
            {result.reason === 'timeout'
              ? 'Time expired before all survivors escaped.'
              : result.reason === 'all_caught'
                ? 'The sea serpent hunted down every diver.'
                : `Survived in ${result.elapsed.toFixed(1)}s`}
          </p>
        </div>

        <div className="rounded-lg bg-[#091012] border border-[#223438] p-2.5 text-left flex flex-col gap-1.5">
          <div className="text-[10px] font-mono text-[#7c9ca3] uppercase">
            Survivors ({result.survivors.length})
          </div>
          {result.survivors.length === 0 ? (
            <div className="text-[11px] text-[#c7858b]">None escaped this round.</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {result.survivors.map((s) => (
                <span
                  key={s.userId}
                  className="px-2 py-0.5 rounded bg-[#122b25] border border-[#38856c] text-[11px] font-semibold text-[#98f5d6]"
                >
                  {s.username}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          {isHost ? (
            <button
              type="button"
              onClick={onReturnLobby}
              className="w-full py-2 rounded-lg bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] font-bold text-xs uppercase tracking-wider cursor-pointer"
            >
              Return Room to Lobby
            </button>
          ) : (
            <div className="py-1.5 text-[11px] font-mono text-[#8fb0b6]">
              Waiting for host to return to lobby...
            </div>
          )}
          <button
            type="button"
            onClick={onLeaveRoom}
            className="w-full py-2 rounded-lg bg-[#1a2225] hover:bg-[#243035] border border-[#38484d] text-xs font-semibold uppercase tracking-wider text-[#d9e7ea] cursor-pointer"
          >
            Leave Room
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * IN-GAME MULTIPLAYER STATUS BAR (SPECTATING / ESCAPED)
 * ==========================================================================*/
export const MultiplayerStatusPill: React.FC<{
  status: 'caught' | 'escaped';
  aliveCount: number;
  totalCount: number;
  onLeave: () => void;
}> = ({ status, aliveCount, totalCount, onLeave }) => (
  <div className="fixed top-12 sm:top-14 left-1/2 -translate-x-1/2 z-25 pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0b1316]/90 border border-[#3e595e] shadow-xl">
    <ShieldAlert
      className={`w-3.5 h-3.5 ${status === 'caught' ? 'text-[#f06868]' : 'text-[#52e0b6]'}`}
    />
    <span className="text-[11px] font-mono text-[#e4f2f4] whitespace-nowrap">
      {status === 'caught'
        ? `CAUGHT · SPECTATING (${aliveCount}/${totalCount})`
        : `ESCAPED · WATCHING (${aliveCount}/${totalCount})`}
    </span>
    <button
      type="button"
      onClick={onLeave}
      className="px-2 py-0.5 rounded bg-[#271518] hover:bg-[#381d22] border border-[#6e343b] text-[10px] font-mono uppercase text-[#f4adb3] cursor-pointer"
    >
      Leave
    </button>
  </div>
);

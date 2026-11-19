import React, { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Headphones,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { RoomPlayerInfo } from '../multiplayer/types';
import type { VoiceChatManager, VoiceChatSnapshot } from '../multiplayer/voice';

export const VoicePlayerBadge: React.FC<{
  voiceActive: boolean;
  micEnabled: boolean;
  selfMuted: boolean;
  speaking: boolean;
  locallyMuted?: boolean;
}> = ({ voiceActive, micEnabled, selfMuted, speaking, locallyMuted = false }) => {
  if (locallyMuted) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2a1518] border border-[#75363d] text-[10px] font-mono text-[#f59ca4]"
        title="Muted by you"
      >
        <VolumeX className="w-3 h-3" />
        <span>MUTED</span>
      </span>
    );
  }
  if (!voiceActive || !micEnabled) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#141d20] border border-[#2b3b40] text-[10px] font-mono text-[#7c949a]"
        title="Microphone off"
      >
        <MicOff className="w-3 h-3" />
        <span>MIC OFF</span>
      </span>
    );
  }
  if (selfMuted) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#2c2112] border border-[#8a6529] text-[10px] font-mono text-[#f4cc7b]"
        title="Microphone muted"
      >
        <MicOff className="w-3 h-3" />
        <span>MUTED</span>
      </span>
    );
  }
  if (speaking) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#0f2f25] border border-[#4de8b4] text-[10px] font-mono text-[#8df8d4] shadow-[0_0_12px_rgba(77,232,180,0.35)]"
        title="Speaking"
      >
        <Mic className="w-3 h-3 animate-pulse" />
        <span>SPEAKING</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#122629] border border-[#2f5d63] text-[10px] font-mono text-[#82cdd4]"
      title="Microphone active"
    >
      <Mic className="w-3 h-3" />
      <span>READY</span>
    </span>
  );
};

interface LobbyVoicePanelProps {
  voiceMgr: VoiceChatManager;
  voiceSnap: VoiceChatSnapshot;
  voiceVolume: number;
  onMasterVoiceToggle: (enabled: boolean) => void;
  onVoiceVolumeChange: (volume: number) => void;
}

export const LobbyVoicePanel: React.FC<LobbyVoicePanelProps> = ({
  voiceMgr,
  voiceSnap,
  voiceVolume,
  onMasterVoiceToggle,
  onVoiceVolumeChange,
}) => {
  const handleMicToggle = () => {
    voiceMgr.unlockAudioOutput();
    if (voiceSnap.micEnabled) {
      voiceMgr.disableMicrophone();
    } else {
      if (!voiceSnap.voiceActive) {
        onMasterVoiceToggle(true);
      }
      void voiceMgr.enableMicrophone();
    }
  };

  return (
    <div className="rounded-lg bg-[#0c1417] border border-[#294046] p-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Headphones
            className={`w-3.5 h-3.5 shrink-0 ${
              voiceSnap.voiceActive ? 'text-[#52e0b6]' : 'text-[#6c8389]'
            }`}
          />
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[#e4f2f4]">
              Squad Voice Chat
            </div>
            <div className="text-[9px] font-mono text-[#7c979e] truncate">
              {voiceSnap.voiceActive
                ? `LIVE WEBRTC · ${voiceSnap.connectedPeerCount} PEER${voiceSnap.connectedPeerCount === 1 ? '' : 'S'} LINKED`
                : 'VOICE CHAT DISABLED'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onMasterVoiceToggle(!voiceSnap.voiceActive)}
          className={`px-2 py-1 rounded-md border text-[10px] font-mono font-bold uppercase cursor-pointer transition-colors ${
            voiceSnap.voiceActive
              ? 'bg-[#113129] border-[#3d9c7e] text-[#8ef5d5]'
              : 'bg-[#1a2225] border-[#39484d] text-[#8fa5ab]'
          }`}
        >
          VOICE: {voiceSnap.voiceActive ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Primary Mic & Mute Controls */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={!voiceSnap.supported || voiceSnap.permissionStatus === 'requesting'}
          onClick={handleMicToggle}
          className={`flex-1 min-w-[110px] py-1.5 px-2.5 rounded-md border font-bold text-[11px] uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50 ${
            voiceSnap.micEnabled
              ? 'bg-[#52e0b6] hover:bg-[#6ef0c8] border-[#78f5cf] text-[#071113]'
              : 'bg-[#162428] hover:bg-[#1e3136] border-[#3b575e] text-[#e1f0f2]'
          }`}
        >
          {voiceSnap.micEnabled ? (
            <>
              <Mic className="w-3.5 h-3.5" />
              <span>Mic ON</span>
            </>
          ) : (
            <>
              <MicOff className="w-3.5 h-3.5" />
              <span>
                {voiceSnap.permissionStatus === 'requesting'
                  ? 'Requesting...'
                  : 'Enable Mic'}
              </span>
            </>
          )}
        </button>

        <button
          type="button"
          disabled={!voiceSnap.micEnabled}
          onClick={() => voiceMgr.setSelfMuted(!voiceSnap.selfMuted)}
          className={`py-1.5 px-2.5 rounded-md border font-bold text-[11px] uppercase tracking-wider flex items-center justify-center gap-1.5 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            voiceSnap.selfMuted
              ? 'bg-[#34181b] hover:bg-[#462024] border-[#9e444d] text-[#ffb6bd]'
              : 'bg-[#162226] hover:bg-[#1f2f34] border-[#374c52] text-[#d5e7ea]'
          }`}
        >
          {voiceSnap.selfMuted ? (
            <>
              <VolumeX className="w-3.5 h-3.5" />
              <span>Unmute</span>
            </>
          ) : (
            <>
              <Volume2 className="w-3.5 h-3.5" />
              <span>Mute</span>
            </>
          )}
        </button>
      </div>

      {/* Voice Volume & Live Input Meter */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
        <label className="flex flex-col gap-0.5 text-[10px] font-mono text-[#9eb6bc]">
          <div className="flex justify-between">
            <span>VOICE VOLUME</span>
            <span className="tabular-nums">{Math.round(voiceVolume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={voiceVolume}
            onChange={(e) => onVoiceVolumeChange(parseFloat(e.target.value))}
            className="horror-slider w-full"
          />
        </label>

        {voiceSnap.devices.length > 0 && (
          <label className="flex flex-col gap-0.5 text-[10px] font-mono text-[#9eb6bc]">
            <span>MICROPHONE INPUT</span>
            <select
              value={voiceSnap.selectedDeviceId}
              onChange={(e) => void voiceMgr.selectAudioDevice(e.target.value)}
              className="px-2 py-1 rounded-md bg-[#091012] border border-[#2a3b40] text-[11px] font-sans text-[#deedf0] focus:outline-none focus:border-[#52e0b6]"
            >
              <option value="">System Default Microphone</option>
              {voiceSnap.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Live local mic activity meter */}
      {voiceSnap.micEnabled && (
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-[#82a3aa] uppercase shrink-0">
            {voiceSnap.selfMuted
              ? 'SELF MUTED'
              : voiceSnap.speaking
                ? 'TRANSMITTING'
                : 'MIC ACTIVE'}
          </span>
          <div className="flex-1 h-1 rounded-full bg-[#172226] overflow-hidden">
            <div
              className="h-full transition-all duration-75"
              style={{
                width: `${voiceSnap.selfMuted ? 0 : Math.round(voiceSnap.micLevel * 100)}%`,
                backgroundColor: voiceSnap.speaking ? '#52e0b6' : '#6ea4ad',
              }}
            />
          </div>
        </div>
      )}

      {/* Platform-specific Permission Error / Setup Instructions */}
      {voiceSnap.permissionHelp && (
        <div className="rounded-md bg-[#291718] border border-[#8e3e45] p-2 flex flex-col gap-1.5 text-[11px] text-[#ffd2d6]">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-[#ff939c] shrink-0 mt-0.5" />
            <p className="leading-snug">{voiceSnap.permissionHelp}</p>
          </div>
          {voiceSnap.permissionStatus !== 'unsupported' && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void voiceMgr.enableMicrophone()}
                className="px-2.5 py-1 rounded bg-[#4a2125] hover:bg-[#5f2a2f] border border-[#a95058] text-[10px] font-mono font-bold uppercase text-[#ffe4e7] flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Retry Mic
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface InGameVoiceHudProps {
  voiceMgr: VoiceChatManager;
  voiceSnap: VoiceChatSnapshot;
  players: RoomPlayerInfo[];
  localUserId: string | null;
  voiceVolume: number;
  onMasterVoiceToggle: (enabled: boolean) => void;
  onVoiceVolumeChange: (volume: number) => void;
}

export const InGameVoiceHud: React.FC<InGameVoiceHudProps> = React.memo(({
  voiceMgr,
  voiceSnap,
  players,
  localUserId,
  voiceVolume,
  onMasterVoiceToggle,
  onVoiceVolumeChange,
}) => {
  const [expanded, setExpanded] = useState(false);

  const activeSpeakers = players.filter((p) => {
    if (p.userId === localUserId) {
      return voiceSnap.voiceActive && voiceSnap.micEnabled && !voiceSnap.selfMuted && voiceSnap.speaking;
    }
    if (voiceSnap.mutedPeerIds.includes(p.userId)) return false;
    return Boolean(p.voice?.voiceActive && p.voice?.micEnabled && !p.voice?.selfMuted && p.voice?.speaking);
  });

  const handleMicToggle = (e: React.PointerEvent | React.MouseEvent) => {
    e.stopPropagation();
    voiceMgr.unlockAudioOutput();
    if (voiceSnap.micEnabled) {
      voiceMgr.disableMicrophone();
    } else {
      if (!voiceSnap.voiceActive) {
        onMasterVoiceToggle(true);
      }
      void voiceMgr.enableMicrophone();
    }
  };

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-30 pointer-events-auto flex flex-col items-end gap-1 max-w-[calc(100vw-1.25rem)]"
      style={{
        top: 'max(0.5rem, env(safe-area-inset-top))',
        right: 'max(0.625rem, env(safe-area-inset-right))',
      }}
    >
      {/* Compact Voice Bar */}
      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0c1315]/90 border border-[#3c5258]/85 shadow-xl">
        {/* Mic ON/OFF Button */}
        <button
          type="button"
          onClick={handleMicToggle}
          title={voiceSnap.micEnabled ? 'Turn Microphone OFF' : 'Turn Microphone ON'}
          className={`h-7 sm:h-8 px-2 rounded-md border text-[10px] sm:text-[11px] font-mono font-bold flex items-center gap-1 cursor-pointer transition-colors ${
            voiceSnap.micEnabled
              ? voiceSnap.speaking && !voiceSnap.selfMuted
                ? 'bg-[#10382d] border-[#52e0b6] text-[#9cf8db]'
                : 'bg-[#15282c] border-[#427078] text-[#e0f2f4]'
              : 'bg-[#171f22] border-[#334348] text-[#95aeb4] hover:text-white'
          }`}
        >
          {voiceSnap.micEnabled ? (
            <Mic className="w-3.5 h-3.5" />
          ) : (
            <MicOff className="w-3.5 h-3.5 text-[#d67a72]" />
          )}
          <span className="hidden md:inline">
            {voiceSnap.micEnabled ? 'MIC ON' : 'MIC OFF'}
          </span>
        </button>

        {/* Quick Self-Mute Button */}
        {voiceSnap.micEnabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              voiceMgr.setSelfMuted(!voiceSnap.selfMuted);
            }}
            title={voiceSnap.selfMuted ? 'Unmute (V)' : 'Mute (V)'}
            className={`h-7 sm:h-8 px-2 rounded-md border text-[10px] sm:text-[11px] font-mono font-bold flex items-center gap-1 cursor-pointer transition-colors ${
              voiceSnap.selfMuted
                ? 'bg-[#35181b] border-[#a84852] text-[#ffb8be]'
                : 'bg-[#142226] border-[#395157] text-[#cbe2e6]'
            }`}
          >
            {voiceSnap.selfMuted ? (
              <VolumeX className="w-3.5 h-3.5" />
            ) : (
              <Volume2 className="w-3.5 h-3.5" />
            )}
            <span className="hidden lg:inline">{voiceSnap.selfMuted ? 'MUTED' : 'LIVE'}</span>
          </button>
        )}

        {/* Expand Squad Voice Drawer */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            voiceMgr.unlockAudioOutput();
            setExpanded((prev) => !prev);
          }}
          title="Squad Voice Panel"
          className={`h-7 sm:h-8 px-2 rounded-md border text-[10px] sm:text-[11px] font-mono flex items-center gap-1 cursor-pointer transition-colors ${
            voiceSnap.permissionHelp
              ? 'bg-[#351b1d] border-[#b04b53] text-[#ffbec3]'
              : 'bg-[#121c20] border-[#32464c] text-[#b4cdd2] hover:text-white'
          }`}
        >
          <Radio
            className={`w-3 h-3 ${
              activeSpeakers.length > 0 ? 'text-[#52e0b6] animate-pulse' : ''
            }`}
          />
          <span className="tabular-nums">
            {players.filter((p) => p.connected).length}
          </span>
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* Live Speaking Indicator Badges (compact, always visible when someone talks) */}
      {!expanded && activeSpeakers.length > 0 && (
        <div className="flex flex-col items-end gap-1 pointer-events-none">
          {activeSpeakers.slice(0, 3).map((sp) => (
            <div
              key={sp.userId}
              className="px-2 py-0.5 rounded-md bg-[#0d221d]/90 border border-[#49dbad]/75 text-[10px] font-mono text-[#a3f9dd] flex items-center gap-1 shadow-lg"
            >
              <Mic className="w-2.5 h-2.5 animate-pulse shrink-0" />
              <span className="truncate max-w-[100px]">{sp.username}</span>
            </div>
          ))}
        </div>
      )}

      {/* Expanded Squad Voice Drawer */}
      {expanded && (
        <div className="w-56 sm:w-64 rounded-lg bg-[#0c1417]/95 border border-[#344b52] p-2.5 shadow-2xl flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[#203136]">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[#e4f2f4]">
              Voice ({players.filter((p) => p.connected).length}/12)
            </span>
            <button
              type="button"
              onClick={() => onMasterVoiceToggle(!voiceSnap.voiceActive)}
              className={`px-2 py-0.5 rounded border text-[9px] font-mono font-bold uppercase cursor-pointer ${
                voiceSnap.voiceActive
                  ? 'bg-[#103028] border-[#3d9c7e] text-[#8ef5d5]'
                  : 'bg-[#1f282b] border-[#425156] text-[#9fb2b7]'
              }`}
            >
              {voiceSnap.voiceActive ? 'ON' : 'OFF'}
            </button>
          </div>

          <label className="flex flex-col gap-0.5 text-[10px] font-mono text-[#9eb6bc]">
            <div className="flex justify-between">
              <span>VOICE VOLUME</span>
              <span className="tabular-nums">{Math.round(voiceVolume * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={voiceVolume}
              onChange={(e) => onVoiceVolumeChange(parseFloat(e.target.value))}
              className="horror-slider w-full"
            />
          </label>

          {voiceSnap.permissionHelp && (
            <div className="rounded-md bg-[#291718] border border-[#8e3e45] p-2 flex flex-col gap-1 text-[10px] text-[#ffd2d6]">
              <p className="leading-snug">{voiceSnap.permissionHelp}</p>
              {voiceSnap.permissionStatus !== 'unsupported' && (
                <button
                  type="button"
                  onClick={() => void voiceMgr.enableMicrophone()}
                  className="self-end px-2 py-0.5 rounded bg-[#4a2125] border border-[#a95058] text-[9px] font-mono font-bold uppercase text-[#ffe4e7] cursor-pointer"
                >
                  Retry Mic
                </button>
              )}
            </div>
          )}

          {/* Squad Player Voice List */}
          <div className="flex flex-col gap-1 max-h-32 sm:max-h-40 overflow-y-auto pr-0.5">
            {players.map((p) => {
              const isSelf = p.userId === localUserId;
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
                  className="flex items-center justify-between gap-1.5 px-2 py-1 rounded-md bg-[#091012] border border-[#1d2c30]"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: p.avatarColor }}
                    />
                    <span className="text-[11px] font-semibold text-[#e2eff2] truncate">
                      {p.username}
                      {isSelf ? ' (You)' : ''}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <VoicePlayerBadge
                      voiceActive={v.voiceActive}
                      micEnabled={v.micEnabled}
                      selfMuted={v.selfMuted}
                      speaking={v.speaking}
                      locallyMuted={locallyMuted}
                    />
                    {!isSelf && (
                      <button
                        type="button"
                        onClick={() => voiceMgr.togglePeerMuted(p.userId)}
                        title={locallyMuted ? `Unmute ${p.username}` : `Mute ${p.username}`}
                        className={`p-1 rounded border cursor-pointer ${
                          locallyMuted
                            ? 'bg-[#35181b] border-[#8c4047] text-[#ffb5bc]'
                            : 'bg-[#142024] border-[#2c3f45] text-[#9eb8be] hover:text-white'
                        }`}
                      >
                        {locallyMuted ? (
                          <VolumeX className="w-3 h-3" />
                        ) : (
                          <Volume2 className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

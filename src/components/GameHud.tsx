import React from 'react';
import { Hand, Pause, Volume2, VolumeX } from 'lucide-react';
import { HudSnapshot } from '../game/types';

interface GameHudProps {
  hud: HudSnapshot;
  muted: boolean;
  showTouchControls?: boolean;
  onToggleMute: () => void;
  onPause: () => void;
  onPush?: () => void;
}

function formatTimer(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const secs = Math.floor(clamped % 60);
  const tenths = Math.floor((clamped % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, '0')}.${tenths}`;
}

export const GameHud: React.FC<GameHudProps> = React.memo(
  ({ hud, muted, showTouchControls = false, onToggleMute, onPause, onPush }) => {
    const isUrgent = hud.timeRemaining <= 15;
    const dangerRatio =
      hud.monsterDist < 22 ? Math.max(0, Math.min(1, 1 - (hud.monsterDist - 3) / 19)) : 0;
    const pushCooling = hud.pushCooldown > 0.05;
    const pushPct = pushCooling
      ? Math.max(0, Math.min(100, (1 - hud.pushCooldown / Math.max(0.1, hud.pushMaxCooldown)) * 100))
      : 100;

    return (
      <div className="fixed inset-0 pointer-events-none z-10 overflow-hidden">
        {/* Underwater or Monster Danger Edge Vignette (pure CSS gradient, no backdrop-filter) */}
        <div
          className="absolute inset-0 transition-opacity duration-200"
          style={{
            opacity: hud.underwater ? 0.85 : dangerRatio * 0.75,
            background: hud.underwater
              ? 'radial-gradient(circle at center, rgba(14,48,54,0.12) 35%, rgba(6,24,29,0.82) 100%)'
              : 'radial-gradient(circle at center, transparent 52%, rgba(135,18,22,0.58) 100%)',
          }}
        />

        {/* Top-Left: Status Cluster & Action Icons */}
        <div
          className="absolute flex flex-col gap-1 sm:gap-1.5"
          style={{
            top: 'max(0.5rem, env(safe-area-inset-top))',
            left: 'max(0.625rem, env(safe-area-inset-left))',
          }}
        >
          <div className="flex items-center gap-1.5 pointer-events-auto">
            <button
              type="button"
              onClick={onPause}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-md bg-[#0c1315]/85 border border-[#495c61]/70 hover:border-[#9ec5c8] text-[#dce8ea] flex items-center justify-center transition-colors"
              title="Pause (ESC)"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleMute}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-md bg-[#0c1315]/85 border border-[#495c61]/70 hover:border-[#9ec5c8] text-[#dce8ea] flex items-center justify-center transition-colors"
              title={muted ? 'Unmute Audio' : 'Mute Audio'}
            >
              {muted ? (
                <VolumeX className="w-3.5 h-3.5 text-[#e0746a]" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )}
            </button>
            <div className="px-2 py-1 rounded-md bg-[#0c1315]/85 border border-[#3a4a4e]/70 text-[10px] sm:text-[11px] font-mono tracking-wider text-[#9db4b9]">
              {hud.levelCode}
              <span className="hidden md:inline"> · {hud.levelName.toUpperCase()}</span>
            </div>
          </div>

          {/* Stamina & Threat Bars */}
          <div className="w-32 sm:w-40 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-md bg-[#0c1315]/80 border border-[#314044]/70 flex flex-col gap-0.5 sm:gap-1">
            <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-mono text-[#96aeb3]">
              <span>STAMINA</span>
              <span className="tabular-nums">{hud.stamina}%</span>
            </div>
            <div className="h-1 w-full rounded-full bg-[#1a2528] overflow-hidden">
              <div
                className="h-full transition-all duration-100"
                style={{
                  width: `${hud.stamina}%`,
                  backgroundColor: hud.stamina < 25 ? '#d96b52' : '#7dd3c8',
                }}
              />
            </div>

            <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-mono pt-0.5">
              <span className="text-[#879ea3]">
                {hud.inWater ? 'SWIMMING' : 'DRY'}
              </span>
              <span
                className="font-semibold"
                style={{
                  color:
                    hud.monsterAlert === 'chasing'
                      ? '#f06868'
                      : hud.monsterAlert === 'searching'
                        ? '#e8b354'
                        : '#7fa1a8',
                }}
              >
                {hud.monsterAlert === 'chasing'
                  ? 'HUNTING'
                  : hud.monsterAlert === 'searching'
                    ? 'ALERTED'
                    : `${hud.monsterDist}M`}
              </span>
            </div>

            {hud.inWater && (
              <div className="flex flex-col gap-0.5 pt-0.5">
                <div className="flex items-center justify-between text-[9px] font-mono">
                  <span className="text-[#879ea3]">WATER JUMP</span>
                  <span
                    className="tabular-nums font-semibold"
                    style={{
                      color: hud.waterJumpCooldown > 0.05 ? '#e8b354' : '#7dd3c8',
                    }}
                  >
                    {hud.waterJumpCooldown > 0.05
                      ? `${hud.waterJumpCooldown.toFixed(1)}S`
                      : 'READY'}
                  </span>
                </div>
                <div className="h-1 w-full rounded-full bg-[#1a2528] overflow-hidden">
                  <div
                    className="h-full transition-all duration-75"
                    style={{
                      width: `${Math.max(0, Math.min(100, (1 - hud.waterJumpCooldown / 2) * 100))}%`,
                      backgroundColor: hud.waterJumpCooldown > 0.05 ? '#e8b354' : '#7dd3c8',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Top-Center: Countdown Timer */}
        <div
          className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1"
          style={{ top: 'max(0.5rem, env(safe-area-inset-top))' }}
        >
          <div
            className={`px-2.5 py-0.5 sm:px-3.5 sm:py-1 rounded-md sm:rounded-lg border font-mono text-sm sm:text-lg font-bold tracking-wider tabular-nums shadow-lg ${
              isUrgent
                ? 'bg-[#2b1012]/90 border-[#e05252] text-[#ff9e9e]'
                : 'bg-[#0c1315]/85 border-[#415358]/80 text-[#e4f0f2]'
            }`}
          >
            {formatTimer(hud.timeRemaining)}
          </div>
          {hud.totalCheckpoints > 0 && (
            <div className="px-1.5 py-0.5 rounded bg-[#0c1315]/80 border border-[#314044]/70 text-[9px] sm:text-[10px] font-mono text-[#8eb3ba] tabular-nums">
              CP {hud.checkpointIndex}/{hud.totalCheckpoints}
            </div>
          )}
        </div>

        {/* Top-Right: Mouse Look Hint (desktop only) */}
        <div
          className="hidden lg:flex absolute px-2.5 py-1 rounded-md bg-[#0c1315]/75 border border-[#314044]/60 text-[10px] font-mono text-[#8ca3a8]"
          style={{
            top: 'max(0.5rem, env(safe-area-inset-top))',
            right: 'max(0.75rem, env(safe-area-inset-right))',
          }}
        >
          {hud.isPointerLocked ? 'ESC TO PAUSE' : 'CLICK SCENE OR DRAG TO LOOK'}
        </div>

        {/* Transient Checkpoint Banner */}
        {hud.checkpointNotice && (
          <div className="absolute top-14 sm:top-16 left-1/2 -translate-x-1/2 px-3 py-1 rounded-md bg-[#102923]/92 border border-[#4ef2b8]/80 text-[#9cf7d7] font-mono text-[10px] sm:text-[11px] tracking-widest uppercase shadow-lg">
            {hud.checkpointNotice}
          </div>
        )}

        {/* PC Friends-Mode-only Push Button */}
        {hud.isMultiplayer && !showTouchControls && (
          <div className="absolute bottom-5 right-5 pointer-events-auto">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onPush?.();
              }}
              title="Push nearby friend (F)"
              className={`relative overflow-hidden px-3 py-2 rounded-xl border flex items-center gap-2 font-mono text-xs font-bold uppercase shadow-lg cursor-pointer transition-colors ${
                pushCooling
                  ? 'bg-[#191c1a]/90 border-[#e8b354]/60 text-[#e8cf97]'
                  : hud.canPushTarget
                    ? 'bg-[#2e200d]/92 border-[#ffbe55] text-[#ffe6b0] shadow-[0_0_16px_rgba(255,190,85,0.35)]'
                    : 'bg-[#0c1315]/88 border-[#3b4e54]/85 text-[#b5ccd1] hover:border-[#7dd3c8]/75'
              }`}
            >
              {pushCooling && (
                <span
                  className="absolute inset-x-0 bottom-0 bg-[#e8b354]/20 pointer-events-none"
                  style={{ height: `${pushPct}%` }}
                />
              )}
              <Hand className="relative z-10 w-3.5 h-3.5 shrink-0" />
              <span className="relative z-10">PUSH</span>
              <span className="relative z-10 px-1.5 py-0.5 rounded bg-[#142024] border border-[#3a4f55] text-[10px] text-[#dcecef]">
                F
              </span>
              {pushCooling && (
                <span className="relative z-10 tabular-nums text-[10px] text-[#f3cf80]">
                  {hud.pushCooldown.toFixed(1)}s
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    );
  }
);

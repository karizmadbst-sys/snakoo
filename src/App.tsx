import { useCallback, useEffect, useRef, useState } from 'react';
import { GameHud } from './components/GameHud';
import { LandscapeGuard } from './components/LandscapeGuard';
import { LoadingOverlay } from './components/LoadingOverlay';
import {
  computeStars,
  GameOverModal,
  isLevelUnlocked,
  LevelSelectModal,
  MainMenu,
  PauseModal,
  SettingsModal,
  VictoryModal,
} from './components/Modals';
import {
  InviteNotifications,
  MultiplayerModal,
  MultiplayerResultModal,
  MultiplayerStatusPill,
} from './components/MultiplayerModal';
import { TouchControls, TouchControlsCustomizer } from './components/TouchControls';
import { InGameVoiceHud } from './components/VoiceControls';
import { setCharacterPreviewPaused } from './game/characterPreview';
import { PoolGameEngine } from './game/engine';
import { getLevelSummary, LEVEL_CATALOG, TOTAL_LEVELS } from './game/levels';
import { preloadCoreAssets, waitAnimationFrames } from './game/preloader';
import {
  CharacterId,
  DEFAULT_SETTINGS,
  DEFAULT_TOUCH_LAYOUT,
  GamePhase,
  GameSettings,
  HudSnapshot,
  normalizeCharacterId,
  normalizeQualityPreset,
  SaveData,
  TouchControlPlacement,
  TouchLayoutConfig,
} from './game/types';
import { MultiplayerClient, type MultiplayerSnapshot } from './multiplayer/client';
import type { MatchResultSummary, WorldSyncPayload } from './multiplayer/types';
import { VoiceChatManager, type VoiceChatSnapshot } from './multiplayer/voice';

const STORAGE_SAVE_KEY = 'deep_tile_save_v1';
const STORAGE_SETTINGS_KEY = 'deep_tile_settings_v1';
const STORAGE_TOUCH_LAYOUT_KEY = 'deep_tile_touch_layout_v1';
const STORAGE_CHARACTER_KEY = 'deep_tile_character_v1';

function loadCharacterId(): CharacterId {
  try {
    return normalizeCharacterId(localStorage.getItem(STORAGE_CHARACTER_KEY));
  } catch {
    return 'male';
  }
}

function loadSaveData(): SaveData {
  try {
    const raw = localStorage.getItem(STORAGE_SAVE_KEY);
    return raw ? (JSON.parse(raw) as SaveData) : {};
  } catch {
    return {};
  }
}

function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      quality: normalizeQualityPreset(parsed.quality),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function sanitizePlacement(
  raw: Partial<TouchControlPlacement> | undefined,
  fallback: TouchControlPlacement
): TouchControlPlacement {
  const num = (v: unknown, def: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  return {
    xPct: num(raw?.xPct, fallback.xPct, 5, 95),
    yPct: num(raw?.yPct, fallback.yPct, 14, 93),
    scale: num(raw?.scale, fallback.scale, 0.65, 1.45),
    opacity: num(raw?.opacity, fallback.opacity, 0.3, 1),
  };
}

function loadTouchLayout(): TouchLayoutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_TOUCH_LAYOUT_KEY);
    if (!raw) return DEFAULT_TOUCH_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<TouchLayoutConfig>;
    return {
      joystick: sanitizePlacement(parsed.joystick, DEFAULT_TOUCH_LAYOUT.joystick),
      autoRun: sanitizePlacement(parsed.autoRun, DEFAULT_TOUCH_LAYOUT.autoRun),
      jump: sanitizePlacement(parsed.jump, DEFAULT_TOUCH_LAYOUT.jump),
      push: sanitizePlacement(parsed.push, DEFAULT_TOUCH_LAYOUT.push),
    };
  } catch {
    return DEFAULT_TOUCH_LAYOUT;
  }
}

const INITIAL_LEVEL_META = getLevelSummary(1);

const INITIAL_HUD: HudSnapshot = {
  levelId: 1,
  levelCode: INITIAL_LEVEL_META.code,
  levelName: INITIAL_LEVEL_META.name,
  timeRemaining: INITIAL_LEVEL_META.timeLimit,
  timeElapsed: 0,
  stamina: 100,
  inWater: false,
  underwater: false,
  waterJumpCooldown: 0,
  monsterDist: 30,
  monsterAlert: 'calm',
  checkpointIndex: 0,
  totalCheckpoints: 1,
  checkpointNotice: null,
  activeQuality: 'standard',
  fps: 60,
  isPointerLocked: false,
  deathReason: null,
  isMultiplayer: false,
  pushCooldown: 0,
  pushMaxCooldown: 2.5,
  canPushTarget: false,
};

export default function App() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PoolGameEngine | null>(null);
  const mpClientRef = useRef<MultiplayerClient | null>(null);
  if (!mpClientRef.current) {
    mpClientRef.current = new MultiplayerClient();
  }
  const mpClient = mpClientRef.current;

  const [phase, setPhase] = useState<GamePhase>('menu');
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [characterId, setCharacterId] = useState<CharacterId>(() => loadCharacterId());
  const [touchLayout, setTouchLayout] = useState<TouchLayoutConfig>(() => loadTouchLayout());
  const [saveData, setSaveData] = useState<SaveData>(() => loadSaveData());
  const [showLevels, setShowLevels] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTouchCustomizer, setShowTouchCustomizer] = useState(false);
  const [returnToSettingsAfterCustomize, setReturnToSettingsAfterCustomize] = useState(false);
  const [showMultiplayer, setShowMultiplayer] = useState(false);
  const [deathReason, setDeathReason] = useState<'caught' | 'timeout'>('caught');
  const [victoryElapsed, setVictoryElapsed] = useState(0);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [isPortraitBlocked, setIsPortraitBlocked] = useState(false);

  // Multiplayer runtime state
  const [mpSnap, setMpSnap] = useState<MultiplayerSnapshot>(() => mpClient.getSnapshot());
  const voiceMgrRef = useRef<VoiceChatManager | null>(null);
  if (!voiceMgrRef.current) {
    voiceMgrRef.current = new VoiceChatManager(
      mpClient,
      settings.voiceEnabled,
      settings.voiceVolume
    );
  }
  const voiceMgr = voiceMgrRef.current;
  const [voiceSnap, setVoiceSnap] = useState<VoiceChatSnapshot>(() => voiceMgr.getSnapshot());
  const [isMultiplayerMatch, setIsMultiplayerMatch] = useState(false);
  const [mpLocalStatus, setMpLocalStatus] = useState<'playing' | 'caught' | 'escaped'>('playing');
  const [mpAliveCount, setMpAliveCount] = useState(0);
  const [mpTotalCount, setMpTotalCount] = useState(0);
  const [mpMatchResult, setMpMatchResult] = useState<MatchResultSummary | null>(null);

  // Loading & seamless scene transition overlay state
  const [loadingOverlay, setLoadingOverlay] = useState<{
    visible: boolean;
    fadingOut: boolean;
    progress: number;
    label: string;
    sublabel?: string;
  }>({
    visible: true,
    fadingOut: false,
    progress: 12,
    label: 'INITIALIZING FACILITY 09...',
    sublabel: 'LOADING INTERFACE & ASSETS',
  });
  const [isTransitioningToPlay, setIsTransitioningToPlay] = useState(false);

  const activeLevelIdRef = useRef<number>(1);
  const latestElapsedRef = useRef<number>(0);
  const isMpMatchRef = useRef<boolean>(false);
  isMpMatchRef.current = isMultiplayerMatch;
  const transitionTokenRef = useRef<number>(0);
  const fadeTimerRef = useRef<number | null>(null);
  const isPreparingMpRef = useRef<boolean>(false);
  const pendingWorldSyncRef = useRef<WorldSyncPayload | null>(null);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimerRef.current !== null) {
      window.clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const beginLoadingTransition = useCallback(
    (label: string, sublabel?: string, initialProgress = 14): number => {
      clearFadeTimer();
      transitionTokenRef.current += 1;
      const token = transitionTokenRef.current;
      setLoadingOverlay({
        visible: true,
        fadingOut: false,
        progress: initialProgress,
        label,
        sublabel,
      });
      return token;
    },
    [clearFadeTimer]
  );

  const updateLoadingProgress = useCallback((token: number, progress: number, label?: string) => {
    if (transitionTokenRef.current !== token) return;
    setLoadingOverlay((prev) => ({
      ...prev,
      progress: Math.max(prev.progress, progress),
      label: label ?? prev.label,
    }));
  }, []);

  const finishLoadingTransition = useCallback(
    (token: number) => {
      if (transitionTokenRef.current !== token) return;
      clearFadeTimer();
      setLoadingOverlay((prev) => ({
        ...prev,
        progress: 100,
        fadingOut: true,
      }));
      fadeTimerRef.current = window.setTimeout(() => {
        fadeTimerRef.current = null;
        if (transitionTokenRef.current !== token) return;
        setLoadingOverlay((prev) => ({ ...prev, visible: false, fadingOut: false }));
      }, 220);
    },
    [clearFadeTimer]
  );

  const abortLoadingTransition = useCallback(() => {
    clearFadeTimer();
    transitionTokenRef.current += 1;
    isPreparingMpRef.current = false;
    pendingWorldSyncRef.current = null;
    setIsTransitioningToPlay(false);
    setLoadingOverlay((prev) => (prev.visible ? { ...prev, visible: false, fadingOut: false } : prev));
  }, [clearFadeTimer]);

  useEffect(() => {
    return () => clearFadeTimer();
  }, [clearFadeTimer]);

  useEffect(() => {
    const hasTouch =
      'ontouchstart' in window || navigator.maxTouchPoints > 0;
    setIsTouchDevice(hasTouch);
  }, []);

  // Mount Three.js engine once in isolated container
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    const engine = new PoolGameEngine(host, settings, {
      onHudUpdate: (snapshot) => {
        activeLevelIdRef.current = snapshot.levelId;
        latestElapsedRef.current = snapshot.timeElapsed;
        setHud(snapshot);
      },
      onPhaseChange: (nextPhase, extra) => {
        setPhase(nextPhase);
        if (extra?.deathReason) {
          setDeathReason(extra.deathReason);
        }
        if (nextPhase === 'victory' && extra?.elapsed != null && !isMpMatchRef.current) {
          const lvlId = activeLevelIdRef.current;
          const lvl = getLevelSummary(lvlId);
          const stars = computeStars(lvl, extra.elapsed);
          setVictoryElapsed(extra.elapsed);

          setSaveData((prev) => {
            const existing = prev[lvlId];
            const bestTime =
              existing?.bestTime != null
                ? Math.min(existing.bestTime, extra.elapsed!)
                : extra.elapsed!;
            const nextSave: SaveData = {
              ...prev,
              [lvlId]: {
                completed: true,
                bestTime,
                stars: Math.max(existing?.stars || 0, stars),
              },
            };
            try {
              localStorage.setItem(STORAGE_SAVE_KEY, JSON.stringify(nextSave));
            } catch {
              // ignore quota errors
            }
            return nextSave;
          });
        }
      },
      onMultiplayerTick: (pkt) => {
        mpClient.sendPlayerInputState(pkt);
      },
      onMultiplayerPush: (pkt) => {
        mpClient.sendPush(pkt);
      },
      onMultiplayerCaught: () => {
        setMpLocalStatus('caught');
      },
      onMultiplayerEscaped: () => {
        setMpLocalStatus('escaped');
        const lvlId = activeLevelIdRef.current;
        const elapsed = Math.max(1, Math.round(latestElapsedRef.current * 10) / 10);
        const lvl = getLevelSummary(lvlId);
        const stars = computeStars(lvl, elapsed);
        setSaveData((prev) => {
          const existing = prev[lvlId];
          const bestTime =
            existing?.bestTime != null ? Math.min(existing.bestTime, elapsed) : elapsed;
          const nextSave: SaveData = {
            ...prev,
            [lvlId]: {
              completed: true,
              bestTime,
              stars: Math.max(existing?.stars || 0, stars),
            },
          };
          try {
            localStorage.setItem(STORAGE_SAVE_KEY, JSON.stringify(nextSave));
          } catch {
            // ignore quota errors
          }
          return nextSave;
        });
      },
    }, characterId);

    engineRef.current = engine;

    // Preload and decode all core interface assets (icon, menu background, character slot portraits)
    // before revealing the main interface so nothing ever flashes blank or disappears.
    const bootToken = transitionTokenRef.current;
    void (async () => {
      await preloadCoreAssets((pct, label) => {
        updateLoadingProgress(bootToken, pct, label);
      });
      if (transitionTokenRef.current !== bootToken) return;
      engine.renderImmediateReadyFrame();
      await waitAnimationFrames(2);
      finishLoadingTransition(bootToken);
    })();

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connect & subscribe to real-time MultiplayerClient events
  useEffect(() => {
    const unsubSnap = mpClient.subscribe((snap) => {
      setMpSnap(snap);
      if ((isMpMatchRef.current || isPreparingMpRef.current) && snap.room && snap.room.status === 'lobby') {
        abortLoadingTransition();
        setIsMultiplayerMatch(false);
        setMpMatchResult(null);
        setMpLocalStatus('playing');
        setPhase('menu');
        setShowMultiplayer(true);
        engineRef.current?.exitMultiplayerMode();
        engineRef.current?.showMenuBackdrop(snap.room.levelId);
      }
    });

    const unsubStart = mpClient.onGameStarted((payload) => {
      const uid = mpClient.getSnapshot().user?.id;
      if (!uid) return;
      const lvl = getLevelSummary(payload.levelId);
      const token = beginLoadingTransition(
        `SYNCHRONIZING ${lvl.code}...`,
        lvl.name.toUpperCase(),
        14
      );
      isPreparingMpRef.current = true;
      pendingWorldSyncRef.current = null;
      setIsTransitioningToPlay(true);

      void (async () => {
        await waitAnimationFrames(1);
        if (transitionTokenRef.current !== token) return;

        await preloadCoreAssets();
        if (transitionTokenRef.current !== token) return;

        const engine = engineRef.current;
        if (engine) {
          await engine.prepareMultiplayerLevelAsync(
            payload.levelId,
            uid,
            payload.players,
            payload.monsters,
            payload.elapsedSec ?? 0,
            (pct, label) => updateLoadingProgress(token, pct, label)
          );
          if (transitionTokenRef.current !== token) return;

          if (pendingWorldSyncRef.current) {
            engine.applyMultiplayerWorld(pendingWorldSyncRef.current);
            pendingWorldSyncRef.current = null;
            engine.renderImmediateReadyFrame();
          }
        }

        if (transitionTokenRef.current !== token) return;
        isPreparingMpRef.current = false;
        setShowMultiplayer(false);
        setShowLevels(false);
        setShowSettings(false);
        setMpMatchResult(null);
        setMpLocalStatus('playing');
        setMpAliveCount(payload.players.filter((p) => p.alive && !p.escaped).length);
        setMpTotalCount(payload.players.length);
        setIsMultiplayerMatch(true);
        setPhase('playing');
        setIsTransitioningToPlay(false);

        await waitAnimationFrames(2);
        finishLoadingTransition(token);
      })();
    });

    const unsubWorld = mpClient.onWorldSync((world) => {
      if (isPreparingMpRef.current) {
        pendingWorldSyncRef.current = world;
        return;
      }
      engineRef.current?.applyMultiplayerWorld(world);
      let aliveCount = 0;
      for (let i = 0; i < world.players.length; i++) {
        const p = world.players[i];
        if (p.alive && !p.escaped) aliveCount++;
      }
      setMpAliveCount((prev) => (prev === aliveCount ? prev : aliveCount));
      setMpTotalCount((prev) => (prev === world.players.length ? prev : world.players.length));
      if (world.matchResult) {
        setMpMatchResult((prev) => prev ?? world.matchResult!);
      }
    });

    const unsubPlayerEvent = mpClient.onPlayerEvent((ev) => {
      if (isPreparingMpRef.current) return;
      engineRef.current?.handleMultiplayerPlayerEvent(ev);
    });

    const unsubNotice = mpClient.onRoomNotice(() => {
      if (isMpMatchRef.current || isPreparingMpRef.current) {
        abortLoadingTransition();
        setIsMultiplayerMatch(false);
        setMpMatchResult(null);
        setMpLocalStatus('playing');
        setPhase('menu');
        setShowMultiplayer(true);
        engineRef.current?.exitMultiplayerMode();
        engineRef.current?.showMenuBackdrop(1);
      }
    });

    void mpClient.restoreSession();

    return () => {
      unsubSnap();
      unsubStart();
      unsubWorld();
      unsubPlayerEvent();
      unsubNotice();
      mpClient.dispose();
    };
  }, [mpClient, abortLoadingTransition, beginLoadingTransition, finishLoadingTransition, updateLoadingProgress]);

  // VoiceChatManager lifecycle & room-scoped synchronization
  useEffect(() => {
    const unsubVoice = voiceMgr.subscribe(setVoiceSnap);
    return () => {
      unsubVoice();
      voiceMgr.dispose();
    };
  }, [voiceMgr]);

  useEffect(() => {
    voiceMgr.syncRoomContext(mpSnap.user?.id || null, mpSnap.room);
  }, [voiceMgr, mpSnap.user?.id, mpSnap.room]);

  useEffect(() => {
    if (isMultiplayerMatch && mpMatchResult && phase !== 'jumpscare' && phase !== 'paused') {
      engineRef.current?.setPhase('paused');
      setPhase('paused');
    }
  }, [isMultiplayerMatch, mpMatchResult, phase]);

  // Pause 3D rendering whenever full-screen modals or portrait orientation lock completely occlude the viewport
  useEffect(() => {
    const occluded =
      !isTransitioningToPlay &&
      (isPortraitBlocked || showMultiplayer || showLevels || showSettings || showTouchCustomizer);
    engineRef.current?.setOverlayOccluded(occluded);
  }, [isTransitioningToPlay, isPortraitBlocked, showMultiplayer, showLevels, showSettings, showTouchCustomizer]);

  // Never allow offscreen character-preview WebGL rendering to run during active gameplay
  useEffect(() => {
    setCharacterPreviewPaused(phase === 'playing' || phase === 'jumpscare');
  }, [phase]);

  // Auto-pause active single-player run if mobile device rotates to portrait
  useEffect(() => {
    if (isPortraitBlocked && phase === 'playing' && !isMpMatchRef.current) {
      setPhase('paused');
      engineRef.current?.setPhase('paused');
    }
  }, [isPortraitBlocked, phase]);

  const handleSettingsChange = useCallback(
    (next: GameSettings) => {
      setSettings(next);
      engineRef.current?.updateSettings(next);
      voiceMgr.setVoiceActive(next.voiceEnabled);
      voiceMgr.setVoiceVolume(next.voiceVolume);
      try {
        localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [voiceMgr]
  );

  const handleCharacterChange = useCallback((next: CharacterId) => {
    const normalized = normalizeCharacterId(next);
    setCharacterId(normalized);
    engineRef.current?.setCharacter(normalized);
    try {
      localStorage.setItem(STORAGE_CHARACTER_KEY, normalized);
    } catch {
      // ignore
    }
  }, []);

  const handleToggleMute = useCallback(() => {
    handleSettingsChange({ ...settings, muted: !settings.muted });
  }, [settings, handleSettingsChange]);

  const handleMasterVoiceToggle = useCallback(
    (enabled: boolean) => {
      handleSettingsChange({ ...settings, voiceEnabled: enabled });
    },
    [settings, handleSettingsChange]
  );

  const handleVoiceVolumeChange = useCallback(
    (volume: number) => {
      handleSettingsChange({ ...settings, voiceVolume: volume });
    },
    [settings, handleSettingsChange]
  );

  const handleStartLevel = useCallback(
    (levelId: number) => {
      const targetId = isLevelUnlocked(levelId, saveData) ? levelId : 1;
      const lvl = getLevelSummary(targetId);
      const token = beginLoadingTransition(
        `PREPARING ${lvl.code}...`,
        lvl.name.toUpperCase(),
        14
      );
      setIsTransitioningToPlay(true);

      void (async () => {
        await waitAnimationFrames(1);
        if (transitionTokenRef.current !== token) return;

        await preloadCoreAssets();
        if (transitionTokenRef.current !== token) return;

        const engine = engineRef.current;
        if (engine) {
          await engine.prepareLevelAsync(targetId, (pct, label) =>
            updateLoadingProgress(token, pct, label)
          );
        }
        if (transitionTokenRef.current !== token) return;

        setIsMultiplayerMatch(false);
        setMpMatchResult(null);
        setShowLevels(false);
        setShowSettings(false);
        setShowMultiplayer(false);
        setPhase('playing');
        setIsTransitioningToPlay(false);

        await waitAnimationFrames(2);
        finishLoadingTransition(token);
      })();
    },
    [saveData, beginLoadingTransition, updateLoadingProgress, finishLoadingTransition]
  );

  const handleRestart = useCallback(() => {
    if (isMpMatchRef.current) return;
    const lvl = getLevelSummary(activeLevelIdRef.current);
    const token = beginLoadingTransition(`RESTARTING ${lvl.code}...`, lvl.name.toUpperCase(), 20);
    setIsTransitioningToPlay(true);

    void (async () => {
      await waitAnimationFrames(1);
      if (transitionTokenRef.current !== token) return;

      const engine = engineRef.current;
      if (engine) {
        await engine.restartLevelAsync((pct, label) => updateLoadingProgress(token, pct, label));
      }
      if (transitionTokenRef.current !== token) return;

      setPhase('playing');
      setIsTransitioningToPlay(false);

      await waitAnimationFrames(2);
      finishLoadingTransition(token);
    })();
  }, [beginLoadingTransition, updateLoadingProgress, finishLoadingTransition]);

  const handleRespawnCheckpoint = useCallback(() => {
    if (isMpMatchRef.current) return;
    setPhase('playing');
    engineRef.current?.respawnAtCheckpoint();
  }, []);

  const handlePause = useCallback(() => {
    setPhase('paused');
    engineRef.current?.setPhase('paused');
  }, []);

  const handleResume = useCallback(() => {
    setShowSettings(false);
    setShowLevels(false);
    setPhase('playing');
    engineRef.current?.setPhase('playing');
  }, []);

  const handleQuitToMenu = useCallback(() => {
    abortLoadingTransition();
    if (isMpMatchRef.current) {
      mpClient.leaveRoom();
      setIsMultiplayerMatch(false);
      setMpMatchResult(null);
      setMpLocalStatus('playing');
      engineRef.current?.exitMultiplayerMode();
    }
    setShowSettings(false);
    setShowLevels(false);
    setPhase('menu');
    engineRef.current?.showMenuBackdrop(1);
  }, [mpClient, abortLoadingTransition]);

  const handleVirtualMove = useCallback((x: number, y: number, run: boolean) => {
    engineRef.current?.setVirtualInput(x, y, run);
  }, []);

  const handleVirtualAutoRun = useCallback((enabled: boolean) => {
    engineRef.current?.setVirtualAutoRun(enabled);
  }, []);

  const handleVirtualJump = useCallback(() => {
    engineRef.current?.triggerJump();
  }, []);

  const handleVirtualPush = useCallback(() => {
    engineRef.current?.triggerPush();
  }, []);

  const handleVirtualCamDelta = useCallback((dx: number, dy: number) => {
    engineRef.current?.rotateCameraByDelta(dx, dy);
  }, []);

  const handleOpenCustomizeControls = useCallback(() => {
    setReturnToSettingsAfterCustomize(true);
    setShowSettings(false);
    setShowTouchCustomizer(true);
  }, []);

  const handleSaveTouchLayout = useCallback(
    (nextLayout: TouchLayoutConfig) => {
      setTouchLayout(nextLayout);
      try {
        localStorage.setItem(STORAGE_TOUCH_LAYOUT_KEY, JSON.stringify(nextLayout));
      } catch {
        // ignore quota errors
      }
      setShowTouchCustomizer(false);
      if (returnToSettingsAfterCustomize) {
        setShowSettings(true);
        setReturnToSettingsAfterCustomize(false);
      }
    },
    [returnToSettingsAfterCustomize]
  );

  const handleCancelTouchLayout = useCallback(() => {
    setShowTouchCustomizer(false);
    if (returnToSettingsAfterCustomize) {
      setShowSettings(true);
      setReturnToSettingsAfterCustomize(false);
    }
  }, [returnToSettingsAfterCustomize]);

  const handleOpenLevels = useCallback(() => setShowLevels(true), []);
  const handleCloseLevels = useCallback(() => setShowLevels(false), []);
  const handleOpenSettings = useCallback(() => setShowSettings(true), []);
  const handleCloseSettings = useCallback(() => setShowSettings(false), []);
  const handleOpenMultiplayer = useCallback(() => setShowMultiplayer(true), []);
  const handleCloseMultiplayer = useCallback(() => setShowMultiplayer(false), []);
  const handleOpenLevelsFromPause = useCallback(() => {
    if (!isMpMatchRef.current) setShowLevels(true);
  }, []);

  // Determine current unlocked frontier sector for Main Menu CTA
  const continueLevelId = (() => {
    for (const lvl of LEVEL_CATALOG) {
      if (!saveData[lvl.id]?.completed && isLevelUnlocked(lvl.id, saveData)) return lvl.id;
    }
    return TOTAL_LEVELS;
  })();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement | null)?.tagName;
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT') return;
      if (loadingOverlay.visible && !loadingOverlay.fadingOut) return;
      if (showLevels || showSettings || showMultiplayer || showTouchCustomizer) return;
      if (phase === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        handleStartLevel(continueLevelId);
      } else if (phase === 'gameover' && !isMpMatchRef.current && (e.code === 'KeyR' || e.code === 'Enter')) {
        e.preventDefault();
        handleRestart();
      } else if (phase === 'playing' && isMpMatchRef.current && e.code === 'KeyV') {
        e.preventDefault();
        const cur = voiceMgr.getSnapshot();
        if (cur.micEnabled) {
          voiceMgr.setSelfMuted(!cur.selfMuted);
        } else {
          if (!cur.voiceActive) handleMasterVoiceToggle(true);
          void voiceMgr.enableMicrophone();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    phase,
    loadingOverlay.visible,
    loadingOverlay.fadingOut,
    showLevels,
    showSettings,
    showMultiplayer,
    showTouchCustomizer,
    continueLevelId,
    handleStartLevel,
    handleRestart,
    voiceMgr,
    handleMasterVoiceToggle,
  ]);

  const currentLevel = getLevelSummary(hud.levelId);
  const showTouch =
    phase === 'playing' &&
    !showLevels &&
    !showSettings &&
    !showTouchCustomizer &&
    !showMultiplayer &&
    !mpMatchResult &&
    (!isMultiplayerMatch || mpLocalStatus === 'playing') &&
    (settings.touchControls === 'on' ||
      (settings.touchControls === 'auto' && isTouchDevice));

  const mpBadgeCount = mpSnap.pendingInvites.length + mpSnap.incomingRequests.length;

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0b1012]">
      {/* Isolated WebGL Canvas Host */}
      <div ref={canvasHostRef} className="game-canvas-host absolute inset-0 z-0" />

      {/* Live Room Invite Toast Notifications */}
      {!isMultiplayerMatch && (
        <InviteNotifications
          invites={mpSnap.pendingInvites}
          onAccept={(id) => {
            mpClient.respondToInvite(id, true);
            setShowMultiplayer(true);
          }}
          onDecline={(id) => mpClient.respondToInvite(id, false)}
        />
      )}

      {/* Main Menu */}
      {phase === 'menu' && (
        <MainMenu
          continueLevelId={continueLevelId}
          characterId={characterId}
          onCharacterChange={handleCharacterChange}
          onPlay={handleStartLevel}
          onOpenLevels={handleOpenLevels}
          onOpenSettings={handleOpenSettings}
          onOpenMultiplayer={handleOpenMultiplayer}
          multiplayerBadge={mpBadgeCount}
        />
      )}

      {/* Active Gameplay HUD */}
      {phase === 'playing' && (
        <GameHud
          hud={hud}
          muted={settings.muted}
          showTouchControls={showTouch}
          onToggleMute={handleToggleMute}
          onPause={handlePause}
          onPush={handleVirtualPush}
        />
      )}

      {/* In-Game Multiplayer Voice Chat HUD */}
      {isMultiplayerMatch && phase === 'playing' && mpSnap.room && (
        <InGameVoiceHud
          voiceMgr={voiceMgr}
          voiceSnap={voiceSnap}
          players={mpSnap.room.players}
          localUserId={mpSnap.user?.id || null}
          voiceVolume={settings.voiceVolume}
          onMasterVoiceToggle={handleMasterVoiceToggle}
          onVoiceVolumeChange={handleVoiceVolumeChange}
        />
      )}

      {/* Multiplayer Spectator / Escaped Banner */}
      {isMultiplayerMatch && phase === 'playing' && !mpMatchResult && mpLocalStatus !== 'playing' && (
        <MultiplayerStatusPill
          status={mpLocalStatus}
          aliveCount={mpAliveCount}
          totalCount={mpTotalCount}
          onLeave={handleQuitToMenu}
        />
      )}

      {/* Mobile / Tablet Touch Controls */}
      {showTouch && (
        <TouchControls
          key={hud.levelId}
          inWater={hud.inWater}
          waterJumpCooldown={hud.waterJumpCooldown}
          isFriendsMode={isMultiplayerMatch}
          pushCooldown={hud.pushCooldown}
          pushMaxCooldown={hud.pushMaxCooldown}
          canPushTarget={hud.canPushTarget}
          layout={touchLayout}
          onMove={handleVirtualMove}
          onAutoRunChange={handleVirtualAutoRun}
          onJump={handleVirtualJump}
          onPush={handleVirtualPush}
          onCameraDelta={handleVirtualCamDelta}
        />
      )}

      {/* Jumpscare / Eating Impact Peripheral Horror Vignette */}
      {phase === 'jumpscare' && (
        <div
          className="fixed inset-0 z-25 pointer-events-none"
          style={{
            background:
              deathReason === 'caught'
                ? 'radial-gradient(ellipse 68% 64% at 50% 48%, rgba(0,0,0,0) 24%, rgba(36,2,6,0.44) 68%, rgba(2,2,4,0.92) 100%), radial-gradient(circle at 50% 50%, rgba(165,12,18,0.06) 15%, rgba(110,0,8,0.34) 88%, rgba(6,0,2,0.85) 100%)'
                : 'radial-gradient(ellipse 68% 64% at 50% 50%, rgba(255,40,40,0.08) 18%, rgba(120,0,10,0.68) 82%, rgba(4,0,2,0.94) 100%)',
          }}
        />
      )}

      {/* Pause Menu */}
      {phase === 'paused' && !showLevels && !showSettings && !showTouchCustomizer && (
        <PauseModal
          levelCode={currentLevel.code}
          levelName={currentLevel.name}
          isMultiplayer={isMultiplayerMatch}
          onResume={handleResume}
          onRestart={isMultiplayerMatch ? handleResume : handleRestart}
          onSettings={handleOpenSettings}
          onLevels={handleOpenLevelsFromPause}
          onQuitMenu={handleQuitToMenu}
        />
      )}

      {/* Single-player Game Over */}
      {!isMultiplayerMatch && phase === 'gameover' && !showLevels && (
        <GameOverModal
          reason={deathReason}
          levelCode={currentLevel.code}
          levelName={currentLevel.name}
          hasCheckpoint={hud.checkpointIndex > 0}
          onRetry={handleRestart}
          onCheckpoint={handleRespawnCheckpoint}
          onLevels={handleOpenLevels}
          onMenu={handleQuitToMenu}
        />
      )}

      {/* Single-player Victory */}
      {!isMultiplayerMatch && phase === 'victory' && !showLevels && (
        <VictoryModal
          level={currentLevel}
          elapsed={victoryElapsed}
          hasNextLevel={currentLevel.id < TOTAL_LEVELS}
          onNextLevel={() => handleStartLevel(currentLevel.id + 1)}
          onReplay={handleRestart}
          onLevels={handleOpenLevels}
        />
      )}

      {/* Multiplayer Match Result */}
      {isMultiplayerMatch && mpMatchResult && phase !== 'jumpscare' && (
        <MultiplayerResultModal
          result={mpMatchResult}
          room={mpSnap.room}
          localUserId={mpSnap.user?.id || null}
          onReturnLobby={() => mpClient.returnToLobby()}
          onLeaveRoom={handleQuitToMenu}
        />
      )}

      {/* Multiplayer Hub Modal */}
      {showMultiplayer && (
        <MultiplayerModal
          client={mpClient}
          snapshot={mpSnap}
          voiceMgr={voiceMgr}
          voiceSnap={voiceSnap}
          voiceVolume={settings.voiceVolume}
          characterId={characterId}
          onCharacterChange={handleCharacterChange}
          onMasterVoiceToggle={handleMasterVoiceToggle}
          onVoiceVolumeChange={handleVoiceVolumeChange}
          onClose={handleCloseMultiplayer}
        />
      )}

      {/* Level Select Modal */}
      {showLevels && (
        <LevelSelectModal
          saveData={saveData}
          onSelect={handleStartLevel}
          onClose={handleCloseLevels}
        />
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          characterId={characterId}
          onCharacterChange={handleCharacterChange}
          showCustomizeControls={isTouchDevice || settings.touchControls !== 'off'}
          onOpenCustomizeControls={handleOpenCustomizeControls}
          onChange={handleSettingsChange}
          onClose={handleCloseSettings}
        />
      )}

      {/* Mobile Touch Controls Customizer */}
      {showTouchCustomizer && (
        <TouchControlsCustomizer
          savedLayout={touchLayout}
          onSave={handleSaveTouchLayout}
          onCancel={handleCancelTouchLayout}
        />
      )}

      {/* Smooth Scene & Asset Preload Transition Overlay */}
      <LoadingOverlay
        visible={loadingOverlay.visible}
        fadingOut={loadingOverlay.fadingOut}
        progress={loadingOverlay.progress}
        label={loadingOverlay.label}
        sublabel={loadingOverlay.sublabel}
      />

      {/* Mandatory Mobile Landscape-Only Enforcement Guard */}
      <LandscapeGuard onPortraitBlockChange={setIsPortraitBlocked} />
    </div>
  );
}

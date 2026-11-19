import React, { useCallback, useEffect, useState } from 'react';
import { Maximize2, RotateCw, Smartphone } from 'lucide-react';

interface LandscapeGuardProps {
  onPortraitBlockChange?: (blocked: boolean) => void;
}

function detectMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const coarsePointer =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(any-pointer: coarse)').matches);
  const hasTouch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  // Treat touch/mobile devices (phones & tablets) as mobile for landscape enforcement
  const shortSide = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  return mobileUa || (coarsePointer && hasTouch) || (hasTouch && shortSide <= 1024);
}

function getViewportDimensions(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 1280, height: 720 };
  const vv = window.visualViewport;
  const width = Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 1280);
  const height = Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 720);
  return { width, height };
}

async function tryLockLandscapeOrientation(requestFs: boolean): Promise<boolean> {
  try {
    if (requestFs && !document.fullscreenElement) {
      const rootEl = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      if (typeof rootEl.requestFullscreen === 'function') {
        await rootEl.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions).catch(() => undefined);
      } else if (typeof rootEl.webkitRequestFullscreen === 'function') {
        await Promise.resolve(rootEl.webkitRequestFullscreen()).catch(() => undefined);
      }
    }
  } catch {
    // Fullscreen may be unsupported (e.g., iOS Safari); continue to orientation lock check
  }

  try {
    const orientation = window.screen?.orientation as
      | (ScreenOrientation & { lock?: (orientation: string) => Promise<void> })
      | undefined;
    if (orientation && typeof orientation.lock === 'function') {
      await orientation.lock('landscape');
      return true;
    }
  } catch {
    // Browser blocked orientation lock (requires fullscreen or iOS Safari)
  }
  return false;
}

export const LandscapeGuard: React.FC<LandscapeGuardProps> = ({ onPortraitBlockChange }) => {
  const [isMobile, setIsMobile] = useState<boolean>(() => detectMobileDevice());
  const [isPortrait, setIsPortrait] = useState<boolean>(() => {
    const { width, height } = getViewportDimensions();
    return height > width;
  });

  const evaluateOrientation = useCallback(() => {
    const mobile = detectMobileDevice();
    const { width, height } = getViewportDimensions();
    setIsMobile(mobile);
    setIsPortrait(height > width);
  }, []);

  // Attempt native landscape lock on startup & on first mobile user interaction
  useEffect(() => {
    evaluateOrientation();

    if (detectMobileDevice()) {
      void tryLockLandscapeOrientation(false);
    }

    let settleTimer: number | null = null;
    const handleViewportChange = () => {
      evaluateOrientation();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        evaluateOrientation();
        if (detectMobileDevice()) {
          void tryLockLandscapeOrientation(false);
        }
      }, 140);
    };

    const handleFirstInteraction = () => {
      if (!detectMobileDevice()) return;
      void tryLockLandscapeOrientation(false);
    };

    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('orientationchange', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange, { passive: true });
    window.screen?.orientation?.addEventListener?.('change', handleViewportChange);
    window.addEventListener('pointerdown', handleFirstInteraction, { passive: true, once: true });

    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.screen?.orientation?.removeEventListener?.('change', handleViewportChange);
      window.removeEventListener('pointerdown', handleFirstInteraction);
    };
  }, [evaluateOrientation]);

  const portraitBlocked = isMobile && isPortrait;

  useEffect(() => {
    onPortraitBlockChange?.(portraitBlocked);
  }, [portraitBlocked, onPortraitBlockChange]);

  const handleLockFullscreenLandscape = async () => {
    await tryLockLandscapeOrientation(true);
    evaluateOrientation();
  };

  if (!portraitBlocked) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-[#070c0e] text-[#e6f3f5]"
      style={{
        paddingTop: 'max(1.5rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1.5rem, env(safe-area-inset-left))',
        paddingRight: 'max(1.5rem, env(safe-area-inset-right))',
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Landscape orientation required"
    >
      <div className="w-full max-w-xs rounded-xl bg-[#0e1518] border border-[#31474d] p-5 flex flex-col items-center text-center gap-3.5 shadow-2xl">
        <div className="text-[10px] font-mono tracking-[0.22em] text-[#52e0b6] uppercase">
          SERPENTIS · LANDSCAPE ONLY
        </div>

        <div className="relative w-16 h-16 rounded-xl bg-[#091013] border border-[#253a40] flex items-center justify-center">
          <Smartphone className="w-8 h-8 text-[#52e0b6] animate-phone-rotate" />
          <RotateCw className="w-3.5 h-3.5 text-[#88c8ba] absolute bottom-1.5 right-1.5" />
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-base font-extrabold tracking-wider uppercase text-[#eaf6f8]">
            Rotate Your Device
          </h2>
          <p className="text-xs text-[#93adb3] leading-relaxed">
            Turn your phone sideways to horizontal landscape mode to play. Portrait orientation is disabled.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleLockFullscreenLandscape()}
          className="w-full py-2.5 px-4 rounded-lg bg-[#52e0b6] hover:bg-[#6ef0c8] text-[#071113] font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          Lock Landscape Mode
        </button>
      </div>
    </div>
  );
};

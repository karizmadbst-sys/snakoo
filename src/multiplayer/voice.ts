import type { MultiplayerClient } from './client';
import type { RoomState, RoomVoicePeerState, VoiceSignalPayload } from './types';

export type VoicePlatform = 'ios' | 'android' | 'desktop';

export type MicPermissionStatus =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'no-device'
  | 'in-use'
  | 'unsupported';

export interface AudioInputDeviceInfo {
  deviceId: string;
  label: string;
}

export interface VoicePeerHudInfo {
  userId: string;
  voiceActive: boolean;
  micEnabled: boolean;
  selfMuted: boolean;
  speaking: boolean;
  locallyMuted: boolean;
  connectionState: RTCPeerConnectionState | 'new';
}

export interface VoiceChatSnapshot {
  supported: boolean;
  platform: VoicePlatform;
  voiceActive: boolean;
  micEnabled: boolean;
  selfMuted: boolean;
  speaking: boolean;
  micLevel: number; // 0..1 normalized local input meter
  voiceVolume: number; // 0..1
  permissionStatus: MicPermissionStatus;
  permissionHelp: string | null;
  devices: AudioInputDeviceInfo[];
  selectedDeviceId: string;
  inRoom: boolean;
  roomId: string | null;
  connectedPeerCount: number;
  peers: Record<string, VoicePeerHudInfo>;
  mutedPeerIds: string[];
}

interface PeerSlot {
  userId: string;
  pc: RTCPeerConnection;
  transceiver: RTCRtpTransceiver | null;
  audioEl: HTMLAudioElement;
  remoteStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingIce: RTCIceCandidateInit[];
  connectionState: RTCPeerConnectionState | 'new';
  lastIceRestartAt: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
    ],
  },
];

function detectPlatform(): VoicePlatform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  const isAppleTouch =
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Mac/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  if (isAppleTouch) return 'ios';
  return 'desktop';
}

function buildPermissionHelp(platform: VoicePlatform, status: MicPermissionStatus): string | null {
  if (status === 'denied') {
    if (platform === 'ios') {
      return "Microphone permission was denied. Open iPhone/iPad Settings → Safari (or your browser app) → Microphone → Allow, or tap the 'aA' / padlock icon in the address bar → Website Settings → Microphone → Allow, then tap Retry.";
    }
    if (platform === 'android') {
      return 'Microphone permission was denied. Tap the padlock or tune icon in your browser address bar → Permissions → Microphone → Allow (or open Android Settings → Apps → Browser → Permissions → Microphone), then tap Retry.';
    }
    return 'Microphone permission was denied. Click the padlock or microphone icon in your browser address bar → Allow Microphone, and verify your OS Privacy Settings allow microphone access, then tap Retry.';
  }
  if (status === 'no-device') {
    return 'No microphone was detected on this device. Connect a headset or built-in mic and tap Retry.';
  }
  if (status === 'in-use') {
    return 'Your microphone is currently in use by another app or call. Close the other app and tap Retry.';
  }
  if (status === 'unsupported') {
    return 'Live microphone access requires HTTPS and a WebRTC-capable browser (Chrome, Safari, Edge, or Firefox).';
  }
  return null;
}

/**
 * Tunes outbound SDP for reliable low-latency voice over slow internet connections:
 * - Opus DTX (`usedtx=1`) avoids sending packets during silence
 * - In-band FEC (`useinbandfec=1`) recovers dropped packets cleanly
 * - Caps speech bitrate (`maxaveragebitrate=24000`, mono) to handle up to 12 peers smoothly
 */
function optimizeOpusSdp(sdp: string): string {
  const lines = sdp.split('\r\n');
  let opusPayload: string | null = null;
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
    if (m) {
      opusPayload = m[1];
      break;
    }
  }
  if (!opusPayload) return sdp;

  const fmtpPrefix = `a=fmtp:${opusPayload} `;
  let foundFmtp = false;
  const out = lines.map((line) => {
    if (!line.startsWith(fmtpPrefix)) return line;
    foundFmtp = true;
    const rawParams = line.slice(fmtpPrefix.length).split(';').map((s) => s.trim()).filter(Boolean);
    const paramMap = new Map<string, string>();
    for (const entry of rawParams) {
      const eq = entry.indexOf('=');
      if (eq > 0) {
        paramMap.set(entry.slice(0, eq), entry.slice(eq + 1));
      } else {
        paramMap.set(entry, '');
      }
    }
    paramMap.set('usedtx', '1');
    paramMap.set('useinbandfec', '1');
    paramMap.set('maxaveragebitrate', '24000');
    paramMap.set('stereo', '0');
    paramMap.set('cbr', '0');
    const rebuilt = Array.from(paramMap.entries())
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join(';');
    return `${fmtpPrefix}${rebuilt}`;
  });

  if (!foundFmtp) {
    const rtpmapIdx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPayload} `));
    if (rtpmapIdx >= 0) {
      out.splice(
        rtpmapIdx + 1,
        0,
        `a=fmtp:${opusPayload} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=24000;stereo=0;cbr=0`
      );
    }
  }

  return out.join('\r\n');
}

export class VoiceChatManager {
  private client: MultiplayerClient;
  private platform: VoicePlatform = detectPlatform();
  private supported: boolean;

  private localUserId: string | null = null;
  private currentRoom: RoomState | null = null;

  private voiceActive = true;
  private micEnabled = false;
  private selfMuted = false;
  private speaking = false;
  private micLevel = 0;
  private voiceVolume = 0.85;
  private permissionStatus: MicPermissionStatus = 'idle';
  private devices: AudioInputDeviceInfo[] = [];
  private selectedDeviceId = '';

  private localStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;

  // Web Audio graph:
  // 1. Local mic -> silent AnalyserNode ONLY (never connected to destination -> zero feedback)
  // 2. Remote peer streams -> Peer GainNode -> Master Voice GainNode -> destination (universal iOS/Android/PC volume)
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private vadSource: MediaStreamAudioSourceNode | null = null;
  private vadAnalyser: AnalyserNode | null = null;
  private vadData: Float32Array<ArrayBuffer> | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private lastVoiceAboveMs = 0;

  private audioContainer: HTMLDivElement | null = null;
  private peers = new Map<string, PeerSlot>();
  private mutedPeerIds = new Set<string>();
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  private iceConfigFetched = false;

  private listeners = new Set<(snap: VoiceChatSnapshot) => void>();
  private unsubClient: Array<() => void> = [];
  private disposed = false;
  private requestingMic = false;
  private probedDevices = false;
  private emitScheduled = false;
  private lastRoomSyncKey = '';

  constructor(client: MultiplayerClient, initialVoiceEnabled = true, initialVoiceVolume = 0.85) {
    this.client = client;
    this.voiceActive = initialVoiceEnabled;
    this.voiceVolume = Math.max(0, Math.min(1, initialVoiceVolume));
    this.supported =
      typeof window !== 'undefined' &&
      typeof RTCPeerConnection !== 'undefined' &&
      Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!this.supported) {
      this.permissionStatus = 'unsupported';
    }

    if (typeof document !== 'undefined') {
      const container = document.createElement('div');
      container.setAttribute('aria-hidden', 'true');
      container.style.position = 'fixed';
      container.style.width = '0px';
      container.style.height = '0px';
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      container.style.overflow = 'hidden';
      document.body.appendChild(container);
      this.audioContainer = container;
    }

    this.unsubClient.push(
      this.client.onVoiceSignal((sig) => {
        void this.handleIncomingSignal(sig);
      }),
      this.client.onVoicePeerState(() => {
        this.scheduleEmit();
      }),
      this.client.onVoicePeerLeft(({ roomId, userId }) => {
        if (this.currentRoom && this.currentRoom.id === roomId) {
          this.closePeer(userId);
          this.scheduleEmit();
        }
      })
    );

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
    }
  }

  private handleDeviceChange = (): void => {
    if (!this.currentRoom && !this.probedDevices) return;
    void this.refreshAudioDevices();
  };

  private async probePermissionsAndDevices(): Promise<void> {
    if (!this.supported || this.probedDevices) return;
    this.probedDevices = true;
    try {
      if (navigator.permissions?.query) {
        const res = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (res.state === 'denied') {
          this.permissionStatus = 'denied';
          this.scheduleEmit();
        } else if (res.state === 'granted' && this.permissionStatus === 'idle') {
          this.permissionStatus = 'granted';
          this.scheduleEmit();
        }
        res.onchange = () => {
          if (this.disposed) return;
          if (res.state === 'denied') {
            this.permissionStatus = 'denied';
            this.disableMicrophone();
          } else if (res.state === 'granted') {
            if (this.permissionStatus === 'denied') {
              this.permissionStatus = 'granted';
            }
          }
          this.scheduleEmit();
        };
      }
    } catch {
      // Safari / some mobile browsers throw on permissions.query('microphone')
    }
    await this.refreshAudioDevices();
  }

  public async refreshAudioDevices(): Promise<AudioInputDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${idx + 1}`,
        }));
      this.devices = inputs;
      if (this.selectedDeviceId && !inputs.some((d) => d.deviceId === this.selectedDeviceId)) {
        this.selectedDeviceId = '';
      }
      this.scheduleEmit();
      return inputs;
    } catch {
      return [];
    }
  }

  public subscribe(fn: (snap: VoiceChatSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => this.listeners.delete(fn);
  }

  public getSnapshot(): VoiceChatSnapshot {
    const peerMap: Record<string, VoicePeerHudInfo> = {};
    let connectedCount = 0;

    if (this.currentRoom) {
      for (const p of this.currentRoom.players) {
        if (p.userId === this.localUserId) continue;
        const slot = this.peers.get(p.userId);
        const connState = slot?.connectionState || 'new';
        if (connState === 'connected') connectedCount++;
        peerMap[p.userId] = {
          userId: p.userId,
          voiceActive: p.voice?.voiceActive ?? false,
          micEnabled: p.voice?.micEnabled ?? false,
          selfMuted: p.voice?.selfMuted ?? false,
          speaking: p.voice?.speaking ?? false,
          locallyMuted: this.mutedPeerIds.has(p.userId),
          connectionState: connState,
        };
      }
    }

    return {
      supported: this.supported,
      platform: this.platform,
      voiceActive: this.voiceActive,
      micEnabled: this.micEnabled,
      selfMuted: this.selfMuted,
      speaking: this.speaking,
      micLevel: this.micLevel,
      voiceVolume: this.voiceVolume,
      permissionStatus: this.permissionStatus,
      permissionHelp: buildPermissionHelp(this.platform, this.permissionStatus),
      devices: this.devices,
      selectedDeviceId: this.selectedDeviceId,
      inRoom: Boolean(this.currentRoom),
      roomId: this.currentRoom?.id || null,
      connectedPeerCount: connectedCount,
      peers: peerMap,
      mutedPeerIds: Array.from(this.mutedPeerIds),
    };
  }

  private emit(): void {
    this.emitScheduled = false;
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  private scheduleEmit(): void {
    if (this.disposed || this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      if (!this.disposed && this.emitScheduled) {
        this.emit();
      }
    });
  }

  private ensureAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.audioCtx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      this.audioCtx = new Ctx();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = this.voiceActive ? this.voiceVolume : 0;
      this.masterGain.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().then(() => {
        this.syncAudioRoutingMode();
      });
    }
    return this.audioCtx;
  }

  public unlockAudioOutput(): void {
    this.ensureAudioContext();
    this.syncAudioRoutingMode();
    for (const slot of this.peers.values()) {
      if (slot.remoteStream && slot.audioEl.paused) {
        void slot.audioEl.play().catch(() => {});
      }
    }
  }

  private syncAudioRoutingMode(): void {
    const useWebAudio = Boolean(this.audioCtx && this.audioCtx.state === 'running' && this.masterGain);
    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setTargetAtTime(
        this.voiceActive ? this.voiceVolume : 0,
        this.audioCtx.currentTime,
        0.03
      );
    }

    for (const slot of this.peers.values()) {
      const peerMuted = !this.voiceActive || this.mutedPeerIds.has(slot.userId);
      if (useWebAudio && slot.remoteStream && this.audioCtx && this.masterGain) {
        if (!slot.sourceNode) {
          try {
            slot.sourceNode = this.audioCtx.createMediaStreamSource(slot.remoteStream);
            slot.gainNode = this.audioCtx.createGain();
            slot.gainNode.gain.value = peerMuted ? 0 : 1;
            slot.sourceNode.connect(slot.gainNode);
            slot.gainNode.connect(this.masterGain);
          } catch {
            // Fallback to HTMLAudioElement if MediaStreamAudioSourceNode fails
          }
        }
        if (slot.gainNode) {
          slot.gainNode.gain.setTargetAtTime(peerMuted ? 0 : 1, this.audioCtx.currentTime, 0.03);
          slot.audioEl.muted = true; // Output via AudioContext GainNode only (zero doubling)
        } else {
          slot.audioEl.muted = peerMuted;
          slot.audioEl.volume = this.voiceVolume;
        }
      } else {
        slot.audioEl.muted = peerMuted;
        slot.audioEl.volume = this.voiceVolume;
      }
    }
  }

  private pushLocalVoiceState(): void {
    if (!this.currentRoom || !this.localUserId) return;
    const state: RoomVoicePeerState = {
      voiceActive: this.voiceActive,
      micEnabled: this.voiceActive && this.micEnabled,
      selfMuted: this.selfMuted,
      speaking: this.voiceActive && this.micEnabled && !this.selfMuted && this.speaking,
    };
    this.client.sendVoiceState(state);
  }

  /**
   * Keeps WebRTC peer connections strictly synchronized with the current authorized room.
   * Immediately closes all mic & peer tracks when leaving a room or signing out.
   */
  public syncRoomContext(userId: string | null, room: RoomState | null): void {
    const prevRoomId = this.currentRoom?.id || null;
    const nextRoomId = room?.id || null;
    this.localUserId = userId;

    if (!userId || !room) {
      if (this.lastRoomSyncKey === 'none') return;
      this.lastRoomSyncKey = 'none';
      this.currentRoom = null;
      if (this.micEnabled || this.localStream) {
        this.disableMicrophone(false);
      }
      this.closeAllPeers();
      this.mutedPeerIds.clear();
      this.emit();
      return;
    }

    const activeIds: string[] = [];
    const activeTeammateIds = new Set<string>();
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.userId !== userId && p.connected) {
        activeIds.push(p.userId);
        activeTeammateIds.add(p.userId);
      }
    }
    activeIds.sort();
    const syncKey = `${userId}|${room.id}|${this.voiceActive ? 1 : 0}|${activeIds.join(',')}`;
    this.currentRoom = room;
    if (syncKey === this.lastRoomSyncKey) {
      return;
    }
    this.lastRoomSyncKey = syncKey;

    if (!this.probedDevices) {
      void this.probePermissionsAndDevices();
    }

    if (prevRoomId && prevRoomId !== nextRoomId) {
      if (this.micEnabled || this.localStream) {
        this.disableMicrophone(false);
      }
      this.closeAllPeers();
      this.mutedPeerIds.clear();
    }

    if (!this.iceConfigFetched) {
      this.iceConfigFetched = true;
      void this.client
        .getVoiceIceConfig()
        .then((res) => {
          if (Array.isArray(res.iceServers) && res.iceServers.length > 0) {
            this.iceServers = res.iceServers;
          }
        })
        .catch(() => {
          // Keep default STUN servers
        });
    }

    if (!this.voiceActive) {
      this.closeAllPeers();
      this.pushLocalVoiceState();
      this.emit();
      return;
    }

    // Reconcile peer connections for all connected teammates inside this room
    for (const existingPeerId of Array.from(this.peers.keys())) {
      if (!activeTeammateIds.has(existingPeerId)) {
        this.closePeer(existingPeerId);
      }
    }

    for (const teammateId of activeTeammateIds) {
      if (!this.peers.has(teammateId)) {
        this.createPeerSlot(teammateId, true);
      }
    }

    this.pushLocalVoiceState();
    this.emit();
  }

  public setVoiceActive(active: boolean): void {
    if (this.voiceActive === active) return;
    this.voiceActive = active;

    if (!active) {
      // Immediately stop mic hardware & close all voice peer streams
      this.disableMicrophone(false);
      this.closeAllPeers();
    } else {
      this.ensureAudioContext();
      if (this.currentRoom && this.localUserId) {
        this.syncRoomContext(this.localUserId, this.currentRoom);
      }
    }

    this.syncAudioRoutingMode();
    this.pushLocalVoiceState();
    this.emit();
  }

  public setVoiceVolume(volume: number): void {
    this.voiceVolume = Math.max(0, Math.min(1, volume));
    this.syncAudioRoutingMode();
    this.emit();
  }

  public setSelfMuted(muted: boolean): void {
    this.selfMuted = muted;
    if (this.localTrack) {
      this.localTrack.enabled = !muted;
    }
    if (muted) {
      this.speaking = false;
      this.micLevel = 0;
    }
    this.pushLocalVoiceState();
    this.emit();
  }

  public togglePeerMuted(peerUserId: string): void {
    if (this.mutedPeerIds.has(peerUserId)) {
      this.mutedPeerIds.delete(peerUserId);
    } else {
      this.mutedPeerIds.add(peerUserId);
    }
    this.syncAudioRoutingMode();
    this.emit();
  }

  public async selectAudioDevice(deviceId: string): Promise<void> {
    this.selectedDeviceId = deviceId;
    this.emit();
    if (this.micEnabled) {
      await this.enableMicrophone();
    }
  }

  /**
   * Explicitly requests OS/browser microphone permission and starts live capture.
   * Never invoked automatically without explicit user interaction.
   */
  public async enableMicrophone(): Promise<boolean> {
    if (!this.supported) {
      this.permissionStatus = 'unsupported';
      this.emit();
      return false;
    }
    if (this.requestingMic) return false;

    this.ensureAudioContext();
    this.requestingMic = true;
    this.permissionStatus = 'requesting';
    this.emit();

    const baseAudio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
    };
    const primaryAudio: MediaTrackConstraints = this.selectedDeviceId
      ? { ...baseAudio, deviceId: { exact: this.selectedDeviceId } }
      : baseAudio;

    let stream: MediaStream | null = null;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: primaryAudio, video: false });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
        } else {
          throw err;
        }
      }

      // Guard against room exit or master voice off while awaiting user permission prompt
      if (this.disposed || !this.currentRoom) {
        stream.getTracks().forEach((t) => t.stop());
        this.requestingMic = false;
        this.permissionStatus = 'granted';
        this.emit();
        return false;
      }

      if (!this.voiceActive) {
        this.voiceActive = true;
      }

      // Stop previous tracks cleanly before swapping
      this.stopLocalMediaTracks();

      const track = stream.getAudioTracks()[0] || null;
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        this.permissionStatus = 'no-device';
        this.requestingMic = false;
        this.emit();
        return false;
      }

      // Apply echo cancellation / noise suppression / AGC hints where supported
      try {
        await track.applyConstraints({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      } catch {
        // Ignore if driver locks constraints
      }

      track.enabled = !this.selfMuted;
      track.onended = () => {
        if (!this.disposed && this.micEnabled) {
          this.disableMicrophone(true);
        }
      };

      this.localStream = stream;
      this.localTrack = track;
      this.micEnabled = true;
      this.permissionStatus = 'granted';
      this.requestingMic = false;

      this.setupLocalVad(stream);
      await this.refreshAudioDevices();
      const activeSettings = track.getSettings?.();
      if (activeSettings?.deviceId) {
        this.selectedDeviceId = activeSettings.deviceId;
      }

      // Ensure peer slots exist and attach local mic track via replaceTrack
      if (this.currentRoom && this.localUserId) {
        for (const p of this.currentRoom.players) {
          if (p.userId !== this.localUserId && p.connected && !this.peers.has(p.userId)) {
            this.createPeerSlot(p.userId, true);
          }
        }
      }
      await this.attachLocalTrackToAllPeers(track);

      this.syncAudioRoutingMode();
      this.pushLocalVoiceState();
      this.emit();
      return true;
    } catch (err) {
      this.requestingMic = false;
      const errName = err instanceof DOMException ? err.name : '';
      if (
        errName === 'NotAllowedError' ||
        errName === 'PermissionDeniedError' ||
        errName === 'SecurityError'
      ) {
        this.permissionStatus = 'denied';
      } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
        this.permissionStatus = 'no-device';
      } else if (errName === 'NotReadableError' || errName === 'TrackStartError') {
        this.permissionStatus = 'in-use';
      } else {
        // Double-check whether any audio input device exists at all
        const devs = await this.refreshAudioDevices();
        this.permissionStatus = devs.length === 0 ? 'no-device' : 'denied';
      }
      this.micEnabled = false;
      this.speaking = false;
      this.micLevel = 0;
      this.pushLocalVoiceState();
      this.emit();
      return false;
    }
  }

  public disableMicrophone(notifyPeers = true): void {
    this.stopLocalVad();
    this.stopLocalMediaTracks();
    this.micEnabled = false;
    this.speaking = false;
    this.micLevel = 0;

    for (const slot of this.peers.values()) {
      if (slot.transceiver) {
        try {
          void slot.transceiver.sender.replaceTrack(null);
          slot.transceiver.direction = this.voiceActive ? 'recvonly' : 'inactive';
        } catch {
          // ignore if peer closed
        }
      }
    }

    if (notifyPeers) {
      this.pushLocalVoiceState();
    }
    this.emit();
  }

  private stopLocalMediaTracks(): void {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.onended = null;
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.localStream = null;
    }
    this.localTrack = null;
  }

  private setupLocalVad(stream: MediaStream): void {
    this.stopLocalVad();
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      // Intentionally NOT connected to ctx.destination -> zero local feedback or echo!
      source.connect(analyser);

      this.vadSource = source;
      this.vadAnalyser = analyser;
      this.vadData = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.lastVoiceAboveMs = 0;
      let lastLevelEmitMs = 0;

      this.vadTimer = setInterval(() => {
        if (!this.vadAnalyser || !this.vadData || !this.micEnabled || this.selfMuted || !this.voiceActive) {
          if (this.speaking || this.micLevel > 0) {
            this.speaking = false;
            this.micLevel = 0;
            this.pushLocalVoiceState();
            this.emit();
          }
          return;
        }

        this.vadAnalyser.getFloatTimeDomainData(this.vadData);
        let sumSq = 0;
        for (let i = 0; i < this.vadData.length; i++) {
          const s = this.vadData[i];
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / this.vadData.length);
        const normLevel = Math.min(1, rms * 6.5);
        const now = performance.now();

        if (rms > 0.018) {
          this.lastVoiceAboveMs = now;
        }
        const nextSpeaking = rms > 0.018 || now - this.lastVoiceAboveMs < 300;
        const levelChanged = Math.abs(normLevel - this.micLevel) > 0.08;

        if (nextSpeaking !== this.speaking) {
          this.speaking = nextSpeaking;
          this.micLevel = normLevel;
          lastLevelEmitMs = now;
          this.pushLocalVoiceState();
          this.emit();
        } else if (levelChanged && now - lastLevelEmitMs >= 200) {
          this.micLevel = normLevel;
          lastLevelEmitMs = now;
          this.emit();
        }
      }, 85);
    } catch {
      // VAD unavailable
    }
  }

  private stopLocalVad(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    try {
      this.vadSource?.disconnect();
      this.vadAnalyser?.disconnect();
    } catch {
      // ignore
    }
    this.vadSource = null;
    this.vadAnalyser = null;
    this.vadData = null;
  }

  private async attachLocalTrackToAllPeers(track: MediaStreamTrack): Promise<void> {
    for (const slot of this.peers.values()) {
      try {
        if (!slot.transceiver) {
          slot.transceiver = slot.pc.addTransceiver(track, {
            direction: 'sendrecv',
            streams: this.localStream ? [this.localStream] : undefined,
          });
        } else {
          await slot.transceiver.sender.replaceTrack(track);
          slot.transceiver.direction = 'sendrecv';
        }
        await this.tuneSenderBitrate(slot.transceiver.sender);
      } catch {
        // ignore if peer closing
      }
    }
  }

  private async tuneSenderBitrate(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 24000;
      await sender.setParameters(params);
    } catch {
      // setParameters maxBitrate optional across mobile browsers
    }
  }

  private createPeerSlot(remoteUserId: string, initiateIfPoliteOrLeader: boolean): PeerSlot {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    });

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.muted = true;
    this.audioContainer?.appendChild(audioEl);

    const polite = (this.localUserId || '') < remoteUserId;
    const slot: PeerSlot = {
      userId: remoteUserId,
      pc,
      transceiver: null,
      audioEl,
      remoteStream: null,
      sourceNode: null,
      gainNode: null,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingIce: [],
      connectionState: 'new',
      lastIceRestartAt: 0,
    };

    if (this.localTrack) {
      slot.transceiver = pc.addTransceiver(this.localTrack, {
        direction: 'sendrecv',
        streams: this.localStream ? [this.localStream] : undefined,
      });
      void this.tuneSenderBitrate(slot.transceiver.sender);
    } else if (initiateIfPoliteOrLeader && !polite) {
      // Impolite peer kicks off recvonly audio transceiver so listen-only teammates hear speakers immediately
      slot.transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.onnegotiationneeded = async () => {
      if (this.disposed || !this.currentRoom || !this.voiceActive) return;
      try {
        slot.makingOffer = true;
        const offer = await pc.createOffer();
        if (offer.sdp) {
          offer.sdp = optimizeOpusSdp(offer.sdp);
        }
        await pc.setLocalDescription(offer);
        if (pc.localDescription) {
          this.client.sendVoiceSignal(remoteUserId, 'offer', {
            type: pc.localDescription.type,
            sdp: pc.localDescription.sdp,
          });
        }
      } catch {
        // negotiation race handled by perfect negotiation
      } finally {
        slot.makingOffer = false;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.currentRoom && this.voiceActive) {
        this.client.sendVoiceSignal(remoteUserId, 'ice', ev.candidate.toJSON());
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      slot.remoteStream = stream;
      slot.audioEl.srcObject = stream;
      void slot.audioEl.play().catch(() => {
        // Will play cleanly after user interaction / unlockAudioOutput
      });
      this.syncAudioRoutingMode();
      this.scheduleEmit();
    };

    pc.onconnectionstatechange = () => {
      slot.connectionState = pc.connectionState;
      if (pc.connectionState === 'failed' && Date.now() - slot.lastIceRestartAt > 4000) {
        slot.lastIceRestartAt = Date.now();
        try {
          pc.restartIce();
        } catch {
          // ignore
        }
      }
      this.scheduleEmit();
    };

    this.peers.set(remoteUserId, slot);
    return slot;
  }

  private async handleIncomingSignal(sig: VoiceSignalPayload): Promise<void> {
    if (this.disposed || !this.voiceActive || !this.currentRoom) return;
    if (sig.roomId !== this.currentRoom.id) return;
    if (sig.fromUserId === this.localUserId) return;

    // Ensure sender is actually an authorized member of this exact room
    const inSameRoom = this.currentRoom.players.some((p) => p.userId === sig.fromUserId);
    if (!inSameRoom) return;

    let slot = this.peers.get(sig.fromUserId);
    if (!slot) {
      slot = this.createPeerSlot(sig.fromUserId, false);
    }

    const pc = slot.pc;

    try {
      if (sig.kind === 'offer' || sig.kind === 'answer') {
        const desc = sig.data as RTCSessionDescriptionInit;
        if (!desc || !desc.type || !desc.sdp) return;

        const readyForOffer =
          !slot.makingOffer &&
          (pc.signalingState === 'stable' || slot.isSettingRemoteAnswerPending);
        const offerCollision = desc.type === 'offer' && !readyForOffer;

        slot.ignoreOffer = !slot.polite && offerCollision;
        if (slot.ignoreOffer) return;

        slot.isSettingRemoteAnswerPending = desc.type === 'answer';
        if (offerCollision && pc.signalingState !== 'stable') {
          try {
            await pc.setLocalDescription({ type: 'rollback' });
          } catch {
            // Some browsers allow direct setRemoteDescription on polite rollback
          }
        }
        await pc.setRemoteDescription(desc);
        slot.isSettingRemoteAnswerPending = false;

        // Flush queued ICE candidates received before remote description
        while (slot.pendingIce.length > 0) {
          const cand = slot.pendingIce.shift()!;
          try {
            await pc.addIceCandidate(cand);
          } catch {
            // ignore stale candidate
          }
        }

        if (desc.type === 'offer') {
          if (!slot.transceiver) {
            const recvTrans = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio');
            if (recvTrans) {
              slot.transceiver = recvTrans;
            }
          }
          if (slot.transceiver) {
            if (this.localTrack) {
              await slot.transceiver.sender.replaceTrack(this.localTrack);
              slot.transceiver.direction = 'sendrecv';
              await this.tuneSenderBitrate(slot.transceiver.sender);
            } else {
              slot.transceiver.direction = 'recvonly';
            }
          }
          const answer = await pc.createAnswer();
          if (answer.sdp) {
            answer.sdp = optimizeOpusSdp(answer.sdp);
          }
          await pc.setLocalDescription(answer);
          if (pc.localDescription) {
            this.client.sendVoiceSignal(sig.fromUserId, 'answer', {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp,
            });
          }
        }
      } else if (sig.kind === 'ice') {
        const cand = sig.data as RTCIceCandidateInit;
        if (!cand) return;
        if (!pc.remoteDescription) {
          slot.pendingIce.push(cand);
          return;
        }
        try {
          await pc.addIceCandidate(cand);
        } catch (err) {
          if (!slot.ignoreOffer) throw err;
        }
      }
    } catch {
      // Swallow transient negotiation errors
    }
  }

  private closePeer(userId: string): void {
    const slot = this.peers.get(userId);
    if (!slot) return;
    this.peers.delete(userId);

    try {
      slot.sourceNode?.disconnect();
      slot.gainNode?.disconnect();
    } catch {
      // ignore
    }
    slot.audioEl.pause();
    slot.audioEl.srcObject = null;
    slot.audioEl.remove();

    try {
      slot.pc.onnegotiationneeded = null;
      slot.pc.onicecandidate = null;
      slot.pc.ontrack = null;
      slot.pc.onconnectionstatechange = null;
      slot.pc.close();
    } catch {
      // ignore
    }
  }

  private closeAllPeers(): void {
    for (const uid of Array.from(this.peers.keys())) {
      this.closePeer(uid);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.disableMicrophone(false);
    this.closeAllPeers();
    for (const unsub of this.unsubClient) unsub();
    this.unsubClient = [];

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
    }
    if (this.audioContainer) {
      this.audioContainer.remove();
      this.audioContainer = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.listeners.clear();
  }
}

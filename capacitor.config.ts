import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.serpentis.horror',
  appName: 'SERPENTIS',
  webDir: 'dist',
  server: {
    // HTTPS scheme required so Android WebView exposes navigator.mediaDevices.getUserMedia for WebRTC voice chat
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;

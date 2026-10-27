import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.abs.agentapp',
  appName: 'mincode',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: true,
  },
  // 不全局 patch fetch（会破坏 SSE）；上游请求在代码里显式走 CapacitorHttp
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;

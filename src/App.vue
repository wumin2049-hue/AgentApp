<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { App as CapApp } from '@capacitor/app';
import { useProjectsStore } from '@/stores/projects';
import { useAgentSettingsStore } from '@/stores/agentSettings';

const router = useRouter();
const projects = useProjectsStore();
const agentSettings = useAgentSettingsStore();
const bootstrapping = ref(true);

let removeBack: (() => void) | undefined;

onMounted(async () => {
  await agentSettings.load();
  await projects.load();
  bootstrapping.value = false;

  const handle = await CapApp.addListener('backButton', ({ canGoBack }) => {
    const overlay = document.querySelector('.sheet-overlay:not([hidden]), .preview-overlay');
    if (overlay) {
      const closeBtn = overlay.querySelector(
        '.sheet-header .btn, .history-drawer-header .btn, .preview-header .btn',
      ) as HTMLElement | null;
      if (closeBtn) closeBtn.click();
      else (overlay as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    if (canGoBack) {
      window.history.back();
    } else if (router.currentRoute.value.path !== '/') {
      void router.push('/');
    } else {
      void CapApp.exitApp();
    }
  });
  removeBack = () => {
    void handle.remove();
  };
});

onUnmounted(() => {
  removeBack?.();
});
</script>

<template>
  <div class="app-shell">
    <div v-if="bootstrapping" class="boot-splash">
      <p class="hint-text">加载中…</p>
    </div>
    <template v-else>
      <router-view />
      <nav class="tab-bar">
        <router-link to="/">
          <span class="tab-icon" aria-hidden="true">⌂</span>
          <span>首页</span>
        </router-link>
        <router-link to="/chat">
          <span class="tab-icon" aria-hidden="true">◉</span>
          <span>对话</span>
        </router-link>
        <router-link to="/projects">
          <span class="tab-icon" aria-hidden="true">▤</span>
          <span>项目</span>
        </router-link>
        <router-link to="/ftp">
          <span class="tab-icon" aria-hidden="true">⇪</span>
          <span>FTP</span>
        </router-link>
        <router-link to="/settings">
          <span class="tab-icon" aria-hidden="true">⚙</span>
          <span>设置</span>
        </router-link>
      </nav>
    </template>
  </div>
</template>

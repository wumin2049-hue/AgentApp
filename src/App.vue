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
    // 优先关最上层弹层（含计划确认 / 历史抽屉 / 预览）
    const overlays = [
      ...document.querySelectorAll('.sheet-overlay, .preview-overlay, .history-drawer-overlay'),
    ] as HTMLElement[];
    const overlay = overlays.filter((el) => el.offsetParent !== null || el.style.display !== 'none').pop();
    if (overlay && overlay.offsetParent !== null) {
      const closeBtn = overlay.querySelector(
        '[data-sheet-close], .sheet-header .btn, .history-drawer-header .btn, .preview-header .btn',
      ) as HTMLElement | null;
      if (closeBtn) closeBtn.click();
      else overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
      <nav class="tab-bar" aria-label="主导航">
        <!-- 首页必须 exact，避免 /chat 等子路径时双高亮 -->
        <router-link v-slot="{ href, navigate, isExactActive }" to="/" custom>
          <a :href="href" :class="{ active: isExactActive }" @click="navigate">
            <span class="tab-icon" aria-hidden="true">⌂</span>
            <span>首页</span>
          </a>
        </router-link>
        <router-link to="/chat" active-class="active" exact-active-class="active">
          <span class="tab-icon" aria-hidden="true">◉</span>
          <span>对话</span>
        </router-link>
        <router-link to="/projects" active-class="active" exact-active-class="active">
          <span class="tab-icon" aria-hidden="true">▤</span>
          <span>项目</span>
        </router-link>
        <router-link to="/ftp" active-class="active" exact-active-class="active">
          <span class="tab-icon" aria-hidden="true">⇪</span>
          <span>FTP</span>
        </router-link>
        <router-link to="/settings" active-class="active" exact-active-class="active">
          <span class="tab-icon" aria-hidden="true">⚙</span>
          <span>设置</span>
        </router-link>
      </nav>
    </template>
  </div>
</template>

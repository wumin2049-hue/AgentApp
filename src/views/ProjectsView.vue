<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';

const router = useRouter();
const store = useProjectsStore();
const name = ref('');
const busy = ref(false);
const err = ref('');

async function create() {
  err.value = '';
  busy.value = true;
  try {
    const p = await store.createProject(name.value.trim());
    router.push(`/projects/${p.id}`);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <header class="app-header">
    <h1>项目</h1>
    <div class="sub">每个项目绑定手机文件夹（需授权读/写/列表）+ FTP</div>
  </header>
  <main class="app-main">
    <div class="card">
      <div class="field">
        <label>项目名称（可选）</label>
        <input v-model="name" placeholder="例如：官网前端" />
      </div>
      <button class="btn btn-primary btn-block" :disabled="busy" @click="create">
        {{ busy ? '等待授权…' : '＋ 新建并授权手机文件夹' }}
      </button>
      <p class="hint-text" style="margin-top:10px">
        弹出系统目录选择器后，请点「使用此文件夹」，否则无法同步与改代码。
      </p>
      <p v-if="err" class="hint-text err" style="margin-top:10px">{{ err }}</p>
    </div>

    <div
      v-for="p in store.projects"
      :key="p.id"
      class="card card-clickable"
      @click="router.push(`/projects/${p.id}`)"
    >
      <div class="project-item-header">
        <strong class="project-name">{{ p.name }}</strong>
        <span v-if="p.id === store.activeId" class="badge">当前</span>
      </div>
      <div class="card-meta">{{ p.localRootLabel }}</div>
    </div>
  </main>
</template>

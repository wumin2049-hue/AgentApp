<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';
import { useAgentSettingsStore } from '@/stores/agentSettings';

const router = useRouter();
const projects = useProjectsStore();
const agentSettings = useAgentSettingsStore();
const active = computed(() => projects.active);
</script>

<template>
  <header class="app-header">
    <h1>mincode</h1>
    <div class="sub">移动端 AI 编程助手 · 多项目 · 本地改码 · FTP 同步</div>
  </header>
  <main class="app-main">
    <div class="card">
      <template v-if="active">
        <span class="card-title">当前项目</span>
        <div class="project-name">{{ active.name }}</div>
        <div class="card-meta">
          <div class="meta-row"><span aria-hidden="true">📁</span><span>{{ active.localRootLabel }}</span></div>
          <div class="meta-row"><span aria-hidden="true">🤖</span><span>{{ agentSettings.config.model || '未选模型' }}</span></div>
          <div class="meta-row"><span aria-hidden="true">🌐</span><span>{{ agentSettings.config.apiBaseUrl || '未配置 API' }}</span></div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" @click="router.push('/chat')">开始改代码</button>
          <button class="btn btn-ghost" @click="router.push('/ftp')">FTP 文件</button>
        </div>
      </template>
      <template v-else>
        <p class="hint-text">还没有项目。请先在「设置」配置 API，再到「项目」创建并绑定手机目录。</p>
        <button class="btn btn-primary btn-block" style="margin-top:14px" @click="router.push('/projects')">
          新建项目
        </button>
      </template>
    </div>

    <div class="card">
      <span class="card-title">工作流</span>
      <ol class="flow-list">
        <li>在「设置」里配置 API 地址、Key 与模型（全局共用）</li>
        <li>选择手机本地代码目录</li>
        <li>对话中 AI 读写本地沙盒中的项目文件</li>
        <li>改完后一键 FTP 上传变更文件</li>
      </ol>
    </div>

    <router-link to="/settings" class="section-link">全局设置 →</router-link>
  </main>
</template>

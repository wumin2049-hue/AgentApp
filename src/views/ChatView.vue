<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';
import { useAgentSettingsStore } from '@/stores/agentSettings';
import { useChatStore } from '@/stores/chat';
import { runAgentLoop } from '@/services/agentLoop';
import { getModifiedFiles, clearModifiedFiles, exportModifiedToPhone, listLocalEntries } from '@/services/localFs';
import { ftpUploadModifiedProject } from '@/plugins/ftp';
import { parseSlashCommand, runSlashCommand } from '@/api/mediaRelay';
import { scopeLabel } from '@/services/projectScope';
import ChatMessage from '@/components/ChatMessage.vue';

const router = useRouter();
const projects = useProjectsStore();
const agentSettings = useAgentSettingsStore();
const chat = useChatStore();

const aiStatusLine = computed(() => {
  if (!agentSettings.isConfigured) return '';
  const model = agentSettings.config.model?.trim();
  const host = agentSettings.config.apiBaseUrl.replace(/^https?:\/\//, '').split('/')[0];
  return model ? `${model} · ${host}` : host;
});
const input = ref('');
const busy = ref(false);
const uploadBusy = ref(false);
const exportBusy = ref(false);
const uploadMsg = ref('');
const exportMsg = ref('');
const statusMsg = ref('');
const selectedId = ref('');
const workRootInput = ref('');
const topDirs = ref<string[]>([]);

const project = computed(() =>
  projects.projects.find((p) => p.id === selectedId.value) || projects.active,
);

const workRootHint = computed(() => scopeLabel(chat.workRoot));

const harnessMemoryHint = computed(() => {
  const d = chat.harnessDigest;
  const parts: string[] = [];
  if (d.read_files.length) parts.push(`已读 ${d.read_files.length}`);
  if (d.modified_files.length) parts.push(`已改 ${d.modified_files.length}`);
  if (d.grep_keys.length) parts.push(`已搜 ${d.grep_keys.length}`);
  return parts.length ? `会话工具记忆：${parts.join(' · ')}` : '';
});

async function loadTopDirs() {
  if (!project.value) {
    topDirs.value = [];
    return;
  }
  try {
    const entries = await listLocalEntries(project.value, '');
    topDirs.value = entries.filter((e) => e.isDirectory).map((e) => e.name);
  } catch {
    topDirs.value = [];
  }
}

async function onProjectChange(id: string) {
  if (busy.value || chat.streaming) return;
  selectedId.value = id;
  await projects.setActive(id);
  await chat.loadForProject(id);
  workRootInput.value = chat.workRoot;
  await loadTopDirs();
}

async function applyWorkRoot() {
  await chat.setWorkRoot(workRootInput.value.trim());
  workRootInput.value = chat.workRoot;
}

function useSubdir(dir: string) {
  workRootInput.value = dir;
  chat.setWorkRoot(dir);
}

onMounted(async () => {
  if (!projects.loaded) await projects.load();
  selectedId.value = projects.activeId || projects.projects[0]?.id || '';
  if (selectedId.value) {
    await chat.loadForProject(selectedId.value);
    workRootInput.value = chat.workRoot;
  }
  await loadTopDirs();
});

watch(
  () => chat.workRoot,
  (v) => {
    workRootInput.value = v;
  },
);

async function send() {
  const text = input.value.trim();
  if (!text || !project.value || busy.value) return;
  if (!agentSettings.isConfigured) {
    chat.setError('请先在「设置」中配置 API 地址与 Key');
    return;
  }
  if (!agentSettings.config.model?.trim()) {
    chat.setError('请先在「设置」中选择默认模型');
    return;
  }

  const prior = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  chat.clearTurn();
  chat.pushUser(text);
  const assistantId = chat.beginAssistant();
  input.value = '';
  busy.value = true;
  statusMsg.value = '';
  chat.setStreaming(true);

  try {
    const slash = parseSlashCommand(text);
    if (slash) {
      const content = await runSlashCommand(
        agentSettings.agentConfig,
        slash,
        agentSettings.config.model || '',
        (s) => {
          statusMsg.value = s;
        },
      );
      chat.updateAssistant(assistantId, content);
      chat.applyResult({ content, toolLog: [], modifiedFiles: [] }, assistantId);
      await chat.persist();
      return;
    }

    const result = await runAgentLoop(
      project.value,
      agentSettings.agentConfig,
      text,
      (e) => {
        if (e.type === 'delta') {
          chat.updateAssistant(assistantId, e.content, e.reasoning);
        }
        if (e.type === 'tool') {
          chat.toolLog.push(e.entry);
        }
        if (e.type === 'round') {
          statusMsg.value = e.forceWrite ? `第 ${e.round} 轮 · 强制落盘…` : `第 ${e.round} 轮…`;
        }
      },
      30,
      prior,
      chat.workRoot,
      chat.harnessDigest,
    );
    chat.applyResult(result, assistantId);
    await chat.persist();
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
    await chat.persist();
  } finally {
    busy.value = false;
    chat.setStreaming(false);
    statusMsg.value = '';
  }
}

async function exportToPhone() {
  if (!project.value) return;
  exportBusy.value = true;
  exportMsg.value = '';
  try {
    const files = chat.lastModified.length
      ? chat.lastModified
      : await getModifiedFiles(project.value.id);
    if (!files.length) {
      exportMsg.value = '没有待写回的修改记录';
      return;
    }
    const result = await exportModifiedToPhone(project.value, files);
    const errHint = result.errors?.length ? `（${result.errors.length} 个失败）` : '';
    exportMsg.value = `已写回手机 ${result.exported} 个文件${errHint}`;
  } catch (e) {
    exportMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    exportBusy.value = false;
  }
}

async function uploadModified() {
  if (!project.value) return;
  uploadBusy.value = true;
  uploadMsg.value = '';
  try {
    const files = await getModifiedFiles(project.value.id);
    if (!files.length) {
      uploadMsg.value = '没有待上传的修改记录';
      return;
    }
    const done = await ftpUploadModifiedProject(project.value, files);
    uploadMsg.value = `已上传 ${done.length} 个文件：${done.join('、')}`;
    await clearModifiedFiles(project.value.id);
  } catch (e) {
    uploadMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploadBusy.value = false;
  }
}
</script>

<template>
  <header class="app-header">
    <h1>Agent 对话</h1>
    <div class="sub" v-if="project && aiStatusLine">工具在本地执行 · {{ aiStatusLine }}</div>
    <div class="sub" v-else-if="project">工具在本地沙盒执行 · 路径受工作区限制</div>
    <div class="sub text-danger" v-else>请先创建并选择项目</div>
  </header>

  <main class="app-main">
    <div v-if="!agentSettings.isConfigured" class="card card-warn">
      <p class="hint-text" style="margin:0">尚未配置 AI。请在设置里填写 API 地址与 Key，测试连接后拉取并选择模型。</p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/settings')">
        去设置
      </button>
    </div>
    <div class="card" style="padding:14px">
      <label class="field-label">当前项目</label>
      <select
        class="project-select"
        :value="selectedId"
        :disabled="busy || chat.streaming || !projects.projects.length"
        @change="onProjectChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in projects.projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>

      <template v-if="project">
        <p class="ftp-context-hint" style="margin-top:10px">
          📁 项目根：<strong>{{ project.localRootLabel }}</strong>
          <span class="scope-tag">沙盒 /</span>
        </p>

        <div class="field" style="margin-top:12px;margin-bottom:0">
          <label>AI 工作区（仅允许改此目录下文件）</label>
          <div class="work-root-row">
            <input
              v-model="workRootInput"
              placeholder="留空 = 整个项目根；或填 src、api 等子目录"
              :disabled="busy || chat.streaming"
              @change="applyWorkRoot"
            />
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :disabled="busy || chat.streaming"
              @click="applyWorkRoot"
            >
              应用
            </button>
          </div>
        </div>

        <div v-if="topDirs.length" class="subdir-chips">
          <button
            type="button"
            class="chip"
            :class="{ active: !chat.workRoot }"
            @click="useSubdir('')"
          >
            项目根 /
          </button>
          <button
            v-for="d in topDirs"
            :key="d"
            type="button"
            class="chip"
            :class="{ active: chat.workRoot === d }"
            @click="useSubdir(d)"
          >
            {{ d }}/
          </button>
        </div>

        <p class="scope-hint">当前工作区：{{ workRootHint }}</p>
        <p v-if="harnessMemoryHint" class="scope-hint memory-hint">
          {{ harnessMemoryHint }}
          <button
            type="button"
            class="btn-link"
            :disabled="busy || chat.streaming"
            @click="chat.clearHarnessMemory()"
          >
            清空记忆
          </button>
        </p>
      </template>
    </div>

    <div v-if="!projects.projects.length" class="card">
      <p class="hint-text">还没有项目，请先在「项目」页创建并绑定手机目录。</p>
    </div>

    <ChatMessage
      v-for="m in chat.messages"
      :key="m.id"
      :message="m"
      :streaming="chat.streaming && m.role === 'assistant' && !m.content"
    />

    <p v-if="statusMsg" class="status-line">{{ statusMsg }}</p>

    <div v-if="chat.toolLog.length" class="tool-card">
      <span class="card-title">工具轨迹</span>
      <div
        v-for="(t, i) in chat.toolLog"
        :key="i"
        class="tool-line"
        :class="t.ok ? 'ok' : 'fail'"
      >
        {{ t.ok ? '✓' : '✕' }} {{ t.label }}
      </div>
    </div>

    <p v-if="chat.error" class="hint-text err">{{ chat.error }}</p>
    <p v-if="uploadMsg" class="hint-text ok">{{ uploadMsg }}</p>
    <p v-if="exportMsg" class="hint-text ok">{{ exportMsg }}</p>

    <div class="chat-input-wrap">
      <div class="chat-input-bar">
        <textarea
          v-model="input"
          placeholder="描述要改什么… 或 /img /video 提示词"
          :disabled="!project || busy"
          @keydown.enter.exact.prevent="send"
        />
        <button class="btn btn-primary" :disabled="!project || busy" @click="send">
          {{ busy ? '…' : '发送' }}
        </button>
      </div>
      <p class="slash-hint">斜杠命令：<code>/img</code> <code>/img-async</code> <code>/video</code> <code>/video-quote</code></p>
      <div class="chat-actions">
        <button class="btn btn-ghost" :disabled="!project || exportBusy" @click="exportToPhone">
          {{ exportBusy ? '写回中…' : '写回手机' }}
        </button>
        <button class="btn btn-ghost" :disabled="!project || uploadBusy" @click="uploadModified">
          {{ uploadBusy ? '上传中…' : 'FTP 上传' }}
        </button>
        <button class="btn btn-ghost btn-compact" :disabled="busy" @click="chat.clear()">清空对话</button>
      </div>
    </div>
  </main>
</template>

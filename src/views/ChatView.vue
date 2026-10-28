<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';
import { useAgentSettingsStore } from '@/stores/agentSettings';
import { useChatStore } from '@/stores/chat';
import { runAgentLoop } from '@/services/agentLoop';
import { getModifiedFiles, removeModifiedFiles, exportModifiedToPhone, listLocalEntries } from '@/services/localFs';
import { ftpUploadModifiedProject } from '@/plugins/ftp';
import { parseSlashCommand, runSlashCommand } from '@/api/mediaRelay';
import { scopeLabel } from '@/services/projectScope';
import ChatMessage from '@/components/ChatMessage.vue';
import { nextTick } from 'vue';

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
const sessionBusy = ref(false);
const projectSheetOpen = ref(false);
const historyDrawerOpen = ref(false);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const messagesEndEl = ref<HTMLElement | null>(null);
const abortCtl = ref<AbortController | null>(null);
const dockPad = ref(0);
const toolDetailOpen = ref(false);
const modifiedSheetOpen = ref(false);
const selectedModified = ref<string[]>([]);
const ftpProgress = ref('');
const ftpUploading = ref(false);

const lastAssistantId = computed(() => {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'assistant') return chat.messages[i].id;
  }
  return '';
});

const turnModifiedList = computed(() => {
  if (chat.turnModifiedFiles.length) return chat.turnModifiedFiles;
  // 流式过程中从工具日志推断写文件
  return [
    ...new Set(
      chat.toolLog
        .filter((t) => t.ok && (t.name === 'write_file' || t.name === 'search_replace') && t.path)
        .map((t) => t.path as string),
    ),
  ];
});

const allModifiedSelected = computed(
  () =>
    turnModifiedList.value.length > 0 &&
    turnModifiedList.value.every((f) => selectedModified.value.includes(f)),
);

const project = computed(() =>
  projects.projects.find((p) => p.id === selectedId.value) || projects.active,
);

const workRootHint = computed(() => scopeLabel(chat.workRoot));

/** 发送条件：不用于禁用输入框，避免 WebView 无法聚焦 */
const canSend = computed(
  () =>
    Boolean(project.value) &&
    agentSettings.hasChatStorageRoot &&
    agentSettings.storageAccessOk &&
    chat.storageReady &&
    agentSettings.isConfigured &&
    Boolean(agentSettings.config.model?.trim()) &&
    !busy.value &&
    !chat.streaming,
);

const sendBlockedReason = computed(() => {
  if (busy.value || chat.streaming) return '';
  if (!project.value) return '请先创建并选择项目';
  if (!agentSettings.hasChatStorageRoot || !agentSettings.storageAccessOk) {
    return '请先在设置中选择手机文件夹并允许访问（读/写/列表）';
  }
  if (!chat.storageReady) return '会话存储未就绪，请到设置重新授权手机目录';
  if (!agentSettings.isConfigured) return '请先在设置中填写 API 地址与 Key';
  if (!agentSettings.config.model?.trim()) return '请先在设置中选择或填写默认模型';
  return '';
});

const inputLocked = computed(() => busy.value || chat.streaming);

/** 打开/切换/删除/新建会话：只需存储就绪，不要求已配好模型 */
const canManageSessions = computed(
  () =>
    Boolean(project.value) &&
    agentSettings.hasChatStorageRoot &&
    agentSettings.storageAccessOk &&
    chat.storageReady &&
    !busy.value &&
    !chat.streaming &&
    !sessionBusy.value,
);

const currentSessionTitle = computed(
  () => chat.activeSession?.title?.trim() || '新会话',
);

const harnessMemoryHint = computed(() => {
  const d = chat.harnessDigest;
  const parts: string[] = [];
  if (d.read_files.length) parts.push(`已读 ${d.read_files.length}`);
  if (d.modified_files.length) parts.push(`已改 ${d.modified_files.length}`);
  if (d.grep_keys.length) parts.push(`已搜 ${d.grep_keys.length}`);
  return parts.length ? `会话工具记忆：${parts.join(' · ')}` : '';
});

function formatSessionTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mi = `${d.getMinutes()}`.padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function focusChatInput() {
  requestAnimationFrame(() => {
    inputEl.value?.focus({ preventScroll: true });
  });
}

function openProjectSheet() {
  projectSheetOpen.value = true;
  workRootInput.value = chat.workRoot;
  void loadTopDirs();
}

function closeProjectSheet() {
  if (!projectSheetOpen.value) return;
  projectSheetOpen.value = false;
  if (!historyDrawerOpen.value) document.body.style.overflow = '';
  focusChatInput();
}

function openProjectSheetSafe() {
  openProjectSheet();
  document.body.style.overflow = 'hidden';
}

function openHistoryDrawer() {
  historyDrawerOpen.value = true;
  document.body.style.overflow = 'hidden';
}

function closeHistoryDrawer() {
  if (!historyDrawerOpen.value) return;
  historyDrawerOpen.value = false;
  if (!projectSheetOpen.value) document.body.style.overflow = '';
  focusChatInput();
}

function openHistoryFromProjectSheet() {
  closeProjectSheet();
  openHistoryDrawer();
}

function onProjectSheetKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (historyDrawerOpen.value) {
    e.preventDefault();
    closeHistoryDrawer();
    return;
  }
  if (projectSheetOpen.value) {
    e.preventDefault();
    closeProjectSheet();
  }
}

async function scrollToBottom() {
  await nextTick();
  messagesEndEl.value?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function stopGeneration() {
  abortCtl.value?.abort();
}

function onViewportResize() {
  const vv = window.visualViewport;
  if (!vv) return;
  const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  dockPad.value = overlap > 40 ? overlap : 0;
}

function confirmClearSession() {
  if (!window.confirm('清空当前会话的全部消息？此操作不可恢复。')) return;
  void chat.clear();
}

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
  if (busy.value || chat.streaming || sessionBusy.value) return;
  selectedId.value = id;
  await projects.setActive(id);
  await chat.loadForProject(id, true);
  workRootInput.value = chat.workRoot;
  await loadTopDirs();
}

async function applyWorkRoot() {
  await chat.setWorkRoot(workRootInput.value.trim());
  workRootInput.value = chat.workRoot;
}

function useSubdir(dir: string) {
  workRootInput.value = dir;
  void chat.setWorkRoot(dir);
}

async function onNewSession() {
  if (!canManageSessions.value) return;
  sessionBusy.value = true;
  try {
    await chat.createSession();
    closeHistoryDrawer();
    closeProjectSheet();
    void scrollToBottom();
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  } finally {
    sessionBusy.value = false;
  }
}

async function onSwitchSession(id: string) {
  if (!canManageSessions.value || id === chat.sessionId) {
    if (id === chat.sessionId) closeHistoryDrawer();
    return;
  }
  sessionBusy.value = true;
  try {
    await chat.switchSession(id);
    closeHistoryDrawer();
    void scrollToBottom();
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  } finally {
    sessionBusy.value = false;
  }
}

async function onDeleteSession(id: string) {
  if (!canManageSessions.value) return;
  if (!window.confirm('删除该会话及其全部消息？此操作不可恢复。')) return;
  sessionBusy.value = true;
  try {
    await chat.deleteSession(id);
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  } finally {
    sessionBusy.value = false;
  }
}

async function onDeleteMessage(id: string) {
  if (busy.value || chat.streaming) return;
  if (!window.confirm('删除这条消息？')) return;
  try {
    await chat.deleteMessage(id);
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  }
}

onMounted(async () => {
  if (!agentSettings.loaded) await agentSettings.load();
  if (!projects.loaded) await projects.load();
  selectedId.value = projects.activeId || projects.projects[0]?.id || '';
  if (selectedId.value) {
    await chat.loadForProject(selectedId.value, true);
    workRootInput.value = chat.workRoot;
  }
  await loadTopDirs();
  window.addEventListener('keydown', onGlobalKeydown);
  window.visualViewport?.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('scroll', onViewportResize);
  focusChatInput();
  void scrollToBottom();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
  window.visualViewport?.removeEventListener('scroll', onViewportResize);
  document.body.style.overflow = '';
  abortCtl.value?.abort();
});

watch(
  () => chat.messages.length,
  () => {
    void scrollToBottom();
  },
);

watch(
  () => chat.workRoot,
  (v) => {
    workRootInput.value = v;
  },
);

watch(
  () => agentSettings.hasChatStorageRoot,
  async (ok) => {
    if (ok && selectedId.value) {
      await chat.loadForProject(selectedId.value, true);
    }
  },
);

async function send() {
  const text = input.value.trim();
  if (!text || !project.value || busy.value || chat.streaming) return;
  if (!agentSettings.hasChatStorageRoot) {
    chat.setError('请先在「设置」中选择会话数据存储目录');
    return;
  }
  if (!chat.storageReady) {
    chat.setError('会话存储尚未就绪，请稍候或检查存储目录');
    return;
  }
  if (!agentSettings.isConfigured) {
    chat.setError('请先在「设置」中配置 API 地址与 Key');
    return;
  }
  if (!agentSettings.config.model?.trim()) {
    chat.setError('请先在「设置」中选择默认模型');
    return;
  }

  // 同步加锁，防止连点双发
  busy.value = true;
  chat.setStreaming(true);
  statusMsg.value = '';

  const prior = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  chat.clearTurn();
  chat.pushUser(text);
  const assistantId = chat.beginAssistant();
  input.value = '';
  void scrollToBottom();

  const ctl = new AbortController();
  abortCtl.value = ctl;

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
        ctl.signal,
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
          void scrollToBottom();
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
      ctl.signal,
    );
    chat.applyResult(result, assistantId);
    await chat.persist();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    const msg = aborted ? '已停止生成' : e instanceof Error ? e.message : String(e);
    chat.setError(msg);
    chat.fillAssistantError(assistantId, msg);
    await chat.persist();
  } finally {
    if (abortCtl.value === ctl) abortCtl.value = null;
    busy.value = false;
    chat.setStreaming(false);
    statusMsg.value = '';
    focusChatInput();
    void scrollToBottom();
  }
}

async function exportToPhone() {
  if (!project.value) return;
  exportBusy.value = true;
  exportMsg.value = '';
  try {
    const files = await getModifiedFiles(project.value.id);
    if (!files.length) {
      exportMsg.value = '没有待写回的修改记录';
      return;
    }
    const result = await exportModifiedToPhone(project.value, files);
    const errHint = result.errors?.length ? `（${result.errors.length} 个失败）` : '';
    exportMsg.value = `已写回手机 ${result.exported}/${files.length} 个文件${errHint}`;
    if (result.exported > 0) {
      // 仅移除成功写出的路径较难精确对齐时，保留全部并提示用户可再试失败项
      // export API 未返回成功列表时保持累计列表，由沙盒记录为准
    }
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
    const fail = files.length - done.length;
    uploadMsg.value = fail
      ? `已上传 ${done.length}/${files.length}，失败 ${fail} 个仍保留在队列`
      : `已上传 ${done.length} 个文件：${done.join('、') || '—'}`;
    await removeModifiedFiles(project.value.id, done);
  } catch (e) {
    uploadMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploadBusy.value = false;
  }
}

function openToolDetail() {
  toolDetailOpen.value = true;
  document.body.style.overflow = 'hidden';
}

function closeToolDetail() {
  toolDetailOpen.value = false;
  document.body.style.overflow = '';
}

function openModifiedSheet() {
  selectedModified.value = [...turnModifiedList.value];
  ftpProgress.value = '';
  modifiedSheetOpen.value = true;
  document.body.style.overflow = 'hidden';
}

function closeModifiedSheet() {
  if (ftpUploading.value) return;
  modifiedSheetOpen.value = false;
  document.body.style.overflow = '';
}

function toggleSelectAll() {
  if (allModifiedSelected.value) {
    selectedModified.value = [];
  } else {
    selectedModified.value = [...turnModifiedList.value];
  }
}

function toggleModifiedFile(path: string) {
  const i = selectedModified.value.indexOf(path);
  if (i >= 0) selectedModified.value.splice(i, 1);
  else selectedModified.value.push(path);
}

async function uploadSelectedToFtp() {
  if (!project.value || ftpUploading.value) return;
  const files = selectedModified.value.filter(Boolean);
  if (!files.length) {
    ftpProgress.value = '请至少勾选一个文件';
    return;
  }
  if (!project.value.ftp?.host?.trim()) {
    ftpProgress.value = '请先在项目设置中配置 FTP';
    return;
  }

  ftpUploading.value = true;
  ftpProgress.value = `准备上传 0/${files.length}…`;
  const done: string[] = [];
  const failed: string[] = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const rel = files[i];
      ftpProgress.value = `正在上传 ${i + 1}/${files.length}：${rel}`;
      try {
        const batch = await ftpUploadModifiedProject(project.value, [rel]);
        if (batch.includes(rel)) {
          done.push(rel);
        } else {
          failed.push(rel);
        }
      } catch {
        failed.push(rel);
      }
    }
    if (done.length) {
      await removeModifiedFiles(project.value.id, done);
      chat.removeTurnModified(done);
      selectedModified.value = selectedModified.value.filter((f) => !done.includes(f));
    }
    ftpProgress.value = failed.length
      ? `完成：成功 ${done.length}，失败 ${failed.length}（${failed.join('、')}）`
      : `全部上传成功（${done.length}）`;
    uploadMsg.value = ftpProgress.value;
  } catch (e) {
    ftpProgress.value = e instanceof Error ? e.message : String(e);
  } finally {
    ftpUploading.value = false;
  }
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (modifiedSheetOpen.value) {
      e.preventDefault();
      closeModifiedSheet();
      return;
    }
    if (toolDetailOpen.value) {
      e.preventDefault();
      closeToolDetail();
      return;
    }
  }
  onProjectSheetKeydown(e);
}
</script>

<template>
  <header class="app-header chat-header">
    <div class="chat-header-row">
      <button
        type="button"
        class="chat-header-btn"
        title="会话记录"
        aria-label="打开会话记录"
        :disabled="!agentSettings.hasChatStorageRoot || !project"
        @click="openHistoryDrawer"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div class="chat-header-titles">
        <h1>{{ currentSessionTitle }}</h1>
        <div class="sub" v-if="project && aiStatusLine">
          {{ project.name }} · {{ aiStatusLine }}
        </div>
        <div class="sub" v-else-if="project">{{ project.name }} · 工具在本地沙盒执行</div>
        <div class="sub text-danger" v-else>请先创建并选择项目</div>
      </div>
      <button
        type="button"
        class="chat-header-btn"
        title="新会话"
        aria-label="开启新会话"
        :disabled="!canManageSessions"
        @click="onNewSession"
      >
        <span aria-hidden="true">＋</span>
      </button>
    </div>
  </header>

  <main class="app-main chat-main">
    <div v-if="!agentSettings.hasChatStorageRoot || !agentSettings.storageAccessOk" class="card card-warn">
      <p class="hint-text" style="margin:0">
        需要授权手机本地文件夹（读/写/列表）。系统会弹出目录选择器，请点「使用此文件夹」。未授权时无法读写代码与会话。
      </p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/settings')">
        去授权手机目录
      </button>
    </div>

    <div v-else-if="!agentSettings.isConfigured" class="card card-warn">
      <p class="hint-text" style="margin:0">尚未配置 AI。请在设置里填写 API 地址与 Key，测试连接后拉取并选择模型。</p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/settings')">
        去设置
      </button>
    </div>

    <div v-else-if="!agentSettings.config.model?.trim()" class="card card-warn">
      <p class="hint-text" style="margin:0">已配置 API，但还没选默认模型。请到设置拉取模型列表并点选一个。</p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/settings')">
        去选择模型
      </button>
    </div>

    <div v-else-if="!chat.storageReady && project" class="card card-warn">
      <p class="hint-text" style="margin:0">
        会话存储未就绪{{ chat.error ? `：${chat.error}` : '' }}。请重新选择手机目录并允许访问。
      </p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/settings')">
        重新授权目录
      </button>
    </div>

    <div v-if="!projects.projects.length" class="card">
      <p class="hint-text">还没有项目，请先在「项目」页创建并绑定手机目录。</p>
    </div>

    <p v-if="chat.nearMessageCap" class="hint-text" style="margin:8px 0">
      提示：会话消息接近上限（{{ chat.messageCap }} 条），更早的消息保存时可能被截断。
    </p>

    <template v-for="m in chat.messages" :key="m.id">
      <!-- 工具/读文件记录：放在最终 AI 回复气泡之上 -->
      <div
        v-if="m.id === lastAssistantId && chat.toolLog.length"
        class="tool-log-panel"
      >
        <div class="tool-log-head">
          <span class="tool-log-title">读取与工具记录 · {{ chat.toolLog.length }}</span>
        </div>
        <div class="tool-log-scroll">
          <div
            v-for="(t, i) in chat.toolLog"
            :key="i"
            class="tool-line"
            :class="t.ok ? 'ok' : 'fail'"
          >
            {{ t.ok ? '✓' : '✕' }} {{ t.label }}
          </div>
        </div>
        <button type="button" class="tool-log-detail" @click="openToolDetail">
          查看详情
        </button>
      </div>

      <ChatMessage
        :message="m"
        :streaming="chat.streaming && m.role === 'assistant' && !m.content"
        :deletable="!busy && !chat.streaming && agentSettings.hasChatStorageRoot"
        @delete="onDeleteMessage"
      />

      <!-- 最终回复下方：查看本轮修改文件 -->
      <div
        v-if="m.id === lastAssistantId && turnModifiedList.length && !chat.streaming"
        class="turn-modified-bar"
      >
        <button type="button" class="btn btn-ghost btn-block" @click="openModifiedSheet">
          查看 AI 实际修改的文件（{{ turnModifiedList.length }}）
        </button>
      </div>
    </template>

    <p v-if="statusMsg" class="status-line">{{ statusMsg }}</p>
    <button
      v-if="busy || chat.streaming"
      type="button"
      class="btn btn-ghost btn-sm"
      style="margin:8px 0"
      @click="stopGeneration"
    >
      停止生成
    </button>

    <p v-if="chat.error" class="hint-text err">{{ chat.error }}</p>
    <div ref="messagesEndEl" aria-hidden="true" />
  </main>

  <div class="chat-input-dock" :style="dockPad ? { bottom: `calc(64px + var(--safe-b) + ${dockPad}px)` } : undefined">
    <div class="chat-input-wrap chat-input-wrap--compact">
      <div class="chat-input-bar">
        <textarea
          ref="inputEl"
          v-model="input"
          placeholder="描述要改什么… 或 /img /video 提示词"
          :readonly="inputLocked"
          enterkeyhint="send"
          autocomplete="off"
          autocapitalize="sentences"
          rows="2"
          @keydown.enter.exact.prevent="send"
          @pointerdown.stop
        />
        <button
          v-if="busy || chat.streaming"
          class="btn btn-ghost"
          type="button"
          @click="stopGeneration"
        >
          停止
        </button>
        <button
          v-else
          class="btn btn-primary"
          :disabled="!canSend || !input.trim()"
          :title="sendBlockedReason || '发送'"
          @click="send"
        >
          发送
        </button>
      </div>
      <p v-if="sendBlockedReason && input.trim()" class="hint-text err" style="margin:6px 4px 0;font-size:12px">
        {{ sendBlockedReason }}
      </p>
    </div>
  </div>

  <button
    type="button"
    class="chat-fab"
    title="项目与工作区"
    aria-label="打开项目设置"
    @click="openProjectSheetSafe"
  >
    <span class="chat-fab-icon" aria-hidden="true">▤</span>
  </button>

  <div
    v-if="historyDrawerOpen"
    class="sheet-overlay history-drawer-overlay"
    @click.self="closeHistoryDrawer"
  >
    <aside
      class="history-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="会话记录"
    >
      <div class="history-drawer-header">
        <div class="history-drawer-titles">
          <strong>会话记录</strong>
          <span class="history-drawer-sub">
            {{ agentSettings.chatStorageRoot?.label || '未选择存储目录' }}
          </span>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="closeHistoryDrawer">
          关闭
        </button>
      </div>
      <div class="history-drawer-toolbar">
        <button
          type="button"
          class="btn btn-primary btn-block"
          :disabled="!canManageSessions"
          @click="onNewSession"
        >
          {{ sessionBusy ? '创建中…' : '开启新会话' }}
        </button>
      </div>
      <div class="history-drawer-body">
        <div v-if="!chat.storageReady" class="hint-text">会话存储未就绪</div>
        <div v-else-if="!chat.sessions.length" class="hint-text">暂无会话，点上方开启新会话</div>
        <ul v-else class="session-list session-list--drawer">
          <li
            v-for="s in chat.sessions"
            :key="s.id"
            class="session-item"
            :class="{ active: s.id === chat.sessionId }"
          >
            <button
              type="button"
              class="session-main"
              :disabled="busy || chat.streaming || sessionBusy"
              @click="onSwitchSession(s.id)"
            >
              <span class="session-title">{{ s.title || '未命名会话' }}</span>
              <span class="session-meta">
                {{ formatSessionTime(s.updatedAt) }}
                <template v-if="s.messageCount"> · {{ s.messageCount }} 条</template>
              </span>
              <span v-if="s.preview" class="session-preview">{{ s.preview }}</span>
            </button>
            <button
              type="button"
              class="session-del"
              title="删除会话"
              :disabled="!canManageSessions"
              @click.stop="onDeleteSession(s.id)"
            >
              删除
            </button>
          </li>
        </ul>
      </div>
    </aside>
  </div>

  <div
    v-if="projectSheetOpen"
    class="sheet-overlay"
    @click.self="closeProjectSheet"
  >
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="项目与工作区">
      <div class="sheet-header">
        <strong>项目与工作区</strong>
        <button type="button" class="btn btn-ghost btn-sm" @click="closeProjectSheet">关闭</button>
      </div>
      <div class="sheet-body">
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
            <span aria-hidden="true">📁</span> 项目根：<strong>{{ project.localRootLabel }}</strong>
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
        <p v-else class="hint-text" style="margin-top:12px">请先创建项目</p>

        <div class="sheet-section">
          <label class="field-label">会话操作</label>
          <button
            class="btn btn-primary btn-block"
            type="button"
            :disabled="!canManageSessions"
            @click="onNewSession"
          >
            {{ sessionBusy ? '创建中…' : '开启新会话' }}
          </button>
          <button
            class="btn btn-ghost btn-block"
            type="button"
            style="margin-top:8px"
            :disabled="!agentSettings.hasChatStorageRoot || !project"
            @click="openHistoryFromProjectSheet"
          >
            查看会话记录
          </button>
          <div class="chat-actions chat-actions--sheet">
            <button class="btn btn-ghost" type="button" :disabled="!project || exportBusy" @click="exportToPhone">
              {{ exportBusy ? '写回中…' : '写回手机' }}
            </button>
            <button class="btn btn-ghost" type="button" :disabled="!project || uploadBusy" @click="uploadModified">
              {{ uploadBusy ? '上传中…' : 'FTP 上传' }}
            </button>
            <button
              class="btn btn-ghost btn-compact"
              type="button"
              :disabled="busy || chat.streaming || !chat.storageReady"
              @click="confirmClearSession"
            >
              清空当前会话
            </button>
          </div>
          <p class="slash-hint slash-hint--sheet">
            斜杠命令（需图像/视频能力模型）：<code>/img</code> <code>/img-async</code> <code>/video</code> <code>/video-quote</code>
          </p>
          <p v-if="uploadMsg" class="hint-text ok" style="margin-top:8px">{{ uploadMsg }}</p>
          <p v-if="exportMsg" class="hint-text ok" style="margin-top:8px">{{ exportMsg }}</p>
        </div>
      </div>
    </div>
  </div>

  <!-- 工具记录详情 -->
  <div
    v-if="toolDetailOpen"
    class="sheet-overlay"
    @click.self="closeToolDetail"
  >
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="工具记录详情">
      <div class="sheet-header">
        <strong>读取与工具记录</strong>
        <button type="button" class="btn btn-ghost btn-sm" @click="closeToolDetail">关闭</button>
      </div>
      <div class="sheet-body">
        <div
          v-for="(t, i) in chat.toolLog"
          :key="i"
          class="tool-detail-line"
          :class="t.ok ? 'ok' : 'fail'"
        >
          <div class="tool-detail-name">{{ t.ok ? '✓' : '✕' }} {{ t.name }}</div>
          <div class="tool-detail-label">{{ t.label }}</div>
          <div v-if="t.path" class="tool-detail-path">{{ t.path }}</div>
        </div>
        <p v-if="!chat.toolLog.length" class="hint-text">暂无记录</p>
      </div>
    </div>
  </div>

  <!-- 本轮修改文件 + FTP 上传 -->
  <div
    v-if="modifiedSheetOpen"
    class="sheet-overlay"
    @click.self="closeModifiedSheet"
  >
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="AI 修改的文件">
      <div class="sheet-header">
        <strong>AI 修改的文件</strong>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="ftpUploading"
          @click="closeModifiedSheet"
        >
          关闭
        </button>
      </div>
      <div class="sheet-body">
        <div class="modified-toolbar">
          <label class="modified-check-all">
            <input
              type="checkbox"
              :checked="allModifiedSelected"
              :disabled="ftpUploading"
              @change="toggleSelectAll"
            />
            全选 / 取消全选
          </label>
          <span class="hint-text" style="margin:0">
            已选 {{ selectedModified.length }}/{{ turnModifiedList.length }}
          </span>
        </div>

        <ul class="modified-list">
          <li v-for="f in turnModifiedList" :key="f" class="modified-item">
            <label>
              <input
                type="checkbox"
                :checked="selectedModified.includes(f)"
                :disabled="ftpUploading"
                @change="toggleModifiedFile(f)"
              />
              <span class="modified-path">{{ f }}</span>
            </label>
          </li>
        </ul>

        <button
          type="button"
          class="btn btn-primary btn-block"
          style="margin-top:14px"
          :disabled="ftpUploading || !selectedModified.length"
          @click="uploadSelectedToFtp"
        >
          {{ ftpUploading ? '上传中…' : '一键上传 FTP' }}
        </button>
        <p v-if="ftpProgress" class="hint-text" style="margin-top:10px;white-space:pre-wrap">
          {{ ftpProgress }}
        </p>
      </div>
    </div>
  </div>
</template>

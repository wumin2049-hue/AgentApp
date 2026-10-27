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
const inputEl = ref<HTMLTextAreaElement | null>(null);
const messagesEndEl = ref<HTMLElement | null>(null);
const sessionListCollapsed = ref(true);
const abortCtl = ref<AbortController | null>(null);
const dockPad = ref(0);

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
  document.body.style.overflow = '';
  focusChatInput();
}

function openProjectSheetSafe() {
  openProjectSheet();
  document.body.style.overflow = 'hidden';
}

function onProjectSheetKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && projectSheetOpen.value) {
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
  if (!canSend.value || sessionBusy.value) return;
  sessionBusy.value = true;
  try {
    await chat.createSession();
    closeProjectSheet();
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  } finally {
    sessionBusy.value = false;
  }
}

async function onSwitchSession(id: string) {
  if (!canSend.value || sessionBusy.value || id === chat.sessionId) return;
  sessionBusy.value = true;
  try {
    await chat.switchSession(id);
  } catch (e) {
    chat.setError(e instanceof Error ? e.message : String(e));
  } finally {
    sessionBusy.value = false;
  }
}

async function onDeleteSession(id: string) {
  if (!canSend.value || sessionBusy.value) return;
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
  window.addEventListener('keydown', onProjectSheetKeydown);
  window.visualViewport?.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('scroll', onViewportResize);
  focusChatInput();
  void scrollToBottom();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onProjectSheetKeydown);
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
</script>

<template>
  <header class="app-header">
    <h1>Agent 对话</h1>
    <div class="sub" v-if="project && aiStatusLine">
      {{ project.name }} · {{ aiStatusLine }}
    </div>
    <div class="sub" v-else-if="project">{{ project.name }} · 工具在本地沙盒执行</div>
    <div class="sub text-danger" v-else>请先创建并选择项目</div>
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

    <div
      v-if="agentSettings.hasChatStorageRoot && project"
      class="card session-card"
    >
      <div class="session-card-head">
        <span class="card-title" style="margin:0">会话</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          @click="sessionListCollapsed = !sessionListCollapsed"
        >
          {{ sessionListCollapsed ? '展开' : '收起' }}
        </button>
      </div>
      <p class="session-root-hint">
        存储于：{{ agentSettings.chatStorageRoot?.label || '—' }}
        <template v-if="chat.activeSession">
          · 当前：{{ chat.activeSession.title || '未命名' }}
        </template>
      </p>
      <template v-if="!sessionListCollapsed">
        <div v-if="!chat.sessions.length" class="hint-text" style="margin:8px 0 0">暂无会话</div>
        <ul v-else class="session-list">
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
              :disabled="busy || chat.streaming || sessionBusy"
              @click="onDeleteSession(s.id)"
            >
              删除
            </button>
          </li>
        </ul>
      </template>
    </div>

    <p v-if="chat.nearMessageCap" class="hint-text" style="margin:8px 0">
      提示：会话消息接近上限（{{ chat.messageCap }} 条），更早的消息保存时可能被截断。
    </p>

    <ChatMessage
      v-for="m in chat.messages"
      :key="m.id"
      :message="m"
      :streaming="chat.streaming && m.role === 'assistant' && !m.content"
      :deletable="!busy && !chat.streaming && agentSettings.hasChatStorageRoot"
      @delete="onDeleteMessage"
    />

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
            :disabled="!canSend || sessionBusy"
            @click="onNewSession"
          >
            {{ sessionBusy ? '创建中…' : '开启新会话' }}
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
</template>

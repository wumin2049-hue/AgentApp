<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useAgentSettingsStore } from '@/stores/agentSettings';
import {
  testAgentConnection,
  fetchModelsFromUpstream,
  normalizeApiBaseUrl,
} from '@/api/agentServer';
import { APP_VERSION } from '@/version';
import { isLocalTreeUri } from '@/plugins/project-storage';

const agentSettings = useAgentSettingsStore();
const version = APP_VERSION;

const form = reactive({
  apiBaseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: 8192,
  temperature: 0.7,
  systemPrompt: '',
});

const keyTouched = ref(false);
const testMsg = ref('');
const testSteps = ref<string[]>([]);
const testBusy = ref(false);
const fetchBusy = ref(false);
const saveMsg = ref('');
const rootMsg = ref('');
const rootBusy = ref(false);

const keyPlaceholder = computed(() =>
  agentSettings.apiKeyMask ? `已保存 ${agentSettings.apiKeyMask}` : 'sk-…',
);

const dataRootHint = computed(() => {
  const root = agentSettings.chatStorageRoot;
  if (!agentSettings.hasChatStorageRoot || !root?.uri) return '未授权（请选择手机文件夹）';
  if (isLocalTreeUri(root.uri)) return '预览目录（仅 Web）';
  const access = agentSettings.storageAccessOk ? '已授权读/写/列表' : '授权失效，请重新选择';
  return `${root.label} · ${access}`;
});

function syncFormFromStore() {
  const c = agentSettings.config;
  form.apiBaseUrl = c.apiBaseUrl || '';
  form.apiKey = '';
  keyTouched.value = false;
  form.model = c.model || '';
  form.maxTokens = c.maxTokens ?? 8192;
  form.temperature = c.temperature ?? 0.7;
  form.systemPrompt = c.systemPrompt || '';
}

onMounted(async () => {
  if (!agentSettings.loaded) await agentSettings.load();
  syncFormFromStore();
});

async function save() {
  saveMsg.value = '';
  const patch: Partial<typeof agentSettings.config> = {
    apiBaseUrl: normalizeApiBaseUrl(form.apiBaseUrl),
    model: form.model.trim(),
    maxTokens: Number(form.maxTokens) || 8192,
    temperature: Number(form.temperature) || 0.7,
    systemPrompt: form.systemPrompt.trim(),
  };
  if (keyTouched.value) {
    patch.apiKey = form.apiKey.trim();
  }
  await agentSettings.update(patch);
  saveMsg.value = '已保存';
}

async function runTest() {
  testBusy.value = true;
  testMsg.value = '';
  testSteps.value = [];
  try {
    await save();
    const result = await testAgentConnection(agentSettings.agentConfig);
    testSteps.value = result.steps;
    testMsg.value = result.message;
  } catch (e) {
    testMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    testBusy.value = false;
  }
}

async function pullModels() {
  fetchBusy.value = true;
  saveMsg.value = '';
  try {
    await save();
    const result = await fetchModelsFromUpstream(agentSettings.agentConfig);
    await agentSettings.setModels(result.models);
    if (result.defaultModel && !form.model) {
      form.model = result.defaultModel;
      await agentSettings.update({ model: result.defaultModel });
    }
    saveMsg.value = result.message;
  } catch (e) {
    saveMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    fetchBusy.value = false;
  }
}

async function pickModel(key: string) {
  form.model = key;
  await save();
}

async function pickStorageRoot() {
  rootBusy.value = true;
  rootMsg.value = '';
  try {
    const root = await agentSettings.pickChatStorageRoot();
    rootMsg.value = `已授权：${root.label}（可读取、写入、列出该目录及其子目录）`;
  } catch (e) {
    rootMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    rootBusy.value = false;
  }
}
</script>

<template>
  <header class="app-header app-header-glow">
    <h1>AI 设置</h1>
    <div class="sub">Harness 接口配置 · 全局生效 · 所有项目共用</div>
  </header>
  <main class="app-main">
    <div class="card" :class="agentSettings.hasChatStorageRoot && agentSettings.storageAccessOk ? 'card-premium' : 'card-warn'">
      <span class="card-title">手机数据目录（必选）</span>
      <p class="card-desc">
        必须授权一个手机本地文件夹。系统会弹出目录选择器，请点「使用此文件夹 / 允许」以授予读、写、列表权限；对话改代码、同步项目都依赖此授权。
      </p>
      <p class="hint-text" style="margin:0 0 12px">
        当前：<strong>{{ dataRootHint }}</strong>
      </p>
      <p class="hint-text" style="margin:0 0 12px">
        结构：<code>app/settings.json</code>、<code>app/projects.json</code>、
        <code>{项目ID}/…</code>
      </p>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-primary" type="button" :disabled="rootBusy" @click="pickStorageRoot">
          {{ rootBusy ? '等待授权…' : (agentSettings.hasChatStorageRoot ? '重新选择并授权' : '选择手机文件夹并授权') }}
        </button>
      </div>
      <p
        v-if="rootMsg"
        class="hint-text"
        :class="rootMsg.startsWith('已') ? 'ok' : 'err'"
        style="margin-top:10px"
      >
        {{ rootMsg }}
      </p>
    </div>

    <div class="card card-premium">
      <span class="card-title">接口配置</span>
      <p class="card-desc">对齐 agent Harness：填写上游 API 地址与 Key，本地执行工具循环。</p>
      <div class="field">
        <label>API 地址</label>
        <input
          v-model="form.apiBaseUrl"
          type="url"
          placeholder="https://ai.1k0.com/v1"
          autocomplete="off"
        />
      </div>
      <div class="field">
        <label>API Key</label>
        <input
          v-model="form.apiKey"
          type="password"
          :placeholder="keyPlaceholder"
          autocomplete="off"
          @input="keyTouched = true"
        />
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary" :disabled="testBusy" @click="runTest">
          {{ testBusy ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-ghost" @click="save">保存</button>
      </div>
      <p v-if="saveMsg" class="hint-text" :class="saveMsg.startsWith('已') || saveMsg.includes('拉取') ? 'ok' : 'err'" style="margin-top:10px">
        {{ saveMsg }}
      </p>
      <p
        v-if="testMsg"
        class="hint-text"
        :class="testSteps.length ? 'ok' : 'err'"
        style="margin-top:10px;white-space:pre-wrap"
      >
        {{ testMsg }}
      </p>
      <ul v-if="testSteps.length" class="test-steps">
        <li v-for="(s, i) in testSteps" :key="i">{{ s }}</li>
      </ul>
    </div>

    <div class="card card-premium">
      <span class="card-title">模型</span>
      <div class="field">
        <label>默认模型</label>
        <input v-model="form.model" placeholder="拉取后点选，或手动填写 model id" />
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" :disabled="fetchBusy" @click="pullModels">
          {{ fetchBusy ? '拉取中…' : '拉取模型列表' }}
        </button>
      </div>
      <div v-if="agentSettings.models.length" class="model-chips">
        <button
          v-for="m in agentSettings.models"
          :key="m.model_key"
          type="button"
          class="chip"
          :class="{ active: form.model === m.model_key }"
          @click="pickModel(m.model_key)"
        >
          {{ m.model_key }}
        </button>
      </div>
      <p v-else class="hint-text" style="margin:10px 0 0">保存 API 配置后点「拉取模型列表」</p>
    </div>

    <div class="card">
      <span class="card-title">高级</span>
      <div class="field">
        <label>Max Tokens</label>
        <input v-model.number="form.maxTokens" type="number" @change="save" />
      </div>
      <div class="field">
        <label>Temperature</label>
        <input v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" @change="save" />
      </div>
      <div class="field">
        <label>系统补充说明（可选）</label>
        <textarea
          v-model="form.systemPrompt"
          rows="3"
          placeholder="追加到每次对话的 system prompt"
          @change="save"
        />
      </div>
      <button class="btn btn-ghost btn-block" type="button" style="margin-top:8px" @click="save">
        保存高级设置
      </button>
    </div>

    <div class="card">
      <span class="card-title">关于</span>
      <p class="hint-text" style="margin:0">mincode v{{ version }} · 工具本地执行 · 模型经原生 HTTP 直连上游</p>
      <p class="hint-text" style="margin:8px 0 0">
        配置同时写入 Preferences 与数据目录；外部目录会申请持久权限，避免重开后失效。
      </p>
      <p class="hint-text" style="margin:8px 0 0">
        安全：API Key / FTP 密码以明文保存在本机 Preferences（未进系统 Keychain）。安装包已关闭
        <code>allowBackup</code>，请勿用未加密云备份导出应用数据。对话按接口响应推进；斜杠生图/视频任务为固定间隔轮询。
      </p>
      <p class="hint-text" style="margin:8px 0 0">
        对齐说明见仓库 <code>docs/cursor-harness-对齐待办.md</code>。
      </p>
    </div>
  </main>
</template>

<style scoped>
.card-desc {
  margin: -4px 0 14px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.test-steps {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--muted);
}
.model-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
</style>

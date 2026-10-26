<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useProjectsStore } from '@/stores/projects';
import {
  syncProjectFiles,
  countSandboxFiles,
  getModifiedFiles,
  exportModifiedToPhone,
  deleteProjectSandbox,
} from '@/services/localFs';
import { ftpList } from '@/plugins/ftp';

const route = useRoute();
const router = useRouter();
const store = useProjectsStore();

const project = computed(() => store.projects.find((p) => p.id === route.params.id));
const formReady = ref(false);
const missing = ref(false);

const syncMsg = ref('');
const syncBusy = ref(false);
const fileCount = ref<number | null>(null);
const exportMsg = ref('');
const exportBusy = ref(false);
const modifiedCount = ref(0);
const ftpTestMsg = ref('');
const ftpTestBusy = ref(false);
const saveBusy = ref(false);

const form = reactive({
  name: '',
  ftpHost: '',
  ftpPort: 21,
  ftpUser: '',
  ftpPass: '',
  ftpRoot: '/',
  pathPrefix: '',
  ftpPassive: true,
  ftpSecure: false,
});

function hydrateForm() {
  if (!project.value) {
    formReady.value = false;
    return;
  }
  form.name = project.value.name;
  form.ftpHost = project.value.ftp.host;
  form.ftpPort = project.value.ftp.port;
  form.ftpUser = project.value.ftp.username;
  form.ftpPass = project.value.ftp.password;
  form.ftpRoot = project.value.ftp.remoteRoot;
  form.pathPrefix = project.value.pathPrefix || '';
  form.ftpPassive = project.value.ftp.passive !== false;
  form.ftpSecure = Boolean(project.value.ftp.secure);
  formReady.value = true;
  missing.value = false;
}

async function refreshStats() {
  if (!project.value) return;
  try {
    fileCount.value = await countSandboxFiles(project.value.id);
    modifiedCount.value = (await getModifiedFiles(project.value.id)).length;
  } catch {
    fileCount.value = null;
  }
}

watch(
  () => [store.loaded, route.params.id, project.value?.id] as const,
  () => {
    if (!store.loaded) return;
    if (!project.value) {
      missing.value = true;
      formReady.value = false;
      return;
    }
    hydrateForm();
    void refreshStats();
  },
  { immediate: true },
);

onMounted(async () => {
  if (!store.loaded) await store.load();
});

async function exportAllModified() {
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
    exportMsg.value = `已写回 ${result.exported}/${files.length} 个文件${errHint}`;
    modifiedCount.value = (await getModifiedFiles(project.value.id)).length;
  } catch (e) {
    exportMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    exportBusy.value = false;
  }
}

async function syncToSandbox() {
  if (!project.value) return;
  syncBusy.value = true;
  syncMsg.value = '';
  try {
    const result = await syncProjectFiles(project.value);
    fileCount.value = await countSandboxFiles(project.value.id);
    const errs = result.errors?.length ? `（${result.errors.length} 个跳过/错误）` : '';
    syncMsg.value = `已同步 ${result.copied} 个文件，${result.skipped} 个跳过${errs}`;
  } catch (e) {
    syncMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    syncBusy.value = false;
  }
}

async function testFtp() {
  ftpTestBusy.value = true;
  ftpTestMsg.value = '';
  try {
    if (!form.ftpHost.trim()) {
      ftpTestMsg.value = '请先填写 FTP 主机';
      return;
    }
    const temp = {
      host: form.ftpHost.trim(),
      port: Number(form.ftpPort) || 21,
      username: form.ftpUser,
      password: form.ftpPass,
      remoteRoot: form.ftpRoot || '/',
      passive: form.ftpPassive,
      secure: form.ftpSecure,
    };
    const entries = await ftpList(temp, form.ftpRoot || '/');
    ftpTestMsg.value = `连接成功，目录内 ${entries.length} 项`;
  } catch (e) {
    ftpTestMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    ftpTestBusy.value = false;
  }
}

async function save() {
  if (!project.value || !formReady.value) return;
  saveBusy.value = true;
  try {
    await store.updateProject(project.value.id, {
      name: form.name,
      pathPrefix: form.pathPrefix,
      ftp: {
        ...project.value.ftp,
        host: form.ftpHost,
        port: Number(form.ftpPort),
        username: form.ftpUser,
        password: form.ftpPass,
        remoteRoot: form.ftpRoot,
        passive: form.ftpPassive,
        secure: form.ftpSecure,
      },
    });
    await store.setActive(project.value.id);
    router.push('/projects');
  } finally {
    saveBusy.value = false;
  }
}

async function remove() {
  if (!project.value) return;
  if (
    !confirm(
      '确定删除该项目配置？可选同时清理 App 沙盒缓存；不会删除手机上的原文件夹。',
    )
  ) {
    return;
  }
  const cleanSandbox = confirm('是否同时删除 App 内该项目的沙盒缓存文件？');
  const id = project.value.id;
  if (cleanSandbox) await deleteProjectSandbox(id);
  await store.removeProject(id);
  router.push('/projects');
}
</script>

<template>
  <header class="app-header">
    <h1>编辑项目</h1>
    <div class="sub" v-if="project">
      <span aria-hidden="true">📁</span> {{ project.localRootLabel }}
    </div>
    <div class="sub">
      <button type="button" class="btn-link" @click="router.push('/projects')">← 返回项目列表</button>
    </div>
  </header>

  <main class="app-main" v-if="!store.loaded">
    <p class="hint-text">加载项目中…</p>
  </main>

  <main class="app-main" v-else-if="missing || !project">
    <div class="card card-warn">
      <p class="hint-text" style="margin:0">项目不存在或已被删除。</p>
      <button class="btn btn-primary btn-block" style="margin-top:12px" type="button" @click="router.push('/projects')">
        回项目列表
      </button>
    </div>
  </main>

  <main class="app-main" v-else-if="formReady">
    <div class="card">
      <span class="card-title">项目信息</span>
      <div class="field"><label>名称</label><input v-model="form.name" /></div>
      <p class="hint-text" style="margin:0">
        AI 模型与 Agent 地址在
        <router-link to="/settings">全局设置</router-link>
        中配置，所有项目共用。
      </p>
    </div>

    <div class="card">
      <span class="card-title">本地目录</span>
      <p class="card-meta">
        <span aria-hidden="true">📁</span> {{ project.localRootLabel }}
        <span v-if="fileCount !== null"> · 沙盒内 {{ fileCount }} 个文件</span>
      </p>
      <button class="btn btn-ghost btn-block" :disabled="syncBusy" @click="syncToSandbox">
        {{ syncBusy ? '同步中…' : '↻ 同步到 App 沙盒' }}
      </button>
      <button class="btn btn-ghost btn-block" :disabled="exportBusy" @click="exportAllModified">
        {{ exportBusy ? '写回中…' : `写回修改到手机（${modifiedCount}）` }}
      </button>
      <p v-if="syncMsg" class="hint-text" style="margin-top:8px">{{ syncMsg }}</p>
      <p v-if="exportMsg" class="hint-text" style="margin-top:8px">{{ exportMsg }}</p>
    </div>

    <div class="card">
      <span class="card-title">FTP</span>
      <div class="field"><label>主机</label><input v-model="form.ftpHost" /></div>
      <div class="field"><label>端口</label><input v-model.number="form.ftpPort" type="number" /></div>
      <div class="field"><label>用户名</label><input v-model="form.ftpUser" /></div>
      <div class="field"><label>密码</label><input v-model="form.ftpPass" type="password" /></div>
      <div class="field"><label>远程根目录</label><input v-model="form.ftpRoot" placeholder="/public_html" /></div>
      <div class="field"><label>路径前缀</label><input v-model="form.pathPrefix" placeholder="本地路径映射到 FTP 的子目录" /></div>
      <label class="check-row">
        <input v-model="form.ftpPassive" type="checkbox" />
        被动模式（passive）
      </label>
      <label class="check-row">
        <input v-model="form.ftpSecure" type="checkbox" />
        FTPS（secure）
      </label>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-ghost" type="button" :disabled="ftpTestBusy" @click="testFtp">
          {{ ftpTestBusy ? '测试中…' : '测试连接' }}
        </button>
      </div>
      <p
        v-if="ftpTestMsg"
        class="hint-text"
        :class="ftpTestMsg.startsWith('连接成功') ? 'ok' : 'err'"
        style="margin-top:8px"
      >
        {{ ftpTestMsg }}
      </p>
    </div>

    <button class="btn btn-primary btn-block" :disabled="saveBusy || !formReady" @click="save">
      {{ saveBusy ? '保存中…' : '保存并设为当前' }}
    </button>
    <button class="btn btn-danger btn-block" @click="remove">删除项目</button>
  </main>
</template>

<style scoped>
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}
.btn-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent2);
  font-size: 13px;
  cursor: pointer;
}
</style>

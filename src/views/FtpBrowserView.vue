<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useProjectsStore } from '@/stores/projects';
import {
  ftpList,
  ftpUploadFile,
  ftpDownloadFile,
  ftpDeleteRemote,
  ftpMkdirRemote,
} from '@/plugins/ftp';
import {
  listLocalEntries,
  listLocalFilesRecursive,
  readProjectFile,
  deleteProjectFile,
  deleteProjectDir,
  createLocalDir,
  syncProjectFiles,
  exportModifiedToPhone,
  trackModified,
  type LocalEntry,
} from '@/services/localFs';
import { loadFtpState, saveFtpState } from '@/services/ftpState';
import { parentPath, remotePathForLocalRel, sandboxRelFromRemote } from '@/services/pathMap';
import type { FtpEntry, WorkProject } from '@/types';

const projects = useProjectsStore();

const selectedId = ref('');
const tab = ref<'local' | 'remote'>('local');
const localPath = ref('');
const remotePath = ref('/');
const localEntries = ref<LocalEntry[]>([]);
const remoteEntries = ref<FtpEntry[]>([]);
const loading = ref(false);
const busy = ref(false);
const err = ref('');
const okMsg = ref('');
const previewOpen = ref(false);
const previewTitle = ref('');
const previewContent = ref('');
const pickedLocal = ref<LocalEntry | null>(null);
const pickedRemote = ref<FtpEntry | null>(null);

const project = computed(() =>
  projects.projects.find((p) => p.id === selectedId.value) || projects.active,
);

const localLabel = computed(() => project.value?.localRootLabel || '未绑定目录');
const remoteLabel = computed(() => project.value?.ftp.host || '未配置 FTP');

const currentPathLabel = computed(() =>
  tab.value === 'local' ? (localPath.value || '/') : remotePath.value,
);

async function persistState() {
  if (!selectedId.value) return;
  await saveFtpState(selectedId.value, {
    tab: tab.value,
    localPath: localPath.value,
    remotePath: remotePath.value,
  });
}

function resetPathsForProject(p: WorkProject | null, saved?: { tab: 'local' | 'remote'; localPath: string; remotePath: string } | null) {
  if (saved) {
    tab.value = saved.tab;
    localPath.value = saved.localPath;
    remotePath.value = saved.remotePath || p?.ftp.remoteRoot || '/';
  } else {
    tab.value = 'local';
    localPath.value = '';
    remotePath.value = p?.ftp.remoteRoot || '/';
  }
  pickedLocal.value = null;
  pickedRemote.value = null;
  err.value = '';
  okMsg.value = '';
}

async function onProjectChange(id: string) {
  selectedId.value = id;
  await projects.setActive(id);
  const p = projects.projects.find((x) => x.id === id);
  const saved = await loadFtpState(id);
  resetPathsForProject(p || null, saved);
  await refresh();
}

async function refresh() {
  if (!project.value) return;
  loading.value = true;
  err.value = '';
  try {
    if (tab.value === 'local') {
      localEntries.value = await listLocalEntries(project.value, localPath.value);
    } else {
      if (!project.value.ftp.host) {
        err.value = '请先在项目里配置 FTP';
        remoteEntries.value = [];
        return;
      }
      remoteEntries.value = await ftpList(project.value.ftp, remotePath.value);
    }
    await persistState();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function switchTab(next: 'local' | 'remote') {
  tab.value = next;
  pickedLocal.value = null;
  pickedRemote.value = null;
  refresh();
}

function pickLocal(entry: LocalEntry) {
  pickedLocal.value = entry;
  pickedRemote.value = null;
}

function pickRemote(entry: FtpEntry) {
  pickedRemote.value = entry;
  pickedLocal.value = null;
}

function enterLocal(entry: LocalEntry) {
  if (!entry.isDirectory) {
    pickLocal(entry);
    return;
  }
  localPath.value = entry.relPath;
  pickedLocal.value = null;
  refresh();
}

function enterRemote(entry: FtpEntry) {
  if (!entry.isDirectory) {
    pickRemote(entry);
    return;
  }
  remotePath.value = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
  pickedRemote.value = null;
  refresh();
}

function goUp() {
  if (tab.value === 'local') {
    localPath.value = parentPath(localPath.value);
  } else {
    const p = remotePath.value.replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    const root = project.value?.ftp.remoteRoot.replace(/\/+$/, '') || '';
    remotePath.value = i <= 0 ? (root || '/') : p.slice(0, i + 1);
  }
  pickedLocal.value = null;
  pickedRemote.value = null;
  refresh();
}

async function syncFromPhone() {
  if (!project.value) return;
  busy.value = true;
  err.value = '';
  okMsg.value = '';
  try {
    const r = await syncProjectFiles(project.value);
    okMsg.value = `已从手机同步 ${r.copied} 个文件`;
    await refresh();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function mkdirHere() {
  if (!project.value) return;
  const name = prompt('新建文件夹名称');
  if (!name?.trim()) return;
  busy.value = true;
  err.value = '';
  try {
    if (tab.value === 'local') {
      const rel = localPath.value ? `${localPath.value}/${name.trim()}` : name.trim();
      await createLocalDir(project.value, rel);
      okMsg.value = `已创建 ${rel}`;
    } else {
      if (!project.value.ftp.host) throw new Error('请先配置 FTP');
      const base = remotePath.value.replace(/\/+$/, '');
      const remote = `${base}/${name.trim()}`;
      await ftpMkdirRemote(project.value.ftp, remote);
      okMsg.value = `已创建远程目录 ${remote}`;
    }
    await refresh();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function batchUploadDir() {
  if (!project.value?.ftp.host) {
    err.value = '请先配置 FTP';
    return;
  }
  busy.value = true;
  err.value = '';
  okMsg.value = '';
  try {
    const files = await listLocalFilesRecursive(project.value, localPath.value);
    let ok = 0;
    const failed: string[] = [];
    for (const rel of files) {
      try {
        const remote = remotePathForLocalRel(project.value, rel);
        const localSandbox = `agent-app/projects/${project.value.id}/${rel}`;
        await ftpUploadFile(project.value.ftp, localSandbox, remote);
        ok++;
      } catch (e) {
        failed.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    okMsg.value = `已上传 ${ok}/${files.length} 个文件（含子目录，递归）`;
    if (failed.length) {
      err.value = `失败 ${failed.length} 个：${failed.slice(0, 3).join('；')}${failed.length > 3 ? '…' : ''}`;
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function batchPullDir() {
  if (!project.value?.ftp.host) {
    err.value = '请先配置 FTP';
    return;
  }
  const files = remoteEntries.value.filter((e) => !e.isDirectory);
  if (!files.length) {
    okMsg.value = '当前远程目录没有可拉取的文件（不含子目录）';
    return;
  }
  busy.value = true;
  err.value = '';
  okMsg.value = '';
  try {
    let ok = 0;
    const failed: string[] = [];
    for (const entry of files) {
      try {
        const rel = sandboxRelFromRemote(entry.path, project.value.ftp, project.value.pathPrefix || '');
        if (!rel) {
          failed.push(`${entry.name}: 无法映射本地路径`);
          continue;
        }
        const localSandbox = `agent-app/projects/${project.value.id}/${rel}`;
        await ftpDownloadFile(project.value.ftp, entry.path, localSandbox);
        await trackModified(project.value.id, rel);
        ok++;
      } catch (e) {
        failed.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    okMsg.value = `已拉取 ${ok}/${files.length} 个文件到本地（仅当前目录）`;
    if (failed.length) {
      err.value = `失败 ${failed.length} 个：${failed.slice(0, 3).join('；')}${failed.length > 3 ? '…' : ''}`;
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function viewLocal(entry: LocalEntry) {
  if (!project.value || entry.isDirectory) return;
  busy.value = true;
  try {
    const text = await readProjectFile(project.value, entry.relPath);
    previewTitle.value = entry.relPath;
    previewContent.value = text.length > 80000 ? text.slice(0, 80000) + '\n\n…（已截断）' : text;
    previewOpen.value = true;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function exportLocalToPhone(entry: LocalEntry) {
  if (!project.value || entry.isDirectory) return;
  busy.value = true;
  err.value = '';
  try {
    const r = await exportModifiedToPhone(project.value, [entry.relPath]);
    okMsg.value = `已写回手机 ${r.exported} 个文件`;
    pickedLocal.value = null;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function deleteLocal(entry: LocalEntry) {
  if (!project.value) return;
  const tip = entry.isDirectory
    ? `删除本地目录 ${entry.relPath} 及其全部内容？`
    : `删除本地文件 ${entry.relPath}？`;
  if (!confirm(tip)) return;
  busy.value = true;
  err.value = '';
  try {
    if (entry.isDirectory) await deleteProjectDir(project.value, entry.relPath);
    else await deleteProjectFile(project.value, entry.relPath);
    okMsg.value = `已删除 ${entry.name}`;
    pickedLocal.value = null;
    await refresh();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function uploadLocalToFtp(entry: LocalEntry) {
  if (!project.value || entry.isDirectory) return;
  if (!project.value.ftp.host) {
    err.value = '请先配置 FTP';
    return;
  }
  busy.value = true;
  err.value = '';
  try {
    const remote = remotePathForLocalRel(project.value, entry.relPath);
    const localSandbox = `agent-app/projects/${project.value.id}/${entry.relPath}`;
    await ftpUploadFile(project.value.ftp, localSandbox, remote);
    okMsg.value = `已上传至 ${remote}`;
    pickedLocal.value = null;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function pullRemoteToLocal(entry: FtpEntry) {
  if (!project.value || entry.isDirectory) return;
  busy.value = true;
  err.value = '';
  try {
    const rel = sandboxRelFromRemote(entry.path, project.value.ftp, project.value.pathPrefix || '');
    if (!rel) {
      err.value = '无法映射到本地路径';
      return;
    }
    const localSandbox = `agent-app/projects/${project.value.id}/${rel}`;
    await ftpDownloadFile(project.value.ftp, entry.path, localSandbox);
    await trackModified(project.value.id, rel);
    okMsg.value = `已拉取到本地 ${rel}`;
    pickedRemote.value = null;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function deleteRemote(entry: FtpEntry) {
  if (!project.value) return;
  if (entry.isDirectory) {
    err.value = '暂不支持直接删除远程目录，请先清空其中文件';
    return;
  }
  if (!confirm(`删除远程文件 ${entry.name}？`)) return;
  busy.value = true;
  err.value = '';
  try {
    await ftpDeleteRemote(project.value.ftp, entry.path);
    okMsg.value = `已删除远程 ${entry.name}`;
    pickedRemote.value = null;
    await refresh();
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

watch(tab, () => {
  pickedLocal.value = null;
  pickedRemote.value = null;
});

onMounted(async () => {
  if (!projects.loaded) await projects.load();
  selectedId.value = projects.activeId || projects.projects[0]?.id || '';
  const saved = selectedId.value ? await loadFtpState(selectedId.value) : null;
  resetPathsForProject(project.value, saved);
  await refresh();
});
</script>

<template>
  <header class="app-header">
    <h1>FTP 文件</h1>
    <div class="sub">本地沙盒 ↔ 远程 FTP</div>
  </header>

  <main class="app-main ftp-page">
    <div class="card" style="padding:14px">
      <label class="field-label">当前项目</label>
      <select
        class="project-select"
        :value="selectedId"
        :disabled="!projects.projects.length"
        @change="onProjectChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in projects.projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <p class="ftp-context-hint">
        <span v-if="tab === 'local'">📁 {{ localLabel }}</span>
        <span v-else>🌐 {{ remoteLabel }}</span>
      </p>
    </div>

    <div v-if="!projects.projects.length" class="card">
      <p class="hint-text">还没有项目，请先在「项目」页创建。</p>
    </div>

    <template v-else>
      <div class="segment-tabs">
        <button
          type="button"
          class="segment-tab"
          :class="{ active: tab === 'local' }"
          @click="switchTab('local')"
        >
          线下
        </button>
        <button
          type="button"
          class="segment-tab"
          :class="{ active: tab === 'remote' }"
          @click="switchTab('remote')"
        >
          线上
        </button>
      </div>

      <div class="card ftp-toolbar">
        <code class="ftp-path">{{ currentPathLabel }}</code>
        <button class="btn btn-ghost btn-sm" type="button" @click="goUp">上级</button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || busy" @click="refresh">
          {{ loading ? '…' : '刷新' }}
        </button>
      </div>

      <div class="batch-bar">
        <template v-if="tab === 'local'">
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="syncFromPhone">同步手机</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="batchUploadDir">全部上传（递归）</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="mkdirHere">新建夹</button>
        </template>
        <template v-else>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="batchPullDir">全部拉取（当前目录）</button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="mkdirHere">新建夹</button>
        </template>
      </div>

      <p v-if="err" class="hint-text err">{{ err }}</p>
      <p v-if="okMsg" class="hint-text ok">{{ okMsg }}</p>

      <template v-if="tab === 'local'">
        <div
          v-for="e in localEntries"
          :key="e.relPath"
          class="ftp-entry"
          :class="{ selected: pickedLocal?.relPath === e.relPath }"
          @click="enterLocal(e)"
          @contextmenu.prevent="pickLocal(e)"
        >
          <span class="icon">{{ e.isDirectory ? '📁' : '📄' }}</span>
          <span class="entry-name">{{ e.name }}</span>
          <span v-if="!e.isDirectory && e.size" class="size">{{ e.size }} B</span>
        </div>
        <p v-if="!localEntries.length && !loading" class="hint-text">沙盒为空，请先同步手机目录</p>
      </template>

      <template v-else>
        <div
          v-for="e in remoteEntries"
          :key="e.path"
          class="ftp-entry"
          :class="{ selected: pickedRemote?.path === e.path }"
          @click="enterRemote(e)"
          @contextmenu.prevent="pickRemote(e)"
        >
          <span class="icon">{{ e.isDirectory ? '📁' : '📄' }}</span>
          <span class="entry-name">{{ e.name }}</span>
          <span v-if="!e.isDirectory && e.size" class="size">{{ e.size }} B</span>
        </div>
        <p v-if="!remoteEntries.length && !loading" class="hint-text">
          无文件或需真机 FTP 插件。请先在项目中配置 FTP。
        </p>
      </template>

      <div v-if="pickedLocal" class="action-sheet">
        <span class="action-sheet-title">{{ pickedLocal.name }}</span>
        <div class="action-sheet-btns">
          <button
            v-if="!pickedLocal.isDirectory"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="busy"
            @click="viewLocal(pickedLocal)"
          >
            查看
          </button>
          <button
            v-if="!pickedLocal.isDirectory"
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="busy"
            @click="uploadLocalToFtp(pickedLocal)"
          >
            上传
          </button>
          <button
            v-if="!pickedLocal.isDirectory"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="busy"
            @click="exportLocalToPhone(pickedLocal)"
          >
            写回手机
          </button>
          <button class="btn btn-danger btn-sm" type="button" :disabled="busy" @click="deleteLocal(pickedLocal)">
            删除
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="pickedLocal = null">取消</button>
        </div>
      </div>

      <div v-if="pickedRemote" class="action-sheet">
        <span class="action-sheet-title">{{ pickedRemote.name }}</span>
        <div class="action-sheet-btns">
          <button
            v-if="!pickedRemote.isDirectory"
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="busy"
            @click="pullRemoteToLocal(pickedRemote)"
          >
            拉取
          </button>
          <button class="btn btn-danger btn-sm" type="button" :disabled="busy" @click="deleteRemote(pickedRemote)">
            删除
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="pickedRemote = null">取消</button>
        </div>
      </div>
    </template>

    <div v-if="previewOpen" class="preview-overlay" @click.self="previewOpen = false">
      <div class="preview-panel">
        <div class="preview-header">
          <strong>{{ previewTitle }}</strong>
          <button class="btn btn-ghost btn-sm" type="button" @click="previewOpen = false">关闭</button>
        </div>
        <pre class="preview-body">{{ previewContent }}</pre>
      </div>
    </div>
  </main>
</template>

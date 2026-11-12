<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  HarnessAnalysisEntry,
  HarnessPhase,
  HarnessTurnPanels,
  TodoItem,
} from '@/types';
import { groupTodos, todoProgressLabel } from '@/services/turnPanels';

/**
 * Harness 式对话面板：
 *  ① 分析 / 读取 / 编辑记录
 *  ② 思考结果
 *  ③ 任务列表（进行中 / 待完成 / 已完成）
 *  ④ 本次修改的文件
 * 四个板块各自根据 AI 接口结果不断追加记录与状态。
 */
const props = defineProps<{
  panels: HarnessTurnPanels;
  /** 正在流式执行中 */
  running?: boolean;
  /** 本次对话耗时（秒） */
  elapsedSec?: number;
  /** 可查看 diff 的回调（有 diff 时才显示按钮） */
  hasDiff?: (path: string) => boolean;
}>();

const emit = defineEmits<{
  openFiles: [];
  openDiff: [path: string];
  openDetail: [];
  viewTurn: [turnId: string];
}>();

const collapsed = ref<Record<string, boolean>>({});
const expandedThinking = ref<Record<string, boolean>>({});

function toggle(key: string) {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
}

function isCollapsed(key: string): boolean {
  return Boolean(collapsed.value[key]);
}

const PHASE_META: Record<HarnessPhase, { label: string; icon: string }> = {
  analysis: { label: '分析', icon: '◆' },
  read: { label: '读取', icon: '⊙' },
  edit: { label: '编辑', icon: '✎' },
  verify: { label: '校验', icon: '✓' },
};

const groups = computed(() => {
  const out: Record<HarnessPhase, HarnessAnalysisEntry[]> = {
    analysis: [],
    read: [],
    edit: [],
    verify: [],
  };
  for (const row of props.panels.analysis) out[row.phase].push(row);
  return out;
});

const todoGroups = computed(() => groupTodos(props.panels.todos));
const todoSummary = computed(() => todoProgressLabel(props.panels.todos));

const thinkingText = computed(() =>
  props.panels.thinking.map((t) => t.replace(/^#r\d+\s*/, '')).join('\n\n———\n\n'),
);

const fileSummary = computed(() => {
  const files = props.panels.files;
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added || 0;
    removed += f.removed || 0;
  }
  return { count: files.length, added, removed };
});

const elapsedLabel = computed(() => {
  const sec = props.elapsedSec ?? 0;
  if (!sec) return '';
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
});

const statusTitle = computed(() => {
  if (props.running) {
    const active = todoGroups.value.inProgress[0];
    return active ? `正在执行：${active.content}` : '正在分析任务…';
  }
  if (props.panels.error) return `本轮中断：${props.panels.error}`;
  if (!props.panels.todos.length) {
    return props.panels.files.length
      ? `本次修改 ${props.panels.files.length} 个文件`
      : '本轮已完成';
  }
  return props.panels.allDone
    ? `任务全部完成（${props.panels.todos.length} 项）`
    : `仍有未完成任务 · ${todoSummary.value}`;
});

function todoStatusText(status: TodoItem['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '进行中';
  if (status === 'cancelled') return '已取消';
  return '待完成';
}

function toggleThinking(round: string) {
  expandedThinking.value = {
    ...expandedThinking.value,
    [round]: !expandedThinking.value[round],
  };
}

function thinkingRows(): Array<{ key: string; round: string; text: string }> {
  return props.panels.thinking.map((t, i) => {
    const m = /^#r(\d+)\s*/.exec(t);
    return {
      key: `${i}`,
      round: m ? m[1] : `${i + 1}`,
      text: m ? t.slice(m[0].length) : t,
    };
  });
}

function shortPath(p: string): string {
  if (p.length <= 42) return p;
  const parts = p.split('/');
  return `…/${parts.slice(-2).join('/')}`;
}
</script>

<template>
  <section class="hp-root" :class="{ 'is-running': running }" aria-label="执行面板">
    <!-- 头部：状态 + 统计 -->
    <header class="hp-head">
      <div class="hp-head-main">
        <span class="hp-dot" :class="running ? 'is-live' : panels.allDone ? 'is-done' : 'is-warn'" aria-hidden="true" />
        <span class="hp-title">{{ statusTitle }}</span>
      </div>
      <div class="hp-head-meta">
        <template v-if="elapsedLabel">{{ elapsedLabel }}</template>
        <template v-if="panels.toolCount"> · {{ panels.toolCount }} 次工具</template>
        <button type="button" class="hp-link" @click="emit('openDetail')">详情</button>
      </div>
    </header>

    <!-- ① 分析 / 读取 / 编辑记录 -->
    <div class="hp-block">
      <button type="button" class="hp-block-head" @click="toggle('trace')">
        <span class="hp-block-icon" aria-hidden="true">◆</span>
        <span class="hp-block-title">分析 · 读取 · 编辑记录</span>
        <span class="hp-block-badge">
          读取 {{ groups.read.length }} · 编辑 {{ groups.edit.length }}
        </span>
        <span class="hp-caret" :class="{ open: !isCollapsed('trace') }" aria-hidden="true">▾</span>
      </button>
      <div v-show="!isCollapsed('trace')" class="hp-block-body hp-trace">
        <template v-for="phase in (['analysis', 'read', 'edit', 'verify'] as HarnessPhase[])" :key="phase">
          <div v-if="groups[phase].length" class="hp-trace-group">
            <div class="hp-trace-group-label">
              {{ PHASE_META[phase].label }}（{{ groups[phase].length }}）
            </div>
            <div
              v-for="row in groups[phase]"
              :key="row.id"
              class="hp-trace-row"
              :class="[
                'is-' + phase,
                row.ok === false ? 'is-fail' : '',
                row.count && row.count > 1 ? 'is-repeat' : '',
              ]"
            >
              <span class="hp-trace-ico" aria-hidden="true">{{ PHASE_META[phase].icon }}</span>
              <span class="hp-trace-text">
                {{ row.text }}
                <span v-if="row.count && row.count > 1" class="hp-trace-count">×{{ row.count }}</span>
              </span>
            </div>
          </div>
        </template>
        <p v-if="!panels.analysis.length" class="hp-empty">等待 AI 返回分析结果…</p>
      </div>
    </div>

    <!-- ② 思考结果 -->
    <div class="hp-block">
      <button type="button" class="hp-block-head" @click="toggle('think')">
        <span class="hp-block-icon" aria-hidden="true">◌</span>
        <span class="hp-block-title">思考结果</span>
        <span class="hp-block-badge">
          {{ panels.thinking.length ? `${panels.thinking.length} 轮` : '暂无' }}
        </span>
        <span class="hp-caret" :class="{ open: !isCollapsed('think') }" aria-hidden="true">▾</span>
      </button>
      <div v-show="!isCollapsed('think')" class="hp-block-body">
        <template v-if="thinkingRows().length">
          <div v-for="row in thinkingRows()" :key="row.key" class="hp-think">
            <button type="button" class="hp-think-head" @click="toggleThinking(row.key)">
              <span>第 {{ row.round }} 轮思考</span>
              <span class="hp-think-toggle">
                {{ expandedThinking[row.key] ? '收起' : '展开' }}
              </span>
            </button>
            <pre
              v-if="expandedThinking[row.key]"
              class="hp-think-body"
            >{{ row.text }}</pre>
            <p v-else class="hp-think-preview">{{ row.text.slice(0, 90) }}{{ row.text.length > 90 ? '…' : '' }}</p>
          </div>
        </template>
        <p v-else class="hp-empty">
          {{ running ? '模型尚未输出思考内容…' : '本轮模型未返回 reasoning 思考内容' }}
        </p>
        <details v-if="thinkingText && false" class="hp-think-full">
          <summary>全部思考</summary>
          <pre>{{ thinkingText }}</pre>
        </details>
      </div>
    </div>

    <!-- ③ 任务列表：进行中 / 待完成 / 已完成 -->
    <div class="hp-block">
      <button type="button" class="hp-block-head" @click="toggle('todos')">
        <span class="hp-block-icon" aria-hidden="true">☑</span>
        <span class="hp-block-title">任务列表</span>
        <span class="hp-block-badge">{{ todoSummary }}</span>
        <span class="hp-caret" :class="{ open: !isCollapsed('todos') }" aria-hidden="true">▾</span>
      </button>
      <div v-show="!isCollapsed('todos')" class="hp-block-body">
        <template v-if="panels.todos.length">
          <div v-if="todoGroups.inProgress.length" class="hp-todo-group">
            <div class="hp-todo-group-label is-active">进行中 · {{ todoGroups.inProgress.length }}</div>
            <div v-for="t in todoGroups.inProgress" :key="t.id" class="hp-todo is-in_progress">
              <span class="hp-todo-mark" aria-hidden="true">◉</span>
              <span class="hp-todo-text">{{ t.content }}</span>
              <span class="hp-todo-status">{{ todoStatusText(t.status) }}</span>
            </div>
          </div>
          <div v-if="todoGroups.pending.length" class="hp-todo-group">
            <div class="hp-todo-group-label">待完成 · {{ todoGroups.pending.length }}</div>
            <div v-for="t in todoGroups.pending" :key="t.id" class="hp-todo is-pending">
              <span class="hp-todo-mark" aria-hidden="true">○</span>
              <span class="hp-todo-text">{{ t.content }}</span>
              <span class="hp-todo-status">{{ todoStatusText(t.status) }}</span>
            </div>
          </div>
          <div v-if="todoGroups.completed.length" class="hp-todo-group">
            <div class="hp-todo-group-label is-done">已完成 · {{ todoGroups.completed.length }}</div>
            <div v-for="t in todoGroups.completed" :key="t.id" class="hp-todo is-completed">
              <span class="hp-todo-mark" aria-hidden="true">✓</span>
              <span class="hp-todo-text">{{ t.content }}</span>
              <span class="hp-todo-status">{{ todoStatusText(t.status) }}</span>
            </div>
          </div>
        </template>
        <p v-else class="hp-empty">
          {{ running ? 'AI 正在拆解任务…' : '本轮未创建任务清单（单步任务）' }}
        </p>
      </div>
    </div>

    <!-- ④ 本次修改的文件 -->
    <div class="hp-block hp-block--last">
      <button type="button" class="hp-block-head" @click="toggle('files')">
        <span class="hp-block-icon" aria-hidden="true">▤</span>
        <span class="hp-block-title">本次修改的文件</span>
        <span class="hp-block-badge">
          {{ fileSummary.count }} 个
          <template v-if="fileSummary.added || fileSummary.removed">
            · <span class="hp-delta">+{{ fileSummary.added }}</span>
            <span class="hp-delta-minus">-{{ fileSummary.removed }}</span>
          </template>
        </span>
        <span class="hp-caret" :class="{ open: !isCollapsed('files') }" aria-hidden="true">▾</span>
      </button>
      <div v-show="!isCollapsed('files')" class="hp-block-body">
        <template v-if="panels.files.length">
          <div v-for="f in panels.files" :key="f.path" class="hp-file">
            <span class="hp-file-kind" :class="'is-' + f.kind">
              {{ f.kind === 'delete' ? '删' : f.kind === 'replace' ? '改' : '写' }}
            </span>
            <span class="hp-file-path" :title="f.path">{{ shortPath(f.path) }}</span>
            <span v-if="f.added || f.removed" class="hp-file-delta">
              <span class="hp-delta">+{{ f.added || 0 }}</span>
              <span class="hp-delta-minus">-{{ f.removed || 0 }}</span>
            </span>
            <button
              v-if="hasDiff && hasDiff(f.path)"
              type="button"
              class="hp-file-diff"
              @click="emit('openDiff', f.path)"
            >
              diff
            </button>
          </div>
          <button type="button" class="hp-files-more" @click="emit('openFiles')">
            查看全部修改文件与上传（{{ fileSummary.count }}）
          </button>
        </template>
        <p v-else class="hp-empty">
          {{ running ? '尚未修改文件…' : '本轮未修改任何文件' }}
        </p>
      </div>
    </div>
  </section>
</template>

/**
 * Harness 式对话面板构建器。
 *
 * 一次对话（turn）从用户发送消息开始，到 Assistant 结束为止。
 * 每个 AI 接口结果（工具调用、思考增量、任务清单更新…）都通过本模块
 * 归档到对应板块，供 UI 三个板块实时追加记录与状态：
 *
 *  ① 分析记录：读取 / 编辑 / 校验 三类事件按发生顺序累积
 *  ② 思考结果：每轮 reasoning 聚合
 *  ③ 任务列表：进行中 / 待完成 / 已完成
 *  ④ 本次修改文件：路径 + 行增删
 */
import type {
  FileDiffSnippet,
  HarnessFileChange,
  HarnessPhase,
  HarnessTodoGroup,
  HarnessTurnPanels,
  TodoItem,
  ToolLogEntry,
} from '@/types';

const MAX_ANALYSIS = 400;
const MAX_THINKING = 60;
const MAX_FILE_ROWS = 200;

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

const WRITE_TOOLS = new Set(['write_file', 'search_replace', 'delete_file']);
const READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir']);
const VERIFY_TOOLS = new Set(['run_command', 'test', 'lint']);

export function emptyTurnPanels(prompt = '', turnId = nextId('turn')): HarnessTurnPanels {
  return {
    turnId,
    startedAt: Date.now(),
    prompt,
    analysis: [],
    thinking: [],
    todos: [],
    files: [],
    toolCount: 0,
    readCount: 0,
    writeCount: 0,
    allDone: false,
  };
}

export function phaseOfTool(name: string): HarnessPhase {
  if (WRITE_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (VERIFY_TOOLS.has(name)) return 'verify';
  return 'analysis';
}

function kindOfTool(name: string): HarnessFileChange['kind'] {
  if (name === 'delete_file') return 'delete';
  if (name === 'search_replace') return 'replace';
  return 'write';
}

/** 分析记录：同一阶段的连续同类条目合并计数，避免面板被刷屏 */
export function pushAnalysis(
  panels: HarnessTurnPanels,
  entry: { phase: HarnessPhase; text: string; path?: string; ok?: boolean },
): void {
  const last = panels.analysis[panels.analysis.length - 1];
  if (
    last &&
    last.phase === entry.phase &&
    last.path === entry.path &&
    last.ok === entry.ok &&
    entry.phase !== 'edit' &&
    last.text === entry.text
  ) {
    last.count = (last.count || 1) + 1;
    last.at = Date.now();
    return;
  }
  panels.analysis.push({
    id: nextId('an'),
    phase: entry.phase,
    at: Date.now(),
    text: entry.text,
    path: entry.path,
    ok: entry.ok,
    count: 1,
  });
  if (panels.analysis.length > MAX_ANALYSIS) {
    panels.analysis.splice(0, panels.analysis.length - MAX_ANALYSIS);
  }
}

/** 工具执行完成：追加分析记录 + 修改文件 + 统计 */
export function recordTool(
  panels: HarnessTurnPanels,
  entry: ToolLogEntry,
  diff?: FileDiffSnippet,
): void {
  panels.toolCount += 1;
  const phase = phaseOfTool(entry.name);
  if (phase === 'read') panels.readCount += 1;
  if (phase === 'edit' && entry.ok) panels.writeCount += 1;

  if (entry.name === 'update_todos' || entry.name === 'ask_user') {
    pushAnalysis(panels, {
      phase: 'analysis',
      text: entry.label,
      ok: entry.ok,
    });
    return;
  }

  pushAnalysis(panels, {
    phase,
    text: entry.label,
    path: entry.path,
    ok: entry.ok,
  });

  if (!entry.ok || !WRITE_TOOLS.has(entry.name)) return;
  const path = String(entry.path || '').trim();
  if (!path) return;

  const kind = kindOfTool(entry.name);
  const at = Date.now();
  const existing = panels.files.find((f) => f.path === path);
  if (existing) {
    // 同一文件多次改动：保留首次出现顺序，累加增删
    existing.kind = kind === 'delete' ? 'delete' : existing.kind;
    existing.added = (existing.added || 0) + (diff?.added ?? entry.added ?? 0);
    existing.removed = (existing.removed || 0) + (diff?.removed ?? entry.removed ?? 0);
    existing.at = at;
    return;
  }
  panels.files.push({
    path,
    kind,
    added: diff?.added ?? entry.added,
    removed: diff?.removed ?? entry.removed,
    at,
  });
  if (panels.files.length > MAX_FILE_ROWS) {
    panels.files.splice(0, panels.files.length - MAX_FILE_ROWS);
  }
}

/** 思考结果：按轮次聚合（同一轮 reasoning 增量覆盖拼接） */
export function recordThinking(
  panels: HarnessTurnPanels,
  round: number,
  reasoning: string,
): void {
  const text = String(reasoning || '').trim();
  if (!text) return;
  // 每轮一条：用 round 标记，流式增量覆盖同轮
  const marker = `#r${round}`;
  const idx = panels.thinking.findIndex((t) => t.startsWith(marker));
  const body = `${marker} ${text}`;
  if (idx >= 0) panels.thinking[idx] = body;
  else {
    panels.thinking.push(body);
    if (panels.thinking.length > MAX_THINKING) {
      panels.thinking.splice(0, panels.thinking.length - MAX_THINKING);
    }
  }
}

/** 任务清单更新：全部完成后置 allDone */
export function recordTodos(panels: HarnessTurnPanels, todos: TodoItem[]): void {
  panels.todos = todos.map((t) => ({ ...t }));
  panels.allDone = todos.length > 0 && todos.every((t) => t.status === 'completed');
}

/** 分组：进行中 / 待完成 / 已完成（cancelled 归入待完成，避免凭空消失） */
export function groupTodos(todos: TodoItem[]): HarnessTodoGroup {
  const group: HarnessTodoGroup = { inProgress: [], pending: [], completed: [] };
  for (const t of todos) {
    if (t.status === 'completed') group.completed.push(t);
    else if (t.status === 'in_progress') group.inProgress.push(t);
    else group.pending.push(t);
  }
  return group;
}

export function todoProgressLabel(todos: TodoItem[]): string {
  const g = groupTodos(todos);
  const parts: string[] = [];
  if (g.inProgress.length) parts.push(`${g.inProgress.length} 进行中`);
  if (g.pending.length) parts.push(`${g.pending.length} 待完成`);
  if (g.completed.length) parts.push(`${g.completed.length} 已完成`);
  return parts.join(' · ') || '暂无任务';
}

export function finishTurnPanels(
  panels: HarnessTurnPanels,
  opts: { error?: string } = {},
): HarnessTurnPanels {
  const all = panels.todos.length > 0 && panels.todos.every((t) => t.status === 'completed');
  panels.allDone = all;
  panels.endedAt = Date.now();
  if (opts.error) panels.error = opts.error;
  if (!panels.todos.length) {
    pushAnalysis(panels, {
      phase: 'analysis',
      text: panels.files.length
        ? `本次直接修改 ${panels.files.length} 个文件，未拆解任务清单`
        : '本轮未修改文件',
      ok: true,
    });
  } else if (!all) {
    const open = panels.todos.filter((t) => t.status !== 'completed');
    pushAnalysis(panels, {
      phase: 'analysis',
      text: `任务清单仍有 ${open.length} 项未完成：${open
        .slice(0, 4)
        .map((t) => t.content)
        .join('、')}`,
      ok: false,
    });
  } else {
    pushAnalysis(panels, {
      phase: 'verify',
      text: `任务清单全部完成（${panels.todos.length} 项）`,
      ok: true,
    });
  }
  return panels;
}

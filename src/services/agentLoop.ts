import { chatTurnStream, TOOL_DEFINITIONS } from '@/api/agentServer';
import type {
  AgentServerConfig,
  AgentTurnResult,
  FileDiffSnippet,
  TodoItem,
  TodoStatus,
  ToolLogEntry,
  WorkProject,
} from '@/types';
import {
  readProjectFile,
  writeProjectFile,
  deleteProjectFile,
  listProjectDir,
  grepProject,
  globProject,
  trackModified,
} from './localFs';
import {
  buildAgentSystemPrompt,
  loadProjectRulesText,
  resolveScopedPath,
  scopePrefix,
} from './projectScope';
import {
  type HarnessDigest,
  HARNESS_WRITE_TOOLS,
  harnessDigestFormat,
  harnessDigestFromToolLog,
  createStartMessage,
  duplicateReadMessage,
  editNudgeMessage,
  filterWriteToolDefs,
  forceWriteMessage,
  logHasSuccessfulWrite,
  pruneMessages,
  readCacheKey,
  readStreakMessage,
  roundsLowEditMessage,
  truncateToolOutput,
  wantsCreate,
  wantsEdit,
  READ_STREAK_FORCE_AT,
  READ_STREAK_NUDGE_AT,
} from './harness';
import { buildUnifiedSnippet } from '@/utils/fileDiff';
import { extractFencedFiles, extractToolCallsFromContent } from './toolCallParse';
import {
  extractAskOptions,
  looksLikeClarifyingQuestion,
  type AskUserHandler,
} from './askUser';

function toolLabel(name: string, args: Record<string, unknown>): string {
  const path = String(args.path || '');
  if (name === 'read_file') return `读文件 ${path}`;
  if (name === 'write_file') return `写文件 ${path}`;
  if (name === 'search_replace') return `替换 ${path}`;
  if (name === 'grep') return `搜索「${args.pattern || ''}」`;
  if (name === 'glob') return `glob ${args.glob_pattern || ''}`;
  if (name === 'list_dir') return `列目录 ${path || '/'}`;
  if (name === 'delete_file') return `删文件 ${path}`;
  if (name === 'ask_user') return `询问用户：${String(args.question || '').slice(0, 40)}`;
  if (name === 'update_todos') {
    const list = Array.isArray(args.todos) ? args.todos : [];
    return `更新任务清单 · ${list.length} 项`;
  }
  return name;
}

const TODO_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'cancelled']);

function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id || '').trim();
    const content = String(r.content || '').trim();
    const status = String(r.status || 'pending').trim() as TodoStatus;
    if (!id || !content) continue;
    out.push({
      id,
      content: content.slice(0, 200),
      status: TODO_STATUSES.has(status) ? status : 'pending',
    });
  }
  return out.slice(0, 40);
}

function mergeTodos(prev: TodoItem[], patch: TodoItem[], merge: boolean): TodoItem[] {
  if (!merge) return patch.length ? patch : prev;
  const map = new Map(prev.map((t) => [t.id, { ...t }]));
  for (const t of patch) {
    const old = map.get(t.id);
    map.set(t.id, old ? { ...old, ...t } : t);
  }
  return [...map.values()];
}

function guardPath(
  path: string,
  workRoot: string,
  required = false,
): { ok: true; rel: string } | { ok: false; output: string } {
  const raw = String(path || '').trim();
  if (!raw) {
    if (required) return { ok: false, output: '缺少 path 参数' };
    return { ok: true, rel: scopePrefix(workRoot) };
  }
  const rel = resolveScopedPath(raw, workRoot);
  if (rel === null) {
    const ws = scopePrefix(workRoot) || '/';
    return { ok: false, output: `路径越界：仅允许访问工作区 \`${ws}\` 内，禁止 .. 或项目外路径` };
  }
  return { ok: true, rel };
}

function filterGlobByScope(output: string, workRoot: string): string {
  const prefix = scopePrefix(workRoot);
  if (!prefix) return output;
  const lines = output.split('\n').filter((line) => {
    if (!line || line.startsWith('（')) return true;
    return line === prefix || line.startsWith(prefix + '/');
  });
  return lines.join('\n') || '（无匹配）';
}

async function executeTool(
  project: WorkProject,
  name: string,
  args: Record<string, unknown>,
  readCache: Map<string, boolean>,
  workRoot: string,
): Promise<{ ok: boolean; output: string; diff?: FileDiffSnippet }> {
  try {
    const key = readCacheKey(name, args);
    if (!HARNESS_WRITE_TOOLS.has(name) && key && readCache.has(key)) {
      return { ok: true, output: duplicateReadMessage(name, args) };
    }
    if (!HARNESS_WRITE_TOOLS.has(name) && key) {
      readCache.set(key, true);
    }

    let output = '';
    let diff: FileDiffSnippet | undefined;
    if (name === 'read_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      output = await readProjectFile(project, g.rel);
    } else if (name === 'write_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      let before = '';
      try {
        before = await readProjectFile(project, g.rel);
      } catch {
        before = '';
      }
      const after = String(args.content || '');
      const written = await writeProjectFile(project, g.rel, after);
      // 已实时落到手机则不必进「写回」队列；否则记入待写回
      if (!written.phoneSynced) {
        await trackModified(project.id, g.rel);
      }
      output = written.phoneSynced
        ? `已写入手机 ${g.rel}（父目录已自动创建）`
        : `已写入沙盒 ${g.rel}（未绑定手机目录；可在项目里授权后点「写回手机」）`;
      diff = buildUnifiedSnippet(g.rel, before, after, 'write');
    } else if (name === 'search_replace') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      const before = await readProjectFile(project, g.rel);
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      if (!before.includes(oldStr)) {
        return { ok: false, output: 'old_string 未找到' };
      }
      let after = before;
      if (args.replace_all) {
        after = before.split(oldStr).join(newStr);
      } else {
        after = before.replace(oldStr, newStr);
      }
      const written = await writeProjectFile(project, g.rel, after);
      if (!written.phoneSynced) {
        await trackModified(project.id, g.rel);
      }
      output = written.phoneSynced
        ? `已替换并写入手机 ${g.rel}`
        : `已替换沙盒 ${g.rel}（未绑定手机目录）`;
      // 审阅优先展示替换片段
      diff = buildUnifiedSnippet(g.rel, oldStr, newStr, 'replace');
    } else if (name === 'delete_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      let before = '';
      try {
        before = await readProjectFile(project, g.rel);
      } catch {
        before = '';
      }
      await deleteProjectFile(project, g.rel);
      await trackModified(project.id, g.rel);
      output = `已删除 ${g.rel}`;
      diff = buildUnifiedSnippet(g.rel, before, '', 'delete');
    } else if (name === 'list_dir') {
      const g = guardPath(String(args.path || ''), workRoot);
      if (!g.ok) return g;
      const files = await listProjectDir(project, g.rel);
      output =
        files.join('\n') ||
        '（空目录）若任务是从 0 创建项目/文件，请立即用 write_file 创建，不要只输出计划或目录结构。';
    } else if (name === 'grep') {
      const g = guardPath(String(args.path || ''), workRoot);
      if (!g.ok) return g;
      const out = await grepProject(project, String(args.pattern || ''), g.rel);
      output = filterGlobByScope(out, workRoot);
    } else if (name === 'glob') {
      const out = await globProject(project, String(args.glob_pattern || '*'));
      output = filterGlobByScope(out, workRoot);
    } else {
      return { ok: false, output: `未知工具 ${name}` };
    }

    return { ok: true, output: truncateToolOutput(name, output), diff };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export type AgentLoopEvent =
  | { type: 'round'; round: number; forceWrite?: boolean }
  | { type: 'tool_start'; name: string; label: string; path?: string }
  | { type: 'tool'; entry: ToolLogEntry }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'delta'; content: string; reasoning?: string }
  | { type: 'done'; result: AgentTurnResult }
  | { type: 'error'; message: string };

export type AgentLoopConfirm = (message: string) => boolean | Promise<boolean>;

const READ_ONLY_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir']);

/**
 * 移动端 Agent 循环：对齐 agent/lib/agent_loop.php + harness.php
 * 直连用户配置的中转站 apiBaseUrl + apiKey；写文件实时落到手机工作区。
 */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
}

export async function runAgentLoop(
  project: WorkProject,
  agent: AgentServerConfig,
  userText: string,
  onEvent: (e: AgentLoopEvent) => void,
  maxRounds = 30,
  priorMessages: Array<{ role: string; content: string }> = [],
  workRoot = '',
  harnessDigest: HarnessDigest = { modified_files: [], read_files: [], grep_keys: [] },
  signal?: AbortSignal,
  confirmAction?: AgentLoopConfirm,
  askUser?: AskUserHandler,
): Promise<AgentTurnResult> {
  const model = agent.model || '';
  if (!model) {
    throw new Error('请先在「设置」中配置默认模型');
  }
  if (!agent.apiBaseUrl?.trim() || !agent.apiKey?.trim()) {
    throw new Error('请先在「设置」中配置 API 地址与 Key（中转站自定义 URL）');
  }
  // 工具循环默认开启；仅显式关闭时拒绝编辑类任务空跑
  if (agent.toolsEnabled === false) {
    throw new Error('已关闭工具调用。请在设置中开启 tools，否则无法实时写入文件');
  }

  const digestNote = harnessDigestFormat(harnessDigest);
  const projectRules = await loadProjectRulesText(project);
  const system = buildAgentSystemPrompt(
    project.name,
    project.localRootLabel,
    workRoot,
    agent.systemPrompt,
    digestNote,
    projectRules,
  );

  const rawHistory = priorMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
  const history = pruneMessages(rawHistory, harnessDigest).filter(
    (m) => (m as { role?: string }).role !== 'system',
  ) as Array<{ role: string; content: string }>;

  const messages: unknown[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  const toolLog: ToolLogEntry[] = [];
  const toolLogWithArgs: Array<ToolLogEntry & { args?: Record<string, unknown> }> = [];
  const modified = new Set<string>();
  const fileDiffs: FileDiffSnippet[] = [];
  const readCache = new Map<string, boolean>();
  let finalContent = '';
  let finalReasoning = '';
  let readStreak = 0;
  let readsSinceWrite = 0;
  let streakNudges = 0;
  let forceUsed = 0;
  let writeHits = 0;
  let editNudges = 0;
  let clarifyAsks = 0;
  let turnTodos: TodoItem[] = [];
  const editIntent = wantsEdit(userText);
  const createIntent = wantsCreate(userText);

  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted(signal);
    const remaining = maxRounds - round;
    let useTools: unknown[] = [...TOOL_DEFINITIONS];
    let forceTurn = false;

    if (remaining === 2 && toolLog.length) {
      messages.push({
        role: 'user',
        content: editIntent ? roundsLowEditMessage() : '【系统】工具轮次即将用尽。请尽快给出结论；仅在缺关键信息时再调一次工具。',
      });
    }
    if (remaining === 1) {
      useTools = [];
      messages.push({
        role: 'user',
        content: editIntent
          ? '【系统】最后一轮：若需改代码请立即 search_replace/write_file；否则直接完整作答。'
          : '【系统】本轮不能再调用工具。请根据已掌握信息直接完整作答。',
      });
    }

    const streakForForce = Math.max(readStreak, readsSinceWrite);
    // 创建类任务首轮强制调工具；未落盘前可持续强制写入（直到写成功或轮次用尽）
    if (editIntent && writeHits === 0 && remaining > 1) {
      if (createIntent && round === 0 && forceUsed < 3) {
        forceTurn = true;
        forceUsed++;
        messages.push({ role: 'user', content: createStartMessage() });
      } else if (
        streakForForce >= READ_STREAK_FORCE_AT ||
        editNudges > 0 ||
        (createIntent && round > 0)
      ) {
        const subset = filterWriteToolDefs(TOOL_DEFINITIONS);
        if (subset.length) {
          useTools = subset;
          forceTurn = true;
          if (forceUsed < 12) {
            forceUsed++;
            messages.push({ role: 'user', content: forceWriteMessage() });
          }
        }
      } else if (streakForForce >= READ_STREAK_NUDGE_AT && streakNudges < 3) {
        streakNudges++;
        messages.push({ role: 'user', content: readStreakMessage(streakForForce) });
      }
    }

    onEvent({ type: 'round', round: round + 1, forceWrite: forceTurn });

    const runTurn = (tools: unknown[], choice?: string) =>
      chatTurnStream(
        agent,
        pruneMessages(messages, harnessDigest),
        tools,
        {
          model,
          max_tokens: agent.maxTokens ?? 8192,
          temperature: agent.temperature ?? 0.7,
          signal,
          ...(choice ? { tool_choice: choice } : {}),
        },
        (content, reasoning) => {
          finalContent = content;
          finalReasoning = reasoning;
          onEvent({ type: 'delta', content, reasoning });
        },
      );

    let turn: Awaited<ReturnType<typeof chatTurnStream>>;
    try {
      turn = await runTurn(useTools, forceTurn && useTools.length ? 'required' : undefined);
    } catch (e) {
      // 上游不支持 tool_choice / tools 时降级，避免整轮直接失败结束
      const msg = e instanceof Error ? e.message : String(e);
      if (forceTurn && useTools.length) {
        try {
          turn = await runTurn(useTools, undefined);
        } catch {
          if (/tool|function/i.test(msg)) {
            turn = await runTurn([], undefined);
          } else {
            throw e;
          }
        }
      } else if (useTools.length && /tool|function/i.test(msg)) {
        turn = await runTurn([], undefined);
      } else {
        throw e;
      }
    }

    if (turn.content) finalContent = turn.content;
    if (turn.reasoning) finalReasoning = turn.reasoning;

    let calls = turn.tool_calls || [];
    // 模型把工具调用写在正文里（无正式 tool_calls）时抢救
    if (!calls.length && turn.content) {
      const parsed = extractToolCallsFromContent(turn.content);
      if (parsed.length) calls = parsed;
    }

    if (!calls.length) {
      const text = String(turn.content || '').trim();
      const needsWrite =
        editIntent && writeHits === 0 && !logHasSuccessfulWrite(toolLog);

      // 正文在征询方案：弹框让用户选，选完继续跑（禁止当成任务结束）
      if (
        askUser &&
        text &&
        looksLikeClarifyingQuestion(text) &&
        clarifyAsks < 6 &&
        remaining > 1
      ) {
        clarifyAsks++;
        messages.push({ role: 'assistant', content: text });
        onEvent({ type: 'tool_start', name: 'ask_user', label: '等待你选择方案…' });
        const req = extractAskOptions(text);
        const answer = await askUser(req);
        onEvent({
          type: 'tool',
          entry: {
            name: 'ask_user',
            label: answer ? `用户选择：${answer.slice(0, 48)}` : '用户取消选择',
            ok: Boolean(answer),
          },
        });
        if (!answer) {
          finalContent = `${text}\n\n（已取消选择，本轮结束）`;
          break;
        }
        messages.push({
          role: 'user',
          content:
            `【用户选择】${answer}\n` +
            '请按此选择继续执行。若需创建/修改文件，立即调用 write_file / search_replace 落盘，不要再次只提问就结束。',
        });
        continue;
      }

      // 编辑任务尚未落盘：一直催/强制写，直到写入成功或轮次用尽（禁止一轮空跑就结束）
      if (needsWrite && remaining > 1) {
        // 先尝试把带路径的代码块直接写入
        if (text) {
          const fences = extractFencedFiles(text);
          if (fences.length) {
            const writtenPaths: string[] = [];
            for (const f of fences) {
              const g = guardPath(f.path, workRoot, true);
              if (!g.ok) continue;
              try {
                const written = await writeProjectFile(project, g.rel, f.content);
                if (!written.phoneSynced) await trackModified(project.id, g.rel);
                modified.add(g.rel);
                writeHits++;
                writtenPaths.push(g.rel);
                const diff = buildUnifiedSnippet(g.rel, '', f.content, 'write');
                const entry: ToolLogEntry = {
                  name: 'write_file',
                  label: `写文件 ${g.rel}`,
                  ok: true,
                  path: g.rel,
                  added: diff.added,
                  removed: diff.removed,
                };
                toolLog.push(entry);
                toolLogWithArgs.push({
                  ...entry,
                  args: { path: g.rel, content: f.content },
                });
                onEvent({ type: 'tool', entry });
                fileDiffs.push(diff);
              } catch (err) {
                const entry: ToolLogEntry = {
                  name: 'write_file',
                  label: `写文件 ${g.rel}`,
                  ok: false,
                  path: g.rel,
                };
                toolLog.push(entry);
                onEvent({ type: 'tool', entry });
                finalContent =
                  (finalContent ? finalContent + '\n\n' : '') +
                  `写入失败 ${g.rel}：${err instanceof Error ? err.message : String(err)}`;
              }
            }
            if (writtenPaths.length) {
              finalContent =
                (text ? text + '\n\n---\n\n' : '') +
                `已从回复中的代码块写入 ${writtenPaths.length} 个文件：` +
                writtenPaths.join('、');
              // 已有落盘，若正文像还没做完可继续；此处先结束本轮总结
              break;
            }
          }
        }

        editNudges++;
        messages.push({
          role: 'assistant',
          content: text || '（未调用工具，准备落盘）',
        });
        messages.push({
          role: 'user',
          content:
            editNudges <= 2
              ? editNudgeMessage()
              : forceWriteMessage() +
                ' 若仍有方案未定，请先调用 ask_user 弹出选项，选完后立刻 write_file。',
        });
        continue;
      }

      break;
    }

    messages.push({
      role: 'assistant',
      content: turn.content || '',
      tool_calls: calls,
    });

    let roundHadWrite = false;
    let roundHadRead = false;

    type CallJob = {
      tc: (typeof calls)[number];
      name: string;
      args: Record<string, unknown>;
      label: string;
    };

    const jobs: CallJob[] = calls.map((tc) => {
      const name = tc.function?.name || '';
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      if (HARNESS_WRITE_TOOLS.has(name)) roundHadWrite = true;
      else if (name === 'ask_user' || name === 'update_todos') {
        /* 询问 / 清单：不计入只读 streak */
      } else if (READ_ONLY_TOOLS.has(name)) roundHadRead = true;
      else if (name) roundHadRead = true;
      return { tc, name, args, label: toolLabel(name, args) };
    });

    const runOne = async (
      job: CallJob,
    ): Promise<{ output: string; ok: boolean; diff?: FileDiffSnippet }> => {
      throwIfAborted(signal);
      onEvent({
        type: 'tool_start',
        name: job.name,
        label: job.label,
        path: String(job.args.path || ''),
      });

      if (job.name === 'update_todos') {
        const patch = normalizeTodos(job.args.todos);
        if (!patch.length) {
          return { ok: false, output: 'todos 为空或格式无效' };
        }
        const merge = job.args.merge !== false;
        turnTodos = mergeTodos(turnTodos, patch, merge);
        onEvent({ type: 'todos', todos: turnTodos.map((t) => ({ ...t })) });
        const summary = turnTodos
          .map((t) => `${t.status}:${t.content}`)
          .slice(0, 12)
          .join('；');
        return {
          ok: true,
          output: `已更新任务清单（${turnTodos.length} 项）。${summary}`,
        };
      }

      if (job.name === 'ask_user') {
        if (!askUser) {
          return { ok: false, output: '当前界面不支持 ask_user 弹框' };
        }
        const question = String(job.args.question || '').trim() || '请选择一项以继续';
        let options: string[] = [];
        if (Array.isArray(job.args.options)) {
          options = job.args.options.map((x) => String(x)).filter(Boolean);
        } else if (typeof job.args.options === 'string') {
          options = String(job.args.options)
            .split(/\n|,|，/)
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (options.length < 2) {
          options = extractAskOptions(question).options;
        }
        const answer = await askUser({ question, options: options.slice(0, 8) });
        if (!answer) {
          return { ok: false, output: '用户取消了选择' };
        }
        return { ok: true, output: `用户选择：${answer}` };
      }

      if (job.name === 'delete_file') {
        const pathHint = String(job.args.path || '');
        const okConfirm = confirmAction
          ? await confirmAction(`确认删除文件「${pathHint}」？此操作不可撤销。`)
          : true;
        if (!okConfirm) {
          return { ok: false, output: '用户取消了删除操作' };
        }
      }

      return executeTool(project, job.name, job.args, readCache, workRoot);
    };

    // 本轮若全是只读工具则并行，缩短墙钟时间；含写入则按序执行保一致性
    const allReadOnly = jobs.every((j) => READ_ONLY_TOOLS.has(j.name));
    const settled: Array<{ ok: boolean; output: string; diff?: FileDiffSnippet }> = new Array(
      jobs.length,
    );

    if (allReadOnly && jobs.length > 1) {
      const parts = await Promise.all(jobs.map((job) => runOne(job)));
      parts.forEach((res, i) => {
        settled[i] = res;
      });
    } else {
      for (let i = 0; i < jobs.length; i++) {
        settled[i] = await runOne(jobs[i]);
      }
    }

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const res = settled[i];
      const entry: ToolLogEntry = {
        name: job.name,
        label: job.label,
        ok: res.ok,
        path: String(job.args.path || ''),
        added: res.diff?.added,
        removed: res.diff?.removed,
      };
      toolLog.push(entry);
      toolLogWithArgs.push({ ...entry, args: job.args });
      onEvent({ type: 'tool', entry });

      if (res.ok && HARNESS_WRITE_TOOLS.has(job.name)) {
        writeHits++;
        const g = guardPath(String(job.args.path || ''), workRoot, true);
        if (g.ok) modified.add(g.rel);
      }
      if (res.diff) {
        const i = fileDiffs.findIndex((d) => d.path === res.diff!.path);
        if (i >= 0) fileDiffs[i] = res.diff;
        else fileDiffs.push(res.diff);
      }

      messages.push({
        role: 'tool',
        tool_call_id: job.tc.id,
        content: res.output,
      });
    }

    if (roundHadWrite) {
      readStreak = 0;
      readsSinceWrite = 0;
    } else if (roundHadRead) {
      readStreak++;
      readsSinceWrite++;
    }
  }

  const updatedDigest = harnessDigestFromToolLog(harnessDigest, toolLogWithArgs);
  const result: AgentTurnResult = {
    content: finalContent || '（已完成工具操作，无文字总结）',
    reasoning: finalReasoning || undefined,
    toolLog,
    modifiedFiles: [...modified],
    fileDiffs: fileDiffs.length ? fileDiffs : undefined,
    harnessDigest: updatedDigest,
  };
  onEvent({ type: 'done', result });
  return result;
}

import { chatTurnStream, TOOL_DEFINITIONS } from '@/api/agentServer';
import type { AgentServerConfig, AgentTurnResult, ToolLogEntry, WorkProject } from '@/types';
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
  resolveScopedPath,
  scopePrefix,
} from './projectScope';
import {
  type HarnessDigest,
  HARNESS_WRITE_TOOLS,
  harnessDigestFormat,
  harnessDigestFromToolLog,
  duplicateReadMessage,
  filterWriteToolDefs,
  forceWriteMessage,
  pruneMessages,
  readCacheKey,
  readStreakMessage,
  roundsLowEditMessage,
  truncateToolOutput,
  wantsEdit,
  READ_STREAK_FORCE_AT,
  READ_STREAK_NUDGE_AT,
} from './harness';

function toolLabel(name: string, args: Record<string, unknown>): string {
  const path = String(args.path || '');
  if (name === 'read_file') return `读文件 ${path}`;
  if (name === 'write_file') return `写文件 ${path}`;
  if (name === 'search_replace') return `替换 ${path}`;
  if (name === 'grep') return `搜索「${args.pattern || ''}」`;
  if (name === 'glob') return `glob ${args.glob_pattern || ''}`;
  if (name === 'list_dir') return `列目录 ${path || '/'}`;
  if (name === 'delete_file') return `删文件 ${path}`;
  return name;
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
): Promise<{ ok: boolean; output: string }> {
  try {
    const key = readCacheKey(name, args);
    if (!HARNESS_WRITE_TOOLS.has(name) && key && readCache.has(key)) {
      return { ok: true, output: duplicateReadMessage(name, args) };
    }
    if (!HARNESS_WRITE_TOOLS.has(name) && key) {
      readCache.set(key, true);
    }

    let output = '';
    if (name === 'read_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      output = await readProjectFile(project, g.rel);
    } else if (name === 'write_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      await writeProjectFile(project, g.rel, String(args.content || ''));
      await trackModified(project.id, g.rel);
      output = `已写入 ${g.rel}`;
    } else if (name === 'search_replace') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      let text = await readProjectFile(project, g.rel);
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      if (!text.includes(oldStr)) {
        return { ok: false, output: 'old_string 未找到' };
      }
      if (args.replace_all) {
        text = text.split(oldStr).join(newStr);
      } else {
        text = text.replace(oldStr, newStr);
      }
      await writeProjectFile(project, g.rel, text);
      await trackModified(project.id, g.rel);
      output = `已替换 ${g.rel}`;
    } else if (name === 'delete_file') {
      const g = guardPath(String(args.path || ''), workRoot, true);
      if (!g.ok) return g;
      await deleteProjectFile(project, g.rel);
      await trackModified(project.id, g.rel);
      output = `已删除 ${g.rel}`;
    } else if (name === 'list_dir') {
      const g = guardPath(String(args.path || ''), workRoot);
      if (!g.ok) return g;
      const files = await listProjectDir(project, g.rel);
      output = files.join('\n') || '（空目录）';
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

    return { ok: true, output: truncateToolOutput(name, output) };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export type AgentLoopEvent =
  | { type: 'round'; round: number; forceWrite?: boolean }
  | { type: 'tool'; entry: ToolLogEntry }
  | { type: 'delta'; content: string; reasoning?: string }
  | { type: 'done'; result: AgentTurnResult }
  | { type: 'error'; message: string };

/**
 * 移动端 Agent 循环：对齐 agent/lib/agent_loop.php + harness.php
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
): Promise<AgentTurnResult> {
  const model = agent.model || '';
  if (!model) {
    throw new Error('请先在「设置」中配置默认模型');
  }
  if (!agent.apiBaseUrl?.trim() || !agent.apiKey?.trim()) {
    throw new Error('请先在「设置」中配置 API 地址与 Key');
  }

  const digestNote = harnessDigestFormat(harnessDigest);
  const system = buildAgentSystemPrompt(
    project.name,
    project.localRootLabel,
    workRoot,
    agent.systemPrompt,
    digestNote,
  );

  const history = priorMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  const messages: unknown[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  const toolLog: ToolLogEntry[] = [];
  const toolLogWithArgs: Array<ToolLogEntry & { args?: Record<string, unknown> }> = [];
  const modified = new Set<string>();
  const readCache = new Map<string, boolean>();
  let finalContent = '';
  let finalReasoning = '';
  let readStreak = 0;
  let readsSinceWrite = 0;
  let streakNudges = 0;
  let forceUsed = 0;
  const editIntent = wantsEdit(userText);

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
    if (editIntent) {
      if (streakForForce >= READ_STREAK_FORCE_AT && forceUsed < 3) {
        const subset = filterWriteToolDefs(TOOL_DEFINITIONS);
        if (subset.length) {
          useTools = subset;
          forceTurn = true;
          forceUsed++;
          messages.push({ role: 'user', content: forceWriteMessage() });
        }
      } else if (streakForForce >= READ_STREAK_NUDGE_AT && streakNudges < 3) {
        streakNudges++;
        messages.push({ role: 'user', content: readStreakMessage(streakForForce) });
      }
    }

    onEvent({ type: 'round', round: round + 1, forceWrite: forceTurn });

    const turnOpts = {
      model,
      max_tokens: agent.maxTokens ?? 8192,
      temperature: agent.temperature ?? 0.7,
      signal,
      ...(forceTurn && useTools.length ? { tool_choice: 'required' as const } : {}),
    };

    const turn = await chatTurnStream(
      agent,
      pruneMessages(messages),
      useTools,
      turnOpts,
      (content, reasoning) => {
        finalContent = content;
        finalReasoning = reasoning;
        onEvent({ type: 'delta', content, reasoning });
      },
    );

    if (turn.content) finalContent = turn.content;
    if (turn.reasoning) finalReasoning = turn.reasoning;

    const calls = turn.tool_calls || [];
    if (!calls.length) break;

    messages.push({
      role: 'assistant',
      content: turn.content || '',
      tool_calls: calls,
    });

    let roundHadWrite = false;
    let roundHadRead = false;

    for (const tc of calls) {
      const name = tc.function?.name || '';
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }

      if (HARNESS_WRITE_TOOLS.has(name)) roundHadWrite = true;
      else roundHadRead = true;

      const res = await executeTool(project, name, args, readCache, workRoot);
      const entry: ToolLogEntry = {
        name,
        label: toolLabel(name, args),
        ok: res.ok,
        path: String(args.path || ''),
      };
      toolLog.push(entry);
      toolLogWithArgs.push({ ...entry, args });
      onEvent({ type: 'tool', entry });

      if (res.ok && HARNESS_WRITE_TOOLS.has(name)) {
        const g = guardPath(String(args.path || ''), workRoot, true);
        if (g.ok) modified.add(g.rel);
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
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
    harnessDigest: updatedDigest,
  };
  onEvent({ type: 'done', result });
  return result;
}

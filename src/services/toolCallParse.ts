/**
 * 从模型纯文本中抢救工具调用 / 文件代码块。
 * 部分国产模型不返回 OpenAI tool_calls，只把调用或代码写在 content 里。
 */

export type ParsedToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

const WRITE_NAMES = new Set(['write_file', 'search_replace', 'delete_file', 'read_file', 'list_dir', 'grep', 'glob']);

function makeId(i: number): string {
  return `parsed_call_${i}_${Date.now().toString(36)}`;
}

function asCall(name: string, args: Record<string, unknown>, i: number): ParsedToolCall | null {
  const n = String(name || '').trim();
  if (!WRITE_NAMES.has(n)) return null;
  return {
    id: makeId(i),
    function: { name: n, arguments: JSON.stringify(args) },
  };
}

/** 解析 content 里的伪 tool_calls（XML / JSON / 行内） */
export function extractToolCallsFromContent(content: string): ParsedToolCall[] {
  const text = String(content || '');
  if (!text.trim()) return [];
  const out: ParsedToolCall[] = [];
  let i = 0;

  // <tool_call>{"name":"write_file","arguments":{...}}</tool_call>
  // <tool_call><name>write_file</name><arguments>{...}</arguments></tool_call>
  const xmlBlock = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  while ((m = xmlBlock.exec(text)) !== null) {
    const body = m[1].trim();
    try {
      const json = JSON.parse(body) as { name?: string; arguments?: unknown };
      const args =
        typeof json.arguments === 'string'
          ? (JSON.parse(json.arguments) as Record<string, unknown>)
          : ((json.arguments || {}) as Record<string, unknown>);
      const call = asCall(String(json.name || ''), args, i++);
      if (call) out.push(call);
      continue;
    } catch {
      /* try name/arguments tags */
    }
    const nameM = /<name>\s*([^<]+)\s*<\/name>/i.exec(body);
    const argsM = /<arguments>\s*([\s\S]*?)\s*<\/arguments>/i.exec(body);
    if (nameM && argsM) {
      try {
        const args = JSON.parse(argsM[1]) as Record<string, unknown>;
        const call = asCall(nameM[1], args, i++);
        if (call) out.push(call);
      } catch {
        /* ignore */
      }
    }
  }

  // <function=write_file>{"path":"..."}</function>  (部分 Qwen 变体)
  const fnTag = /<function=([a-z_]+)>\s*([\s\S]*?)<\/function>/gi;
  while ((m = fnTag.exec(text)) !== null) {
    try {
      const args = JSON.parse(m[2]) as Record<string, unknown>;
      const call = asCall(m[1], args, i++);
      if (call) out.push(call);
    } catch {
      /* ignore */
    }
  }

  // ```json\n{"name":"write_file","arguments":{...}}\n```
  const jsonFence = /```(?:json)?\s*\n(\{[\s\S]*?"name"\s*:\s*"(?:write_file|search_replace|delete_file|read_file|list_dir|grep|glob)"[\s\S]*?\})\s*\n```/gi;
  while ((m = jsonFence.exec(text)) !== null) {
    try {
      const json = JSON.parse(m[1]) as { name?: string; arguments?: unknown };
      const args =
        typeof json.arguments === 'string'
          ? (JSON.parse(json.arguments) as Record<string, unknown>)
          : ((json.arguments || {}) as Record<string, unknown>);
      const call = asCall(String(json.name || ''), args, i++);
      if (call) out.push(call);
    } catch {
      /* ignore */
    }
  }

  return out;
}

export type FencedFile = { path: string; content: string };

/**
 * 从 markdown 代码围栏提取「带路径」的文件。
 * 支持：
 *   ```src/App.vue
 *   ```vue:src/App.vue
 *   ```html title="index.html"
 *   **path**: `src/a.ts` 后紧跟代码块
 */
export function extractFencedFiles(content: string): FencedFile[] {
  const text = String(content || '');
  const files: FencedFile[] = [];
  const seen = new Set<string>();

  const fenceRe =
    /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const header = (m[1] || '').trim();
    const body = m[2].replace(/\n$/, '');
    if (!body.trim()) continue;
    if (/^json$/i.test(header)) continue;

    let path = '';
    // src/App.vue 或 vue:src/App.vue 或 vue src/App.vue
    const direct = header.match(
      /(?:^|[\s:])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|(?:[\w.-]+\.[A-Za-z0-9]+))$/,
    );
    if (direct) path = direct[1];

    if (!path) {
      const titled = /(?:path|file|filename)\s*[=:]\s*["']?([^"'\s]+)["']?/i.exec(header);
      if (titled) path = titled[1];
    }

    // 代码块前一行：**`src/x.ts`** 或 文件：`src/x.ts`
    if (!path) {
      const before = text.slice(Math.max(0, m.index - 120), m.index);
      const prev = before.match(
        /(?:^|\n)\s*(?:#{1,3}\s*)?(?:文件|路径|创建|新建)?\s*[：:]?\s*[`*]*(?:[\w./-]+\/)?([\w./-]+\.[A-Za-z0-9]+)[`*]*\s*$/,
      );
      if (prev) path = prev[1];
    }

    path = path.replace(/^\/+/, '').replace(/\\/g, '/');
    if (!path || path.includes('..')) continue;
    if (!/\.[A-Za-z0-9]+$/.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, content: body });
  }

  return files;
}

import type { AgentServerConfig } from '@/types';
import type { AgentModelRow } from '@/stores/agentSettings';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  steps: string[];
}

export interface ChatTurnResult {
  content: string;
  reasoning?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  model?: string;
}

/** 归一化上游 API 地址（对齐 agent/lib/api_client.php） */
export function normalizeApiBaseUrl(url: string): string {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/(chat\/completions|completions|models|embeddings)$/i, '');
  return u.replace(/\/+$/, '');
}

/** 候选 base（自动补 /v1） */
export function baseCandidates(base: string): string[] {
  const normalized = normalizeApiBaseUrl(base);
  if (!normalized) return [];
  const list = [normalized];
  if (!/\/v\d+$/i.test(normalized)) list.push(`${normalized}/v1`);
  return [...new Set(list)];
}

function upstreamHeaders(cfg: AgentServerConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    ...extra,
  };
  const key = cfg.apiKey?.trim();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

function fetchErrorHint(url: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return (
      `网络请求失败（Failed to fetch）。\n` +
      `· 检查 API 地址与 Key 是否正确\n` +
      `· 确认手机能访问该 API 域名\n` +
      `· 可先浏览器打开：${url}`
    );
  }
  return msg;
}

async function upstreamFetch(
  cfg: AgentServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const bases = baseCandidates(cfg.apiBaseUrl);
  if (!bases.length) throw new Error('请先填写 API 地址');
  if (!cfg.apiKey?.trim()) throw new Error('请先填写 API Key');

  const rel = path.replace(/^\/+/, '');
  let lastErr = '请求失败';

  for (const base of bases) {
    const url = `${base}/${rel}`;
    try {
      const res = await fetch(url, {
        ...init,
        headers: upstreamHeaders(cfg, (init.headers as Record<string, string>) || {}),
      });
      if (res.status === 404 && bases.length > 1) {
        lastErr = `HTTP 404 @ ${url}`;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = fetchErrorHint(url, e);
    }
  }
  throw new Error(lastErr);
}

function parseModelList(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const data = json as { data?: unknown[]; models?: unknown[] };
  const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const keys: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string' && row.trim()) {
      keys.push(row.trim());
      continue;
    }
    if (row && typeof row === 'object') {
      const id = (row as { id?: string }).id;
      if (id?.trim()) keys.push(id.trim());
    }
  }
  return [...new Set(keys)];
}

function toModelRows(keys: string[]): AgentModelRow[] {
  return keys.map((key, i) => ({ id: i + 1, model_key: key, name: key, is_enabled: 1 }));
}

/** 测试连接：GET /models */
export async function testAgentConnection(cfg: AgentServerConfig): Promise<ConnectionTestResult> {
  const steps: string[] = [];
  const base = normalizeApiBaseUrl(cfg.apiBaseUrl);
  if (!base) throw new Error('请填写 API 地址');
  if (!cfg.apiKey?.trim()) throw new Error('请填写 API Key');

  const session = { ...cfg, apiBaseUrl: base };
  steps.push(`✓ API 地址：${base}`);

  const res = await upstreamFetch(session, 'models');
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`上游返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string }; message?: string })?.error?.message
      || (json as { message?: string }).message
      || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}：${err}`);
  }

  const keys = parseModelList(json);
  steps.push(`✓ /models：${keys.length} 个模型`);
  if (keys.length) {
    const preview = keys.slice(0, 5).join('、');
    steps.push(`  示例：${preview}${keys.length > 5 ? '…' : ''}`);
  }

  return {
    ok: true,
    message: keys.length ? '连接正常，可以拉取模型并开始对话' : '连接成功，但未解析到模型列表',
    steps,
  };
}

/** 从上游拉取模型列表 */
export async function fetchModelsFromUpstream(cfg: AgentServerConfig): Promise<{
  models: AgentModelRow[];
  count: number;
  message: string;
  defaultModel?: string;
}> {
  const session = { ...cfg, apiBaseUrl: normalizeApiBaseUrl(cfg.apiBaseUrl) };
  const res = await upstreamFetch(session, 'models');
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const err = (json as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`;
    throw new Error(err);
  }
  const keys = parseModelList(json);
  if (!keys.length) throw new Error('上游未返回可用模型');
  const models = toModelRows(keys);
  const first = models[0];
  return {
    models,
    count: models.length,
    message: `已拉取 ${models.length} 个模型`,
    defaultModel: first?.model_key,
  };
}

/** 直连上游 API（生图/生视频等扩展路径） */
export async function upstreamRequest(
  cfg: AgentServerConfig,
  path: string,
  method: 'GET' | 'POST',
  payload: Record<string, unknown> = {},
  idempotency = '',
): Promise<unknown> {
  const session = { ...cfg, apiBaseUrl: normalizeApiBaseUrl(cfg.apiBaseUrl) };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (idempotency) headers['Idempotency-Key'] = idempotency;

  const res = await upstreamFetch(session, path.replace(/^\/+/, ''), {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`上游返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } })?.error?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}：${err}`);
  }
  return json;
}

async function parseOpenAiSse(
  resp: Response,
  onDelta: (content: string, reasoning: string) => void,
): Promise<ChatTurnResult> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('无法读取流式响应');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const callMap: Record<number, { id: string; name: string; arguments: string }> = {};

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
          };
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onDelta(content, reasoning);
          }
          if (delta?.reasoning_content) {
            reasoning += delta.reasoning_content;
            onDelta(content, reasoning);
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!callMap[idx]) callMap[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) callMap[idx].id = tc.id;
              if (tc.function?.name) callMap[idx].name += tc.function.name;
              if (tc.function?.arguments) callMap[idx].arguments += tc.function.arguments;
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  const tool_calls = Object.keys(callMap)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => ({
      id: callMap[Number(k)].id || `call_${k}`,
      function: { name: callMap[Number(k)].name, arguments: callMap[Number(k)].arguments || '{}' },
    }))
    .filter((tc) => tc.function.name);

  return {
    content,
    reasoning,
    tool_calls: tool_calls.length ? tool_calls : undefined,
  };
}

/** 流式单轮对话（直连 /chat/completions） */
export async function chatTurnStream(
  cfg: AgentServerConfig,
  messages: unknown[],
  tools: unknown[],
  opts: { model: string; max_tokens?: number; temperature?: number; tool_choice?: string },
  onDelta: (content: string, reasoning: string) => void,
): Promise<ChatTurnResult> {
  const session = { ...cfg, apiBaseUrl: normalizeApiBaseUrl(cfg.apiBaseUrl) };
  const payload = {
    model: opts.model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: opts.tool_choice,
    stream: true,
    max_tokens: opts.max_tokens ?? session.maxTokens ?? 8192,
    temperature: opts.temperature ?? session.temperature ?? 0.7,
  };

  const bases = baseCandidates(session.apiBaseUrl);
  let lastErr = '流式请求失败';
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          ...upstreamHeaders(session, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        },
        body: JSON.stringify(payload),
      });
      const ct = (res.headers.get('Content-Type') || '').toLowerCase();
      if (res.ok && ct.includes('text/event-stream')) {
        return parseOpenAiSse(res, onDelta);
      }
      if (res.status === 404) continue;
      const text = await res.text();
      lastErr = `HTTP ${res.status}：${text.slice(0, 200)}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  try {
    return await chatTurn(session, messages, tools, opts);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${lastErr}；非流式回退也失败：${detail}`);
  }
}

/** 非流式单轮对话 */
export async function chatTurn(
  cfg: AgentServerConfig,
  messages: unknown[],
  tools: unknown[],
  opts: { model: string; max_tokens?: number; temperature?: number; tool_choice?: string },
): Promise<ChatTurnResult> {
  const session = { ...cfg, apiBaseUrl: normalizeApiBaseUrl(cfg.apiBaseUrl) };
  const payload = {
    model: opts.model,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: opts.tool_choice,
    stream: false,
    max_tokens: opts.max_tokens ?? session.maxTokens ?? 8192,
    temperature: opts.temperature ?? session.temperature ?? 0.7,
  };

  const res = await upstreamFetch(session, 'chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    model?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  const msg = data?.choices?.[0]?.message;
  return {
    content: msg?.content || '',
    reasoning: (msg as { reasoning_content?: string })?.reasoning_content,
    tool_calls: msg?.tool_calls,
    model: data?.model,
  };
}

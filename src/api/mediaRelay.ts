import { upstreamRequest } from '@/api/agentServer';
import type { AgentServerConfig } from '@/types';

export type SlashCommandName = 'img' | 'img-async' | 'video' | 'video-quote';

export interface SlashCommand {
  name: SlashCommandName;
  arg: string;
}

function newIdempotency(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseSlashCommand(text: string): SlashCommand | null {
  const m = /^\/(img|image|img-async|video|video-quote)\s+([\s\S]+)$/i.exec(text.trim());
  if (!m) return null;
  let name = m[1].toLowerCase();
  if (name === 'image') name = 'img';
  return { name: name as SlashCommandName, arg: m[2].trim() };
}

export function parseVideoSeconds(text: string, fallback = 4): number {
  const m = /(\d+)\s*(?:秒|s\b)/i.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 60) return n;
  }
  return fallback;
}

interface TaskLike {
  status?: string;
  error_message?: string;
  error?: string;
}

async function relayPoll<T extends TaskLike>(
  query: () => Promise<T>,
  opts: {
    interval?: number;
    timeout?: number;
    onTick?: (t: T) => void;
  } = {},
): Promise<T> {
  const interval = opts.interval ?? 3000;
  const deadline = Date.now() + (opts.timeout ?? 600_000);
  const isDone = (t: T) =>
    t.status === 'completed' || t.status === 'done' || t.status === 'succeeded';
  const isError = (t: T) => t.status === 'failed' || t.status === 'error';

  while (Date.now() < deadline) {
    const t = await query();
    opts.onTick?.(t);
    if (isError(t)) {
      throw new Error(t.error_message || t.error || '任务失败');
    }
    if (isDone(t)) return t;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('任务超时，请稍后重试');
}

function imageBlock(resp: { data?: Array<{ url?: string; b64_json?: string }>; usage?: { charged_amount?: number; currency?: string } }): string {
  const list = resp?.data || [];
  const lines: string[] = [];

  list.forEach((item, i) => {
    if (item.url) {
      lines.push(`![图片${i + 1}](${item.url})`);
      lines.push(`原图地址：${item.url}`);
    } else if (item.b64_json) {
      lines.push(`![图片${i + 1}](data:image/png;base64,${item.b64_json})`);
    }
  });

  if (!lines.length) return '生成完成，但没有返回图片数据';

  const u = resp?.usage;
  if (u?.charged_amount) {
    lines.push(`计费：${u.charged_amount} ${u.currency || 'CNY'}`);
  }
  return lines.join('\n\n');
}

/** 执行 /img /img-async /video /video-quote 斜杠命令 */
export async function runSlashCommand(
  cfg: AgentServerConfig,
  cmd: SlashCommand,
  model: string,
  onStatus: (status: string) => void,
): Promise<string> {
  const m = model || cfg.model || '';
  if (!m) {
    throw new Error('请先在项目里配置默认模型（生图/视频需 image 或 video 能力模型）');
  }

  const videoSeconds = parseVideoSeconds(cmd.arg, 4);

  if (cmd.name === 'video-quote') {
    onStatus('正在查询视频报价…');
    const q = (await upstreamRequest(cfg, 'videos/quote', 'POST', {
      model: m,
      seconds: videoSeconds,
      extra_parameters: { resolution: '480P' },
    })) as {
      total?: number;
      source?: string;
      quota_type?: string;
      label?: string;
      remaining?: number;
      billing_mode?: string;
      seconds?: number;
      affordable?: boolean;
    };
    return (
      `**视频报价**\n\n` +
      `- 金额：${q.total ?? '?'} ${q.source === 'package' ? q.quota_type || '额度' : 'CNY'}\n` +
      `- 来源：${q.label || q.source || ''}\n` +
      `- 剩余：${q.remaining === -1 ? '不限' : q.remaining ?? '?'}\n` +
      `- 计费方式：${q.billing_mode || ''}（${q.seconds ?? videoSeconds} 秒）\n` +
      `- 当前是否够付：${q.affordable ? '是' : '否'}`
    );
  }

  if (cmd.name === 'video') {
    onStatus(`正在创建视频任务（${videoSeconds} 秒）…`);
    const created = (await upstreamRequest(
      cfg,
      'videos/generations',
      'POST',
      {
        model: m,
        prompt: cmd.arg,
        seconds: videoSeconds,
        watermark: false,
        extra_parameters: { resolution: '480P', aspect_ratio: '16:9', enable_audio: false },
      },
      newIdempotency('video'),
    )) as { id?: string; status?: string };

    const vid = created.id || '';
    if (!vid) throw new Error('创建成功但没有返回任务 id');

    onStatus(`视频任务已提交（${created.status || 'queued'}）…`);
    const task = await relayPoll(
      () => upstreamRequest(cfg, `videos/tasks/${encodeURIComponent(vid)}`, 'GET') as Promise<TaskLike & { result?: { url?: string } }>,
      {
        interval: 6000,
        timeout: 600_000,
        onTick: (t) => onStatus(`视频任务：${t.status || '处理中'}…`),
      },
    );

    const vurl = task.result?.url || '';
    return vurl ? `**视频已生成**\n\n${vurl}` : '任务已完成，但没有返回可下载的视频地址';
  }

  if (cmd.name === 'img-async') {
    onStatus('正在创建生图任务…');
    const job = (await upstreamRequest(
      cfg,
      'images/generations/async',
      'POST',
      {
        model: m,
        prompt: cmd.arg,
        n: 1,
        size: '1024x1024',
        response_format: 'url',
      },
      newIdempotency('async-image'),
    )) as { id?: string; task_id?: string };

    const jid = job.id || job.task_id || '';
    if (!jid) throw new Error('创建成功但没有返回任务 id');

    const done = (await relayPoll(
      () =>
        upstreamRequest(cfg, `images/tasks/${encodeURIComponent(jid)}`, 'GET') as Promise<
          TaskLike & { data?: unknown; result?: unknown }
        >,
      {
        interval: 3000,
        timeout: 300_000,
        onTick: (t) => onStatus(`生图任务：${t.status || '处理中'}…`),
      },
    )) as { data?: { data?: Array<{ url?: string; b64_json?: string }> }; result?: { data?: Array<{ url?: string; b64_json?: string }> } };

    const payload = (done.data || done.result || done) as {
      data?: Array<{ url?: string; b64_json?: string }>;
      usage?: { charged_amount?: number; currency?: string };
    };
    return imageBlock(payload);
  }

  onStatus('正在生成图片…');
  const resp = (await upstreamRequest(
    cfg,
    'images/generations',
    'POST',
    {
      model: m,
      prompt: cmd.arg,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    },
    newIdempotency('image'),
  )) as { data?: Array<{ url?: string; b64_json?: string }>; usage?: { charged_amount?: number; currency?: string } };

  return imageBlock(resp);
}

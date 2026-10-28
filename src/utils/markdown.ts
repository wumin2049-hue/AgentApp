/**
 * 轻量 Markdown 渲染（零依赖，对齐 agent/assets/js/markdown.js）
 * 标题 / 列表 / 引用 / 表格 / 代码块 / 行内代码 / 粗斜体 / 链接 / 图片 / 分隔线 / 任务列表
 */

const KEYWORDS: Record<string, string[]> = {
  js: (
    'break case catch class const continue debugger default delete do else export extends finally for function ' +
    'if import in instanceof let new return super switch this throw try typeof var void while with yield async await ' +
    'of static get set from as null true false undefined NaN'
  ).split(' '),
  ts: (
    'break case catch class const continue declare default delete do else enum export extends finally for function ' +
    'if implements import in instanceof interface let new private protected public readonly return static super switch ' +
    'this throw try type typeof var void while with yield async await of as null true false undefined'
  ).split(' '),
  php: (
    'abstract and array as break callable case catch class clone const continue declare default die do echo else ' +
    'elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach ' +
    'function global goto if implements include include_once instanceof insteadof interface isset list match namespace ' +
    'new or print private protected public readonly require require_once return static switch throw trait try unset ' +
    'use var while xor yield true false null'
  ).split(' '),
  py: (
    'and as assert async await break class continue def del elif else except finally for from global if import in is ' +
    'lambda nonlocal not or pass raise return try while with yield match case True False None self'
  ).split(' '),
  sql: (
    'select from where insert into values update set delete create table drop alter add index primary key foreign ' +
    'references join left right inner outer on group by order having limit offset union all distinct as and or not ' +
    'null is like in between exists case when then else end default unique auto_increment engine charset if exists ' +
    'show describe explain count sum avg min max'
  ).split(' '),
  bash: (
    'if then else elif fi for while do done case esac function return in local export readonly declare echo cd ' +
    'exit source alias unset set shift eval exec sudo apt yum brew npm pnpm yarn php composer git curl'
  ).split(' '),
  go: (
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package ' +
    'range return select struct switch type var nil true false'
  ).split(' '),
  java: (
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends ' +
    'final finally float for goto if implements import instanceof int interface long native new package private ' +
    'protected public return short static strictfp super switch synchronized this throw throws transient try void ' +
    'volatile while var record true false null'
  ).split(' '),
  c: (
    'auto break case char const continue default do double else enum extern float for goto if inline int long ' +
    'register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while ' +
    'class public private protected virtual namespace template typename using new delete include true false nullptr'
  ).split(' '),
  css: (
    'important media supports keyframes import from to and not only initial inherit unset var calc rgb rgba hsl ' +
    'display position flex grid color background border margin padding font'
  ).split(' '),
};

const LANE: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'ts',
  php: 'php', php3: 'php', php5: 'php', phtml: 'php',
  py: 'py', python: 'py', python3: 'py',
  sql: 'sql', mysql: 'sql', pgsql: 'sql', sqlite: 'sql',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash',
  go: 'go', golang: 'go',
  java: 'java', kotlin: 'java', kt: 'java', csharp: 'java', cs: 'java',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', objc: 'c', swift: 'c', rust: 'c', rs: 'c',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
};

const COMMENT: Record<string, string> = {
  js: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*',
  ts: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*',
  php: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*',
  py: '#[^\\n]*',
  sql: '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/',
  bash: '#[^\\n]*',
  go: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*',
  java: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*',
  c: '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*',
  css: '\\/\\*[\\s\\S]*?\\*\\/',
};

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMarkup(code: string): string {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([a-zA-Z][\w:.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?>)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    if (m[1]) {
      out += `<span class="tok-com">${escapeHtml(m[1])}</span>`;
    } else {
      const attrs = String(m[4] || '').replace(
        /([\w:.-]+)(=)("[^"]*"|'[^']*')?/g,
        (_all, name: string, eq: string, val?: string) =>
          `<span class="tok-attr">${escapeHtml(name)}</span>${eq}${
            val ? `<span class="tok-str">${escapeHtml(val)}</span>` : ''
          }`,
      );
      out += `${escapeHtml(m[2])}<span class="tok-tag">${escapeHtml(m[3])}</span>${attrs}${escapeHtml(m[5])}`;
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlight(code: string, lang: string): string {
  const key = String(lang || '').toLowerCase();
  if (key === 'html' || key === 'xml' || key === 'svg' || key === 'vue' || key === 'htm') {
    return highlightMarkup(code);
  }
  const lane = LANE[key] || (KEYWORDS[key] ? key : '');
  if (!lane) return escapeHtml(code);

  const kw = KEYWORDS[lane] || [];
  const kwPart = kw.length ? `(${kw.join('|')})` : '(?!)';
  const comPart = COMMENT[lane] || '(?!)';
  const re = new RegExp(
    `(${comPart})` +
      `|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)` +
      `|\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?)\\b` +
      `|\\b${kwPart}\\b` +
      `|\\b([A-Za-z_]\\w*)\\s*(?=\\()` +
      `|(\\$[A-Za-z_]\\w*)`,
    'g',
  );

  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    const cls = m[1]
      ? 'tok-com'
      : m[2]
        ? 'tok-str'
        : m[3]
          ? 'tok-num'
          : m[4]
            ? 'tok-kw'
            : m[5]
              ? 'tok-fn'
              : 'tok-var';
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function safeUrl(url: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return u;
  if (/^(\/|\.{1,2}\/|#)/.test(u)) return u;
  return '';
}

function inline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => {
    stash.push(html);
    return `\u0002${stash.length - 1}\u0002`;
  };

  let out = String(text);

  out = out.replace(/`([^`\n]+)`/g, (_a, code: string) => keep(`<code>${code}</code>`));

  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (all, alt: string, url: string, title?: string) => {
      const safe = safeUrl(url);
      if (!safe) return all;
      return keep(
        `<img src="${safe}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`,
      );
    },
  );

  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_all, label: string, url: string, title?: string) => {
      const safe = safeUrl(url);
      if (!safe) return label;
      return keep(
        `<a href="${safe}" target="_blank" rel="noopener noreferrer"${
          title ? ` title="${title}"` : ''
        }>${label}</a>`,
      );
    },
  );

  out = out.replace(/(^|[\s(（])(https?:\/\/[^\s<>"'\u0002]+)/g, (_a, pre: string, url: string) =>
    pre + keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`),
  );

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/\n/g, '<br>');

  out = out.replace(/\u0002(\d+)\u0002/g, (_a, idx: string) => stash[Number(idx)] || '');
  return out;
}

function buildCodeBlock(code: string, lang: string): string {
  const label = (lang || 'text').replace(/[<>&"]/g, '');
  return (
    `<div class="code-block">` +
    `<div class="code-head">` +
    `<span class="code-lang">${escapeHtml(label)}</span>` +
    `<button type="button" class="code-copy" data-act="copy-code">复制</button>` +
    `</div>` +
    `<pre><code>${highlight(code, lang)}</code></pre>` +
    `</div>`
  );
}

let CODE_BLOCKS: string[] = [];

function extractFences(text: string): string {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let code: string[] = [];
  let lang = '';
  let inCode = false;
  let fenceChar = '';

  for (const line of lines) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w#+.\-]*)\s*$/);
    if (!inCode && m) {
      inCode = true;
      fenceChar = m[1].charAt(0);
      lang = m[2] || '';
      code = [];
      continue;
    }
    if (inCode && m && m[1].charAt(0) === fenceChar) {
      CODE_BLOCKS.push(buildCodeBlock(code.join('\n'), lang));
      out.push(`\u0001B${CODE_BLOCKS.length - 1}\u0001`);
      inCode = false;
      lang = '';
      continue;
    }
    if (inCode) code.push(line);
    else out.push(line);
  }
  if (inCode) {
    CODE_BLOCKS.push(buildCodeBlock(code.join('\n'), lang));
    out.push(`\u0001B${CODE_BLOCKS.length - 1}\u0001`);
  }
  return out.join('\n');
}

const RE_FENCE_TOKEN = /^\u0001B(\d+)\u0001$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])\s*(\1\s*){2,}$/;
const RE_QUOTE = /^\s{0,3}&gt;\s?/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function isBlockStart(line: string): boolean {
  return (
    RE_FENCE_TOKEN.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_LIST.test(line) ||
    /^\s*\|/.test(line)
  );
}

function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => c.trim());
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start]);
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  let html = '<table><thead><tr>';
  for (const c of header) html += `<th>${inline(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (const r of rows) {
    html += '<tr>';
    for (let c = 0; c < header.length; c++) html += `<td>${inline(r[c] || '')}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  return { html, next: i };
}

type ListNode = { type: 'list'; ordered: boolean; items: ItemNode[] };
type ItemNode = { type: 'item'; text: string; children: ListNode[] };
type RootNode = { children: ListNode[] };

function renderList(lines: string[], start: number): { html: string; next: number } {
  const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
  let i = start;
  const reList = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(reList);
    if (m) {
      items.push({
        indent: m[1].replace(/\t/g, '    ').length,
        ordered: /^\d/.test(m[2]),
        text: m[3],
      });
      i++;
      continue;
    }
    if (line.trim() && /^\s{2,}/.test(line) && items.length && !isBlockStart(line.trim())) {
      items[items.length - 1].text += `\n${line.trim()}`;
      i++;
      continue;
    }
    break;
  }

  const root: RootNode = { children: [] };
  const stack: Array<{ node: RootNode | ItemNode; indent: number }> = [{ node: root, indent: -1 }];

  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node as RootNode | ItemNode;
    const children = parent.children;
    let list = children[children.length - 1];
    if (!list || list.type !== 'list' || list.ordered !== it.ordered) {
      list = { type: 'list', ordered: it.ordered, items: [] };
      children.push(list);
    }
    const li: ItemNode = { type: 'item', text: it.text, children: [] };
    list.items.push(li);
    stack.push({ node: li, indent: it.indent });
  }

  function renderNode(node: ListNode): string {
    const tag = node.ordered ? 'ol' : 'ul';
    const body = node.items
      .map((li) => {
        let inner = inline(li.text);
        const kids = li.children.map(renderNode).join('');
        if (!node.ordered && /^\[[ xX]\]\s/.test(li.text)) {
          const checked = /^\[[xX]\]/.test(li.text);
          inner =
            `<input type="checkbox" disabled${checked ? ' checked' : ''}>` +
            inner.replace(/^\[[ xX]\]\s*/, '');
          return `<li class="task-item">${inner}${kids}</li>`;
        }
        return `<li>${inner}${kids}</li>`;
      })
      .join('');
    return `<${tag}>${body}</${tag}>`;
  }

  return { html: root.children.map(renderNode).join(''), next: i };
}

function renderBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fm = line.match(RE_FENCE_TOKEN);
    if (fm) {
      out.push(CODE_BLOCKS[Number(fm[1])] || '');
      i++;
      continue;
    }

    const hm = line.match(RE_HEADING);
    if (hm) {
      const level = hm[1].length;
      out.push(`<h${level}>${inline(hm[2])}</h${level}>`);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        quote.push(lines[i].replace(RE_QUOTE, ''));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      RE_TABLE_SEP.test(lines[i + 1])
    ) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (RE_LIST.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }

  return out.join('');
}

/** 将 Markdown 转为安全 HTML（先转义再解析） */
export function renderMarkdown(text: string): string {
  CODE_BLOCKS = [];
  const src = String(text ?? '');
  if (!src.trim()) return '';
  const withTokens = extractFences(src);
  const escaped = escapeHtml(withTokens);
  return renderBlocks(escaped);
}

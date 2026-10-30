const PLACEHOLDER = "\u0000";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(raw) {
  const url = String(raw).trim().replace(/^<|>$/g, "");
  const probe = url.toLowerCase().replace(/&amp;/g, "&");
  if (/^(https?:\/\/|mailto:|#)/.test(probe)) return url;
  if (/^(\.{0,2}\/|\/)/.test(probe)) return url;
  return "#";
}

function emphasis(text) {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,!?;:])/g, "$1<em>$2</em>");
}

function inline(raw) {
  let text = escapeHtml(String(raw).replace(/\u0000/g, ""));
  const stash = [];
  const hold = (html) => {
    const key = `${PLACEHOLDER}${stash.length}${PLACEHOLDER}`;
    stash.push(html);
    return key;
  };

  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${code}</code>`));

  text = text.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_, alt, url) => {
    const href = safeUrl(url);
    return hold(`<a href="${href}" target="_blank" rel="noreferrer noopener">${alt || href}</a>`);
  });

  text = text.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_, label, url) => {
    const href = safeUrl(url);
    return hold(`<a href="${href}" target="_blank" rel="noreferrer noopener">${emphasis(label)}</a>`);
  });

  text = emphasis(text);

  text = text.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?'")\]}]+/g, (url) =>
    `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`
  );

  text = text.replace(/\n/g, "<br>");

  return text.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"), (_, index) => stash[Number(index)]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^\s*>/.test(line) || LIST.test(line);
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : "";
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && /\S/.test(lines[i]) && lines[i].includes("|")) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }
  const cells = (row, tag) =>
    header
      .map((_, index) => {
        const style = aligns[index] ? ` style="text-align:${aligns[index]}"` : "";
        return `<${tag}${style}>${inline(row[index] ?? "")}</${tag}>`;
      })
      .join("");
  const head = `<thead><tr>${cells(header, "th")}</tr></thead>`;
  const body = rows.length ? `<tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody>` : "";
  return { html: `<div class="table-wrap"><table>${head}${body}</table></div>`, next: i };
}

function parseList(lines, start) {
  const first = lines[start].match(LIST);
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(LIST);
    if (!match || match[1].length !== baseIndent || /^\d/.test(match[2]) !== ordered) break;

    let content = match[3];
    let nested = "";
    i += 1;

    while (i < lines.length) {
      if (!/\S/.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/\S/.test(lines[j])) j += 1;
        const nextItem = j < lines.length ? lines[j].match(LIST) : null;
        if (nextItem && nextItem[1].length === baseIndent) {
          i = j;
          break;
        }
        if (j < lines.length && /^\s{2,}/.test(lines[j])) {
          i = j;
          continue;
        }
        break;
      }

      const next = lines[i].match(LIST);
      if (next && next[1].length === baseIndent) break;
      if (next && next[1].length > baseIndent) {
        const sub = parseList(lines, i);
        nested += sub.html;
        i = sub.next;
        continue;
      }
      if (/^\s{2,}/.test(lines[i])) {
        content += `\n${lines[i].trim()}`;
        i += 1;
        continue;
      }
      break;
    }

    items.push(`<li>${inline(content)}${nested}</li>`);
  }

  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

function parseBlocks(source) {
  const lines = String(source).replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!/\S/.test(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const min = fence[1].length;
      const lang = (fence[2] || "").toLowerCase();
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = lines[i].match(FENCE);
        if (close && close[1][0] === marker && close[1].length >= min && !close[2]) {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      out.push(codeBlock(body.join("\n"), lang));
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${parseBlocks(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const table = parseTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (LIST.test(line)) {
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (i < lines.length && /\S/.test(lines[i]) && !isBlockStart(lines[i])) {
      if (lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break;
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(paragraph.join("\n"))}</p>`);
  }

  return out.join("\n");
}

const HASH_COMMENT_LANGS = new Set(["python", "py", "sh", "bash", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb", "perl", "r", "makefile", "dockerfile", "conf", "ini"]);

const KEYWORDS = [
  "const", "let", "var", "function", "return", "if", "else", "elif", "for", "while", "do",
  "class", "extends", "implements", "new", "import", "from", "export", "default", "await", "async",
  "def", "lambda", "try", "except", "catch", "finally", "throw", "raise", "switch", "case", "break",
  "continue", "in", "of", "not", "and", "or", "is", "None", "True", "False", "null", "true", "false",
  "undefined", "this", "self", "super", "public", "private", "protected", "static", "final", "void",
  "int", "float", "double", "char", "bool", "boolean", "string", "struct", "enum", "interface", "type",
  "package", "func", "go", "defer", "range", "match", "with", "as", "yield", "pass", "print", "echo",
  "impl", "fn", "mut", "use", "mod", "pub", "trait", "where", "loop", "unsafe", "extern",
];

function highlight(code, lang) {
  const hashComments = HASH_COMMENT_LANGS.has(lang);
  const comment = hashComments
    ? String.raw`#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*`
    : String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`;
  const pattern = new RegExp(
    `(${comment})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?)\\b|\\b(${KEYWORDS.join("|")})\\b|\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()`,
    "g"
  );

  let out = "";
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    out += escapeHtml(code.slice(last, match.index));
    const [token, isComment, isString, isNumber, isKeyword, isFunction] = match;
    const cls = isComment ? "tok-com" : isString ? "tok-str" : isNumber ? "tok-num" : isKeyword ? "tok-kw" : isFunction ? "tok-fn" : "";
    out += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
    last = match.index + token.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function codeBlock(code, lang) {
  const label = lang || "text";
  const body = lang && lang !== "text" && lang !== "plain" && lang !== "plaintext" ? highlight(code, lang) : escapeHtml(code);
  return `<div class="code-block" data-code="${escapeHtml(code)}"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy-code><svg class="icon"><use href="#i-copy"/></svg><span>Copy</span></button></div><pre><code>${body}</code></pre></div>`;
}

export function renderMarkdown(source) {
  if (!source) return "";
  return parseBlocks(source);
}

export function plainText(source) {
  return String(source || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function snippet(source, length = 90) {
  const text = plainText(source).replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

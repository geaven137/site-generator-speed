// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Written from the behavior specification (the reference program's README and its
// observable behavior): same front matter, template dialect, Markdown subset, slug
// rule and report, byte for byte. The implementation below is original work:
// a fused Markdown lexer/renderer with a single-pass inline scanner, a template
// engine that compiles templates to closure trees over a flat mutable scope, and
// a pipeline that avoids re-reading and re-allocating wherever the spec allows.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---------------------------------------------------------------- text rules

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let i = 0;
  let m;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(i, m.index);
    out += ENT[m[0]];
    i = m.index + 1;
  }
  return i === 0 ? text : out + text.slice(i);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let k = -1;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (k === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += k === c ? plain[i] : String.fromCharCode(k);
  }
  // At most one "-" can trail (runs collapse to one), and only the 64-cut can
  // leave one behind.
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whitespace by UTF-16 code unit (JS \s): 9-13, 32, 0xA0, 0x1680, 0x2000-0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF. */
const WS = new Uint8Array(0x10000);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

/** The words of a body: its runs of characters other than whitespace (JS \s). */
function countWords(s) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    if (WS[s.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** A line with spaces and tabs at either end dropped. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // The closing line is the first line exactly "---" after line 0.
  let closeAt = -1;
  let bodyStart = -1;
  const hit = text.indexOf('\n---\n', nl0);
  if (hit !== -1) {
    closeAt = hit + 1;
    bodyStart = hit + 5;
  } else if (text.endsWith('\n---') && text.length - 4 >= nl0) {
    closeAt = text.length - 3;
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const data = {};
  const region = text.slice(nl0 + 1, closeAt - 1);
  const lines = region === '' ? [] : region.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;
const CONTINUED_RE = /^ {2,}\S/;

/** Whether `line` holds spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c === 0 || c > 6 || c >= line.length) return null;
  const sc = line.charCodeAt(c);
  if (sc !== 32 && sc !== 9) return null;
  let e = line.length;
  while (e > c && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  let s = c;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  if (s >= e) return null;
  return { depth: c, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list line's number and item text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1. A match is escaped exactly when an odd run of backslashes stands right
 * before it: backslashes pair up left to right, so an odd run leaves one to
 * escape the match's first character (which is escapable in every use here).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    let p = j - 1;
    while (p >= 0 && s.charCodeAt(p) === 92) {
      b++;
      p--;
    }
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    let p = j - 1;
    while (p >= 0 && s.charCodeAt(p) === 92) {
      b++;
      p--;
    }
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. One regex scan finds the
 * next interesting character; the plain text between needs no escaping, so it is
 * copied in bulk instead of character by character. The scanner regex is shared:
 * every call starts it at 0, and every branch resets it after any recursion.
 */
const INLINE_RE = /[\\`*\[&<>"']/g;

function renderInline(s, link) {
  const re = INLINE_RE;
  re.lastIndex = 0;
  let out = '';
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 38) {
      out += s.slice(i, j);
      out += '&amp;';
      i = j + 1;
      continue;
    }
    if (c === 60) {
      out += s.slice(i, j);
      out += '&lt;';
      i = j + 1;
      continue;
    }
    if (c === 62) {
      out += s.slice(i, j);
      out += '&gt;';
      i = j + 1;
      continue;
    }
    if (c === 34) {
      out += s.slice(i, j);
      out += '&quot;';
      i = j + 1;
      continue;
    }
    if (c === 39) {
      out += s.slice(i, j);
      out += '&#39;';
      i = j + 1;
      continue;
    }
    if (c === 92) {
      // Backslash: escapes one of the escapable characters, else itself.
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += s.slice(i, j);
        out += nx;
        i = j + 2;
      } else {
        out += s.slice(i, j);
        out += '\\';
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (c === 96) {
      // Code span: the next backtick closes it, with at least one character between.
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(i, j);
        out += '<code>';
        out += esc(s.slice(j + 1, k));
        out += '</code>';
        i = k + 1;
      } else {
        out += s.slice(i, j);
        out += '`';
        i = j + 1;
      }
      re.lastIndex = i;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += s.slice(i, j);
          out += '<strong>';
          out += renderInline(s.slice(j + 2, k), link);
          out += '</strong>';
          i = k + 2;
        } else {
          out += s.slice(i, j);
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += s.slice(i, j);
          out += '<em>';
          out += renderInline(s.slice(j + 1, k), link);
          out += '</em>';
          i = k + 1;
        } else {
          out += s.slice(i, j);
          out += '*';
          i = j + 1;
        }
      }
      re.lastIndex = i;
      continue;
    }
    // '[': a link when a ']' closes the text, '(' follows at once and the next
    // ')' closes a target that is not empty and holds no whitespace.
    const k = findUnescaped(s, ']', j + 1);
    const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    if (target !== '' && !WS_RE.test(target)) {
      out += s.slice(i, j);
      out += '<a href="';
      out += esc(link(target));
      out += '">';
      out += renderInline(s.slice(j + 1, k), link);
      out += '</a>';
      i = q + 1;
    } else {
      out += s.slice(i, j);
      out += '[';
      i = j + 1;
    }
    re.lastIndex = i;
  }
  return out + s.slice(i);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Lexing and rendering run in one pass over the
 * lines, so no block tokens are ever built.
 */
function renderBody(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '' || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // A non-blank line opening on space or tab is a paragraph line.
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        let code = '';
        i++;
        while (i < n && !isFenceClose(lines[i])) {
          code += esc(lines[i]);
          code += '\n';
          i++;
        }
        i++;
        const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
        html += `<pre><code${cls}>${code}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const htm = renderInline(h.text, link);
        html += `<h${h.depth} id="${id}">${htm}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: htm });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          if ((d0 === 45 || d0 === 42) && l.charCodeAt(1) === 32) {
            items.push(trimST(l.slice(2)));
            i++;
          } else if (CONTINUED_RE.test(l)) {
            items[items.length - 1] += `\n${trimST(l)}`;
            i++;
          } else break;
        }
        let list = '<ul>\n';
        for (let k = 0; k < items.length; k++) list += `<li>${renderInline(items[k], link)}</li>\n`;
        html += `${list}</ul>\n`;
        continue;
      }
    } else if (c0 === 62) {
      let body = '';
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimST(l);
        if (l !== '') body = body === '' ? l : `${body}\n${l}`;
      }
      html += body === '' ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${renderInline(body, link)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [trimST(o.text)];
        const start = o.num;
        i++;
        while (i < n) {
          const p = orderedOf(lines[i]);
          if (p !== null) {
            items.push(trimST(p.text));
            i++;
          } else if (CONTINUED_RE.test(lines[i])) {
            items[items.length - 1] += `\n${trimST(lines[i])}`;
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let list = `${open}\n`;
        for (let k = 0; k < items.length; k++) list += `<li>${renderInline(items[k], link)}</li>\n`;
        html += `${list}</ol>\n`;
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break.
    let text = trimST(line);
    i++;
    while (i < n && !endsPara(lines[i])) text += `\n${trimST(lines[i++])}`;
    const htm = renderInline(text, link);
    if (excerpt === null) excerpt = htm;
    html += `<p>${htm}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function splitPath(tpl, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${tpl}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds spaces and tabs only. */
function spacesOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(tpl, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${tpl}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: splitPath(tpl, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${tpl}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spacesOnly(src, lineStart, open) && spacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(tpl, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(tpl, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: splitPath(tpl, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: splitPath(tpl, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${tpl}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${tpl}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.els ?? parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${tpl}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${tpl}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- compilation: each template becomes a closure tree over one flat scope (a
// Map). A loop binds its element and the shared loop state in the scope, saving
// and restoring whatever was there, so the innermost binding always wins and no
// scope object is allocated per iteration.

/** The one loop state object, its fields rewritten per iteration and restored after. */
const LOOP = { index: 0, first: false, last: false, length: 0 };

const NOOP = () => {};

/** An own property of `v`, or undefined when `v` is no object or lacks it. */
function propOf(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthyOf(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A path compiled to a reader: (S) => the value at the path in scope S. */
function compilePath(path, bound) {
  const first = path[0];
  const rest = path.slice(1);
  // A name bound by an enclosing loop of this template is always present in S
  // while the reference renders; any other name may or may not be there.
  const readFirst = bound.has(first)
    ? (S) => S.get(first)
    : (S) => (S.has(first) ? S.get(first) : undefined);
  if (rest.length === 0) return readFirst;
  return (S) => {
    let v = readFirst(S);
    for (let k = 0; k < rest.length; k++) {
      v = propOf(v, rest[k]);
      if (v === undefined) return undefined;
    }
    return v;
  };
}

function compileNodes(nodes, bound) {
  const fns = [];
  for (const node of nodes) fns.push(compileNode(node, bound));
  if (fns.length === 0) return NOOP;
  if (fns.length === 1) return fns[0];
  return (S, O, T, d) => {
    for (let k = 0; k < fns.length; k++) fns[k](S, O, T, d);
  };
}

function compileNode(node, bound) {
  switch (node.kind) {
    case 'text': {
      const t = node.text;
      return (S, O, T, d) => {
        O.push(t);
      };
    }
    case 'var': {
      const read = compilePath(node.path, bound);
      return (S, O, T, d) => {
        O.push(esc(textOf(read(S))));
      };
    }
    case 'raw': {
      const read = compilePath(node.path, bound);
      return (S, O, T, d) => {
        O.push(textOf(read(S)));
      };
    }
    case 'if': {
      const read = compilePath(node.path, bound);
      const thenFn = compileNodes(node.then, bound);
      const elseFn = node.els === null ? null : compileNodes(node.els, bound);
      const not = node.not;
      return (S, O, T, d) => {
        const b = truthyOf(read(S)) !== not ? thenFn : elseFn;
        if (b !== null) b(S, O, T, d);
      };
    }
    case 'for': {
      const read = compilePath(node.path, bound);
      const inner = new Set(bound);
      inner.add(node.name);
      inner.add('loop');
      const bodyFn = compileNodes(node.body, inner);
      const name = node.name;
      return (S, O, T, d) => {
        const xs = read(S);
        if (!Array.isArray(xs)) return;
        const hasX = name !== 'loop' && S.has(name);
        const oldX = hasX ? S.get(name) : undefined;
        const hasL = S.has('loop');
        const oldL = hasL ? S.get('loop') : undefined;
        S.set('loop', LOOP);
        // The loop state's fields only need saving when an outer loop is active:
        // otherwise nothing reads them again before the next loop rewrites them.
        const li = hasL ? LOOP.index : 0;
        const lf = hasL ? LOOP.first : false;
        const ll = hasL ? LOOP.last : false;
        const ln = hasL ? LOOP.length : 0;
        for (let k = 0; k < xs.length; k++) {
          if (name !== 'loop') S.set(name, xs[k]);
          LOOP.index = k + 1;
          LOOP.first = k === 0;
          LOOP.last = k === xs.length - 1;
          LOOP.length = xs.length;
          bodyFn(S, O, T, d);
        }
        if (hasL) {
          LOOP.index = li;
          LOOP.first = lf;
          LOOP.last = ll;
          LOOP.length = ln;
        }
        if (hasL) S.set('loop', oldL);
        else S.delete('loop');
        if (name !== 'loop') {
          if (hasX) S.set(name, oldX);
          else S.delete(name);
        }
      };
    }
    case 'include': {
      const name = node.name;
      return (S, O, T, d) => {
        if (d >= INCLUDE_DEPTH) return;
        const e = T.get(name);
        if (e === undefined) return;
        if (e.roots === null) {
          e.fn(S, O, T, d + 1);
          return;
        }
        // Memoized: the template's output is a pure function of its free roots'
        // values and the depth it renders at, so repeat renders reuse the text.
        const parts = [d + 1];
        for (let k = 0; k < e.roots.length; k++) {
          const r = e.roots[k];
          if (r === 'loop') {
            if (S.has('loop')) {
              const L = S.get('loop');
              parts.push(L.index, L.first, L.last, L.length);
            } else parts.push(ABSENT);
          } else parts.push(S.get(r));
        }
        let hit = memoGet(e.memo, parts);
        if (hit === undefined) {
          const O2 = [];
          e.fn(S, O2, T, d + 1);
          hit = O2.join('');
          memoSet(e.memo, parts, hit);
        }
        O.push(hit);
      };
    }
    default:
      return NOOP;
  }
}

// --- memoization: a template's free roots are the first segments of every path
// it reads, directly or through the templates it includes, except names bound by
// its own loops (their values derive from the iterated path, whose root is read).
// A template whose roots never name a per-render value (page, posts, pager, tag)
// renders the same text whenever its roots hold the same values at the same
// depth, so its renders are cached keyed by those values. Object values key by
// identity (rendering never mutates them); the loop state keys by its fields.

const ABSENT = Symbol('absent');
const PER_RENDER = new Set(['page', 'posts', 'pager', 'tag']);

function memoGet(table, parts) {
  let m = table;
  for (let i = 0; i < parts.length; i++) {
    m = m.get(parts[i]);
    if (m === undefined) return undefined;
  }
  return m;
}

function memoSet(table, parts, value) {
  let m = table;
  for (let i = 0; i < parts.length - 1; i++) {
    let next = m.get(parts[i]);
    if (next === undefined) {
      next = new Map();
      m.set(parts[i], next);
    }
    m = next;
  }
  m.set(parts[parts.length - 1], value);
}

function collectRoots(nodes, bound, roots, asts, visiting) {
  for (const node of nodes) {
    if (node.kind === 'var' || node.kind === 'raw' || node.kind === 'if') {
      if (!bound.has(node.path[0])) roots.add(node.path[0]);
      if (node.kind === 'if') {
        collectRoots(node.then, bound, roots, asts, visiting);
        if (node.els !== null) collectRoots(node.els, bound, roots, asts, visiting);
      }
    } else if (node.kind === 'for') {
      if (!bound.has(node.path[0])) roots.add(node.path[0]);
      const inner = new Set(bound);
      inner.add(node.name);
      inner.add('loop');
      collectRoots(node.body, inner, roots, asts, visiting);
    } else if (node.kind === 'include') {
      if (asts.has(node.name)) {
        for (const r of templateRoots(node.name, asts, visiting)) roots.add(r);
      }
    }
  }
}

/** A template's free roots, following includes (a cycle contributes each member's own roots once). */
function templateRoots(name, asts, visiting) {
  if (visiting.has(name)) return new Set();
  visiting.add(name);
  const roots = new Set();
  collectRoots(asts.get(name), new Set(), roots, asts, visiting);
  visiting.delete(name);
  return roots;
}

/** A template's memo key roots, or null when it reads a per-render value. */
function memoRoots(name, asts) {
  const roots = templateRoots(name, asts, new Set());
  for (const r of roots) if (PER_RENDER.has(r)) return null;
  return [...roots].sort(byCodeUnits);
}

// ---------------------------------------------------------------- the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A source's card, as lists show it (computed once, then kept on the source). */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  const asts = new Map();
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  for (const [name, nodes] of asts) {
    templates.set(name, {
      fn: compileNodes(nodes, new Set()),
      roots: memoRoots(name, asts),
      memo: new Map(),
    });
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; a .md file is a source, the rest static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const raw = f.content;
      sources.push({ path: f.path, text: raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw });
    } else statics.push(f);
  }

  // Front matter and the checks, in order: refused, the generator's own
  // directories, a post with no date, a layout that is no template, a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug unique in its directory, in source order.
  const bySource = new Map();
  const takenByDir = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order, ordered by count of posts and then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(names[k]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[k], slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = new Array(names.length);
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k]);
      s.tagRefs[k] = bySlug.get(slug) ?? { name: names[k], slug, url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, once per source.
  for (let i = 0; i < kept.length; i++) kept[i].card = cardOf(kept[i]);

  // Layouts: every page through its layout, the index pages, the tag pages.
  // One scope map and one output array serve every render: each render clears
  // them first, and loop bindings are always restored by the time a render ends.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const S = new Map();
  const O = [];
  const renderStart = () => {
    S.clear();
    S.set('site', site);
    S.set('tags', allTags);
    S.set('recent', recent);
  };
  const renderRun = (name) => {
    const e = templates.get(name);
    if (e === undefined) return null;
    O.length = 0;
    e.fn(S, O, templates, 0);
    return O.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    renderStart();
    S.set('page', pageOf(s));
    output[`${s.outDir}/index.html`] = renderRun(s.layout);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    renderStart();
    S.set('posts', posts.slice((k - 1) * per, k * per).map((p) => p.card));
    S.set('pager', {
      number: k,
      total: pages,
      url: indexUrl(k),
      newer_url: k === 1 ? '' : indexUrl(k - 1),
      older_url: k === pages ? '' : indexUrl(k + 1),
    });
    const html = renderRun('index');
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    renderStart();
    S.set('tag', { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) });
    const html = renderRun('tag');
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  renderStart();
  const tagsHtml = renderRun('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

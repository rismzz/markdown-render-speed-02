// parse.js — a fast, dependency-free Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with marked's default options
// (gfm: true, breaks: false, pedantic: false), for the
// markdown-render-speed-02 competition. Written from scratch:
// a line-based block parser feeding a delimiter-stack inline parser.
//
// No dependencies, no I/O: a pure function of its input string.

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isPunctCh(ch) {
  if (ch === '') return false;
  if (ch.length === 1 && ASCII_PUNCT.has(ch)) return true;
  return UNICODE_PUNCT.test(ch);
}

const UNICODE_SPACE = /[ \t\n\r\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;

function isSpaceCh(ch) {
  return ch === '' || UNICODE_SPACE.test(ch);
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Column arithmetic (a tab advances to the next multiple of 4)
// ---------------------------------------------------------------------------

// Leading-whitespace width of a line, in columns, and the index just past it.
function leadInfo(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col += 1; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, idx: i };
}

// Remove `want` columns of leading whitespace from a line. Whole
// characters that fit are consumed; when the cut lands on a character
// boundary (or removes nothing) the rest of the line survives untouched,
// tabs included. Only when a tab straddles the cut is the remainder of
// the whitespace run handed back as plain spaces, measured at the run's
// original columns so the surviving column count is preserved. `baseCol`
// is the column the string itself starts at (for a segment of a line).
function contentFrom(line, want, baseCol = 0) {
  if (want <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') {
      if (col + 1 <= want) { col++; i++; } else break;
    } else if (c === '\t') {
      const w = 4 - ((baseCol + col) % 4);
      if (col + w <= want) { col += w; i++; } else break;
    } else break;
  }
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t') || col >= want) {
    return line.slice(i);
  }
  // A tab straddles the cut: measure the rest of the run in columns.
  let remCols = 0;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') remCols += 1;
    else remCols += 4 - ((baseCol + col + remCols) % 4);
    j++;
  }
  return ' '.repeat(col + remCols - want) + line.slice(j);
}

// The blockquote strip: remove one column of leading whitespace from
// the segment after '>', with the whole leading run expanded to spaces
// measured at the segment's original columns (baseCol). Unlike
// contentFrom, a tab that survives the cut does not stay a tab: marked's
// quote handling hands the inner text the expanded remainder.
function quoteStrip(seg, baseCol) {
  let rc = 0;
  let j = 0;
  while (j < seg.length && (seg[j] === ' ' || seg[j] === '\t')) {
    if (seg[j] === ' ') rc += 1;
    else rc += 4 - ((baseCol + rc) % 4);
    j++;
  }
  if (j === 0) return seg;
  return ' '.repeat(Math.max(0, rc - 1)) + seg.slice(j);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeChar(ch) {
  return ESCAPES[ch] || ch;
}

// Decode a numeric character reference value the way the reference does:
// NUL, surrogates and values past U+10FFFF become U+FFFD.
function numericRefChar(value) {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '�';
  return String.fromCodePoint(value);
}

const NAMED_REF = /^&[A-Za-z][A-Za-z0-9]*;/;
const DEC_REF = /^&#([0-9]{1,7});/;
const HEX_REF = /^&#[xX]([0-9A-Fa-f]{1,6});/;

// Escape a run of plain text for HTML output. Named character references
// (&copy;, &MadeUpEntity;) pass through untouched; numeric references are
// decoded to the character they name (which is then itself escaped when it
// is one of the five escaped characters); any other & becomes &amp;.
function escapeTextRun(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const rest = s.slice(i, i + 64);
      let m = DEC_REF.exec(rest);
      if (m) { out += escapeChar(numericRefChar(parseInt(m[1], 10))); i += m[0].length; continue; }
      m = HEX_REF.exec(rest);
      if (m) { out += escapeChar(numericRefChar(parseInt(m[1], 16))); i += m[0].length; continue; }
      m = NAMED_REF.exec(rest);
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '"' || c === "'") { out += ESCAPES[c]; i++; continue; }
    // Bulk-copy the ordinary stretch.
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Escape code content: every special character is escaped, nothing passes.
function escapeCode(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape an attribute value (href, title, alt): named and numeric character
// references pass through as written; a bare & is escaped.
function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const rest = s.slice(i, i + 64);
      const m = /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/.exec(rest);
      if (m) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '"' || c === "'") { out += ESCAPES[c]; i++; continue; }
    let j = i + 1;
    while (j < n) {
      const d = s[j];
      if (d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------

// The reference's URL cleaning: percent-encode what encodeURI encodes,
// without double-encoding a % that was already there.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// Reference labels compare case-insensitively with whitespace collapsed.
function normalizeLabel(label) {
  // Case-insensitive label matching with Unicode case folding; the sharp s
  // folds to "ss", which plain lowercasing would miss.
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Resolve backslash escapes of ASCII punctuation; other backslashes stay.
function unescapeStr(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// A faithful re-implementation of the reference renderer's inline lexer
// (marked 18.1.3, default options: gfm on, breaks off, pedantic off): the
// same masking pass over the source, the same tokenizer order, and the
// same emStrong/del right-delimiter scans, so the HTML agrees byte for
// byte, including the reference's departures from CommonMark.
// ---------------------------------------------------------------------------

const INL_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INL_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const INL_LINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;
const INL_REFLINK = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/;
const INL_NOLINK = /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/;
const INL_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const INL_EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const INL_EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const INL_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INL_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INL_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const INL_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const INL_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const INL_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const INL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const INL_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;
const INL_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const INL_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const INL_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const INL_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const INL_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;

// The reference's HTML escaping: with encode set, every &<>"' is escaped;
// without it, an & that already begins a character reference stays.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NOENC = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(s, encode) {
  if (encode) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (ch) => ESC_MAP[ch]) : s;
  }
  return ESC_TEST_NOENC.test(s) ? s.replace(ESC_REPLACE_NOENC, (ch) => ESC_MAP[ch]) : s;
}

const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Resolve numeric character references in a text run, the reference way:
// an out-of-range or surrogate value becomes U+FFFD, &#38; becomes &amp;,
// and a bare & that starts no reference becomes &amp; as well.
function resolveEntities(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return '�';
    if (v === 38) return '&amp;';
    return String.fromCodePoint(v);
  });
}

// The reference's href cleaning: encodeURI, undoing %25 double-encoding;
// a href encodeURI rejects makes the link render as plain text.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Link labels compare after trim, whitespace collapse and a
// lowercase-uppercase-lowercase fold.
function foldLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Inline lexer state shared by every inline run of one document (the
// reference keeps it for the whole document too): whether we are inside
// an <a> element or a raw <pre>/<code>/<kbd>/<script> element, whether a
// link was emitted inside the current link text, and the flag that lets
// the link tokenizer skip strings with no closing paren.
let inlState = null;
function freshInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
}

// The last index at which an emphasis or strikethrough closer can start
// in a masked string: the start of the last run of the character that is
// not preceded by a blank character.
function closerIndexes(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Whether the text inside a would-be link label itself contains a link.
function linkInText(src, defs) {
  if (!src.includes('[')) return false;
  INL_BLOCK_SKIP.lastIndex = 0;
  for (const m of src.matchAll(INL_BLOCK_SKIP)) {
    if (INL_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  INL_REFLINK_SEARCH.lastIndex = 0;
  for (const m of src.matchAll(INL_REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !defs.has(foldLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), defs))) {
      return true;
    }
  }
  return false;
}

// The masking pass: reference links collapse to [aaa], the insides of
// code spans and the targets of inline links and raw HTML tags are
// blanked with a's, backslash escapes become ++, so the emphasis scans
// below are not confused by delimiters inside them. Length-preserving.
function maskInline(src, defs) {
  let masked = src;
  if (defs && src.includes('[')) {
    const repl = (r) => {
      const o = r.lastIndexOf('[');
      if (!defs.has(foldLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, defs)) {
          return '[' + inner.replace(INL_REFLINK_SEARCH, repl) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    masked = masked.replace(INL_REFLINK_SEARCH, repl);
  }
  masked = masked.replace(INL_ANY_PUNCT_OUTSIDE_CODE, (m, g1, g2) =>
    g2 ? '+'.repeat(m.length)
      : g1 ? g1 + m.slice(g1.length, m.length - g1.length).replace(/`/g, '+') + g1
        : m);
  masked = masked.replace(INL_BLOCK_SKIP, (m, g1, g2) => {
    const o = g2 ? g2.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return masked;
}

// The link label scan the reference runs before accepting a link: a '<'
// inside the label that starts a tag or autolink reaching past the
// label's end disqualifies the link.
function checkBrackets(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = INL_CODE.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = INL_TAG.exec(r) || INL_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Paren balance over a link destination: the index of a ')' that closes
// nothing, -2 when a '(' is left open, -1 when balanced.
function findUnbalancedParen(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < str.length; n++) {
    if (str[n] === '\\') n++;
    else if (str[n] === pair[0]) depth++;
    else if (str[n] === pair[1] && (depth--, depth < 0)) return n;
  }
  return depth > 0 ? -2 : -1;
}

// Trim a trailing run of one character.
function trimTrailingChar(a, e) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  while (s < n && a.charAt(n - s - 1) === e) s++;
  return a.slice(0, n - s);
}

// Lex a nested inline run (link label, emphasis or del content): the
// reference lexes each as its own queue entry with the raw-block flag
// reset, and the entry's tags never leak the flag back out.
function lexInlineNested(text, defs, st) {
  const prevRawBlock = st.inRawBlock;
  st.inRawBlock = false;
  const tokens = lexInline(text, defs, st);
  st.inRawBlock = prevRawBlock;
  return tokens;
}

// Build a link or image token, lexing its label; a link whose label
// itself emitted a link is rejected (no links inside links).
function outputLink(cap, link, raw, defs, st) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = lexInlineNested(text, defs, st);
  const emitted = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      return null;
    }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tokLink(src, defs, st) {
  if (st.linkParenPossible === false) return null;
  const cap = INL_LINK.exec(src);
  if (!cap) return null;
  if (checkBrackets(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return null;
  let raw = cap[0];
  let hrefPart = cap[2];
  let titlePart = cap[3];
  const hrefTrim = hrefPart.trim();
  if (START_ANGLE.test(hrefTrim)) {
    if (!END_ANGLE.test(hrefTrim)) return null;
    const back = trimTrailingChar(hrefTrim.slice(0, -1), '\\');
    if ((hrefTrim.length - back.length) % 2 === 0) return null;
  } else {
    const l = findUnbalancedParen(hrefPart, '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (raw.indexOf('!') === 0 ? 5 : 4) + cap[1].length + l;
      hrefPart = hrefPart.substring(0, l);
      raw = raw.substring(0, h).trim();
      titlePart = '';
    }
  }
  const back = trimTrailingChar(raw.slice(0, -1), '\\');
  if ((raw.length - back.length) % 2 === 0) return null;
  let dest = hrefPart.trim();
  if (START_ANGLE.test(dest)) dest = dest.slice(1, -1);
  const title = titlePart ? titlePart.slice(1, -1) : '';
  return outputLink([raw, cap[1]], {
    href: dest && dest.replace(INL_ANY_PUNCT, '$1'),
    title: title && title.replace(INL_ANY_PUNCT, '$1'),
  }, raw, defs, st);
}

function tokReflink(src, defs, st) {
  const cap = INL_REFLINK.exec(src) || INL_NOLINK.exec(src);
  if (!cap) return null;
  if (checkBrackets(src, cap[1], cap[0].charAt(0) === '!' ? 2 : 1)) return null;
  const link = defs.get(foldLabel(cap[2] || cap[1]));
  if (!link) {
    const ch = cap[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return outputLink(cap, link, cap[0], defs, st);
}

// The emphasis tokenizer: a left-delimiter run at the start of src, then
// a scan of the masked string for right delimiters, classified by the
// characters around them into openers (which raise the needed count),
// closers, and runs that can do both (governed by the rule of three).
function emStrongTok(src, masked, prevChar, closers, defs, st) {
  const cap = INL_EM_LDELIM.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return null;
  const delim = cap[0][0];
  const sameDelim = prevChar === delim;
  const end = masked.length - src.length;
  let back = end;
  while (back > 0 && masked[back - 1] === delim) back--;
  const prevRunChar = [...masked.slice(Math.max(0, back - 2), back)].at(-1) ?? '';
  const prevRunPunct = prevRunChar === '*' || prevRunChar === '_' || INL_PUNCT.test(prevRunChar);
  let prev = prevChar;
  if (back < end) prev = prevRunChar;
  const prevPunct = back < end ? prevRunPunct : INL_PUNCT.test(prev);
  if (cap[4] && /[\p{L}\p{N}]/u.test(prev)) return null;
  const nextPunct = cap[1] || cap[3] || '';
  if (!nextPunct || !prev || prevPunct) {
    const openLen = [...cap[0]].length - 1;
    let need = openLen;
    let skipped = 0;
    const totalRun = end - back + openLen;
    const bothWays = !!prevRunChar.trim() && (!!nextPunct || (delim === '*' && !prevRunPunct));
    const rdelim = delim === '*' ? INL_EM_RDELIM_AST : INL_EM_RDELIM_UND;
    const lastCloser = closers.em[delim];
    const afterOpen = end + openLen;
    if (lastCloser < afterOpen) return null;
    const rest = masked.slice(afterOpen);
    const maxIndex = lastCloser - afterOpen;
    rdelim.lastIndex = 0;
    let m;
    while ((m = rdelim.exec(rest)) !== null && !(m.index > maxIndex)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      let b = [...g].length;
      if (m[3] || m[4]) { need += b; continue; }
      if (m[5] || m[6] || bothWays) {
        if (sameDelim && (m[5] || m[6])) break;
        if (totalRun % 3 && !((totalRun + b) % 3)) { skipped += b; continue; }
      }
      need -= b;
      if (need > 0) continue;
      b = Math.min(b, b + need + skipped);
      const firstLen = [...m[0]][0].length;
      const raw = src.slice(0, openLen + m.index + firstLen + b);
      if (Math.min(openLen, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: lexInlineNested(text, defs, st) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: lexInlineNested(text, defs, st) };
    }
  }
  return null;
}

// Strikethrough: like emphasis, but the closing run must have exactly
// the opening run's length, and there is no rule of three.
function delTok(src, masked, prevChar, closers, defs, st) {
  const cap = INL_DEL_LDELIM.exec(src);
  if (!cap) return null;
  if ((cap[1] || '') || !prevChar || INL_PUNCT.test(prevChar)) {
    const openLen = [...cap[0]].length - 1;
    let need = openLen;
    const startIdx = masked.length - src.length + openLen;
    if (closers.del < startIdx) return null;
    const rest = masked.slice(startIdx);
    const maxStart = closers.del - startIdx;
    INL_DEL_RDELIM.lastIndex = 0;
    let m;
    while ((m = INL_DEL_RDELIM.exec(rest)) !== null && !(m.index > maxStart)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      let b = [...g].length;
      if (b !== openLen) continue;
      if (m[3] || m[4]) { need += b; continue; }
      need -= b;
      if (need > 0) continue;
      b = Math.min(b, b + need);
      const firstLen = [...m[0]][0].length;
      const raw = src.slice(0, openLen + m.index + firstLen + b);
      const text = raw.slice(openLen, raw.length - openLen);
      return { type: 'del', raw, text, tokens: lexInlineNested(text, defs, st) };
    }
  }
  return null;
}

// The inline lexer: tokenize src exactly the way the reference does,
// trying each tokenizer in its order.
function lexInline(src, defs, st) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    return lexInlineRun(src, defs, st);
  } finally {
    st.linkParenPossible = savedParen;
  }
}

function lexInlineRun(src, defs, st) {
  let masked = src;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskInline(src, defs);
  }
  const closers = closerIndexes(masked);
  const tokens = [];
  let rest = src;
  let prevChar = '';
  let lastWasText = false;
  let minLen = Infinity;
  while (rest) {
    if (rest.length < minLen) minLen = rest.length;
    else throw new Error('infinite loop in inline lexer');
    if (!lastWasText) prevChar = '';
    lastWasText = false;
    let tok;
    let cap;
    if ((cap = INL_ESCAPE.exec(rest))) {
      tok = { type: 'escape', raw: cap[0], text: cap[1] };
      rest = rest.slice(tok.raw.length); tokens.push(tok); continue;
    }
    if ((cap = INL_TAG.exec(rest))) {
      const raw = cap[0];
      if (!st.inLink && START_A_TAG.test(raw)) st.inLink = true;
      else if (st.inLink && END_A_TAG.test(raw)) st.inLink = false;
      if (!st.inRawBlock && START_PRE_TAG.test(raw)) st.inRawBlock = true;
      else if (st.inRawBlock && END_PRE_TAG.test(raw)) st.inRawBlock = false;
      tok = { type: 'html', raw, text: raw };
      rest = rest.slice(raw.length); tokens.push(tok); continue;
    }
    if ((tok = tokLink(rest, defs, st))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = tokReflink(rest, defs, st))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((tok = emStrongTok(rest, masked, prevChar, closers, defs, st))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((cap = INL_CODE.exec(rest))) {
      let text = cap[2].replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) {
        text = text.substring(1, text.length - 1);
      }
      tok = { type: 'codespan', raw: cap[0], text };
      rest = rest.slice(tok.raw.length); tokens.push(tok); continue;
    }
    if ((cap = INL_BR.exec(rest))) {
      tok = { type: 'br', raw: cap[0] };
      rest = rest.slice(tok.raw.length); tokens.push(tok); continue;
    }
    if ((tok = delTok(rest, masked, prevChar, closers, defs, st))) { rest = rest.slice(tok.raw.length); tokens.push(tok); continue; }
    if ((cap = INL_AUTOLINK.exec(rest))) {
      const text = cap[1];
      const href = cap[2] === '@' ? 'mailto:' + text : text;
      tok = { type: 'link', raw: cap[0], href, title: null, text, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
      rest = rest.slice(tok.raw.length); tokens.push(tok); continue;
    }
    if (!st.inLink && (cap = INL_URL.exec(rest))) {
      let raw = cap[0];
      let text, href;
      if (cap[2] === '@') {
        text = raw; href = 'mailto:' + raw;
      } else {
        let prev;
        do {
          prev = raw;
          raw = INL_BACKPEDAL.exec(raw)?.[0] ?? '';
        } while (prev !== raw);
        text = raw;
        href = cap[1] === 'www.' ? 'http://' + raw : raw;
      }
      tok = { type: 'link', raw, href, title: null, text, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
      rest = rest.slice(raw.length); tokens.push(tok); continue;
    }
    if ((cap = INL_TEXT.exec(rest))) {
      const raw = cap[0];
      tok = { type: 'text', raw, text: st.inRawBlock ? raw : resolveEntities(raw), escaped: st.inRawBlock };
      rest = rest.slice(raw.length);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      lastWasText = true;
      tokens.push(tok); continue;
    }
    throw new Error('infinite loop in inline lexer');
  }
  return tokens;
}

// Render inline tokens to HTML, the reference renderer's way.
function renderTokensHtml(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape':
        out += escapeHtml(t.text);
        break;
      case 'html':
        out += t.text;
        break;
      case 'link': {
        const inner = t.autolink ? escapeHtml(t.text, true) : renderTokensHtml(t.tokens);
        const href = cleanHref(t.href);
        if (href === null) { out += inner; break; }
        out += '<a href="' + escapeHtml(href, t.autolink) + '"';
        if (t.title) out += ' title="' + escapeHtml(t.title) + '"';
        out += '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const plain = renderTokensText(t.tokens);
        const href = cleanHref(t.href);
        if (href === null) { out += escapeHtml(plain); break; }
        out += '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(plain) + '"';
        if (t.title) out += ' title="' + escapeHtml(t.title) + '"';
        out += '>';
        break;
      }
      case 'strong':
        out += '<strong>' + renderTokensHtml(t.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderTokensHtml(t.tokens) + '</em>';
        break;
      case 'del':
        out += '<del>' + renderTokensHtml(t.tokens) + '</del>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(t.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'text':
        out += t.escaped ? t.text : escapeHtml(t.text);
        break;
    }
  }
  return out;
}

// Render inline tokens as plain text (used for image alt text).
function renderTokensText(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += t.tokens ? renderTokensText(t.tokens) : t.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += t.text;
        break;
      case 'br':
        break;
    }
  }
  return out;
}

// Render inline text (a paragraph's, heading's or table cell's) to HTML.
// Fast path: a text run with no inline-significant characters renders
// as itself (nothing to escape, link, or emphasize). The character set
// covers every construct the inline lexer can start: escapes, code
// spans, links/images, HTML, entities, emphasis, strikethrough,
// autolinks (www./scheme/@), and hard breaks (two spaces + newline).
const INLINE_PLAIN = /[`\\[\]<>&*_~!@]|\bwww\.|https?:|ftp:|mailto:|xmpp:|[ \t]{2,}\n/i;

function renderInline(text, defs) {
  if (!INLINE_PLAIN.test(text)) {
    // Only the quote characters still need escaping in plain text.
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  if (!inlState) inlState = freshInlineState();
  // The reference resets the raw-block flag for every block-level
  // inline run; an unclosed <pre>/<code>/<kbd>/<script> tag in one
  // block must not unescape the text of the next.
  inlState.inRawBlock = false;
  return renderTokensHtml(lexInline(text, defs, inlState));
}


function matchTagEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return 0;
  j++;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : 0;
  }
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (ws === 0 || j >= n) return 0;
    if (!/[A-Za-z_:]/.test(s[j])) return 0;
    j++;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      const q = s[k];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, k + 1);
        if (e < 0) return 0;
        j = e + 1;
      } else {
        let v = k;
        while (v < n && !/[\s"'=<>`]/.test(s[v])) v++;
        if (v === k) return 0;
        j = v;
      }
    }
  }
}
// ---------------------------------------------------------------------------
// Block parsing
//
// Blocks are parsed from an array of lines (no line terminators) into
// tokens; link reference definitions found anywhere register into a shared
// map. Rendering happens afterwards, so a reference may be defined below
// the paragraph that uses it.
// ---------------------------------------------------------------------------

function fenceStart(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return null;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(line.slice(idx));
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return m;
}

// A backtick run line (at most 1 column in) whose info string contains
// a backtick: not a fence, but marked treats a paragraph starting with
// one as a full paragraph even in a tight list, and a paragraph whose
// last line is one accepts no lazy continuation.
function badFenceRun(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 1) return false;
  const m = /^(`{3,})(.*)$/.exec(line.slice(idx));
  return !!m && m[2].includes('`');
}

// marked strips fence content lines by characters, not columns: up to
// `count` leading whitespace characters come off (a tab counts as one).
function stripWsChars(line, count) {
  let i = 0;
  while (i < line.length && i < count && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

function matchFence(lines, i) {
  const m = fenceStart(lines[i]);
  if (!m) return null;
  const ind = leadInfo(lines[i]).cols;
  const ch = m[1][0];
  const len = m[1].length;
  const info = m[2];
  const content = [];
  let j = i + 1;
  let closed = false;
  while (j < lines.length) {
    const L = lines[j];
    if (L.startsWith(SEGB)) break;
    const li = leadInfo(L);
    if (li.cols <= 3) {
      const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(L.slice(li.idx));
      if (cm && cm[1][0] === ch && cm[1].length >= len) { closed = true; j++; break; }
    }
    // marked strips the fence's indentation from backtick-fence
    // content only; tilde-fence content keeps its leading spaces.
    // Fence content is verbatim text: a tab-run quote line contributes
    // its expanded form here.
    const U = unwrapExpd(L);
    content.push(ch === '~' ? U : stripWsChars(U, ind));
    j++;
  }
  void closed;
  // The content is the lines joined by newlines, with a final newline
  // added only when it does not already end with one (a trailing blank
  // line inside the fence is absorbed).
  let text = content.join('\n');
  if (text !== '' && !text.endsWith('\n')) text += '\n';
  const langRaw = unescapeStr(info.trim());
  const lang = langRaw === '' ? '' : langRaw.split(/[ \t]/)[0];
  return { token: { t: 'code', text, lang }, next: j };
}

function matchATX(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line.slice(idx));
  if (!m) return null;
  let content = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
  content = content.replace(/[ \t]+#+$/, '');
  if (/^#+$/.test(content)) content = '';
  return { t: 'heading', level: m[1].length, text: content };
}

function isHRLine(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return false;
  return /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line.slice(idx));
}

function isSetextUnderline(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return 0;
  const rest = line.slice(idx);
  if (/^=+[ \t]*$/.test(rest)) return 1;
  if (/^-+[ \t]*$/.test(rest)) return 2;
  return 0;
}

function collectIndentedCode(lines, i) {
  const texts = [];
  let lastContent = -1;
  let j = i;
  while (j < lines.length) {
    const L = lines[j];
    if (L.startsWith(SEGB)) break;
    if (isBlankLine(L)) {
      // A whitespace-only line belongs to the block only when indented
      // content follows it; its own excess indentation is content.
      let k = j + 1;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (k < lines.length && leadInfo(lines[k]).cols >= 4) {
        texts.push(contentFrom(L, 4));
        j++;
        continue;
      }
      break;
    }
    if (leadInfo(L).cols < 4) break;
    texts.push(contentFrom(L, 4));
    lastContent = texts.length - 1;
    j++;
  }
  texts.length = lastContent + 1;
  return { token: { t: 'code', text: texts.join('\n') + '\n', lang: '' }, next: j };
}

// --- HTML blocks -----------------------------------------------------------

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'legend', 'li', 'link', 'main', 'menu', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);

// Which of the seven CommonMark HTML block kinds a line starts, or 0.
function htmlBlockType(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return 0;
  const rest = line.slice(idx);
  if (rest[0] !== '<') return 0;
  if (/^<(script|pre|style|textarea)(?=[\s>]|$)/.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (/^<![A-Z]/.test(rest)) return 4;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1])) {
    const after = rest[m[0].length];
    if (after === undefined || after === '>' || after === ' ' || after === '\t' ||
        (after === '/' && rest[m[0].length + 1] === '>')) return 6;
  }
  const end = matchTagEnd(line, idx);
  if (end > 0 && /^[ \t]*$/.test(line.slice(end))) return 7;
  return 0;
}

function matchHtmlBlock(lines, i, ctx) {
  const type = htmlBlockType(lines[i]);
  if (type === 0) return null;
  const n = lines.length;
  // The block's trailing newline: blocks closed by a terminator (types
  // 1-5) keep the newline ending their last line when a non-blank line
  // follows in the same context, or at the very end of input that ended
  // with one. Blocks ended by a blank line (types 6-7 always, 1-5 when
  // the terminator is followed by one) have no trailing newline.
  const finish = (j) => {
    // HTML block text is verbatim: container markers on its lines
    // resolve to the bare line forms the reference lexes.
    let text = lines.slice(i, j).map((l) => l.startsWith(SOFT) ? l.slice(1) : stripLazyPrefix(l)).join('\n');
    const hasNext = j < n;
    let addNl;
    // Types 1-5 keep the terminator line's newline when exactly one
    // newline follows it in the enclosing text: a non-blank next line,
    // a single trailing blank line at the buffer's end, or the end of
    // a newline-terminated context.
    if (type <= 5) addNl = (hasNext && lines[j] !== '') || (!hasNext && (ctx.eol || ctx.ceol)) ||
      (hasNext && lines[j] === '' && j === n - 1);
    else addNl = !hasNext && ctx.eol;
    if (addNl) text += '\n';
    return { token: { t: 'html', text, ht: type }, next: j };
  };
  if (type === 1) {
    const name = /^<(script|pre|style|textarea)/i.exec(lines[i].slice(leadInfo(lines[i]).idx))[1].toLowerCase();
    const close = '</' + name;
    let j = i;
    while (j < n) {
      if (lines[j].startsWith(SEGB)) break;
      const has = lines[j].toLowerCase().includes(close);
      j++;
      if (has) break;
    }
    return finish(j);
  }
  if (type >= 2 && type <= 5) {
    const needle = type === 2 ? '-->' : type === 3 ? '?>' : type === 5 ? ']]>' : '>';
    let j = i;
    while (j < n) {
      if (lines[j].startsWith(SEGB)) break;
      const has = lines[j].includes(needle);
      j++;
      if (has) break;
    }
    return finish(j);
  }
  let j = i;
  while (j < n && !isBlankLine(lines[j]) && !lines[j].startsWith(SEGB)) j++;
  // Types 6-7: the text is the block's raw text — which runs over the
  // blank lines following the block in the same enclosing text — with
  // the reference's trailing trim: trailing blank lines are dropped
  // only when more than one line's worth of them follows the last
  // content line; a single trailing whitespace line stays.
  let end = j;
  while (end < n && isBlankLine(lines[end])) end++;
  const norm = (l) => l.startsWith(SOFT) ? l.slice(1) : stripLazyPrefix(l);
  const raw = lines.slice(i, end).map(norm).join('\n') + ((end < n || ctx.eol) ? '\n' : '');
  const parts = raw.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && isBlankLine(parts[t])) t--;
  const text = (t < 0 || parts.length - t <= 2) ? raw : parts.slice(0, t + 1).join('\n');
  return { token: { t: 'html', text, ht: type }, next: j };
}

// --- Link reference definitions ---------------------------------------------

// Scan a title starting at text[q] (a quote or '('). Returns
// {title, end} with end just past the closing delimiter, or null.
function scanTitle(text, q) {
  const open = text[q];
  const close = open === '(' ? ')' : open;
  let j = q + 1;
  let raw = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && ASCII_PUNCT.has(text[j + 1] || '')) { raw += c + text[j + 1]; j += 2; continue; }
    if (c === close) return { title: unescapeStr(raw), end: j + 1 };
    if (open === '(' && c === '(') return null;
    if (c === '\n' && text[j + 1] === '\n') return null;
    raw += c;
    j++;
  }
  return null;
}

// Skip spaces, tabs and at most one newline (a definition never crosses a
// blank line). Returns the new index, or -1 across a blank line.
function skipDefWs(text, j) {
  let newlines = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === '\n') { newlines++; if (newlines > 1) return -1; j++; }
    else if (c === ' ' || c === '\t') j++;
    else break;
  }
  return j;
}

// Parse one link reference definition at the start of `text` (which holds
// whole lines joined by '\n', none of them blank). Returns
// {label, href, title, end} with end at a line end, or null.
function parseDefText(text) {
  let p = 0;
  let sp = 0;
  while (text[p] === ' ' && sp < 4) { p++; sp++; }
  if (sp > 3 || text[p] !== '[') return null;
  let j = p + 1;
  let label = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && ASCII_PUNCT.has(text[j + 1] || '')) { label += c + text[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') break;
    label += c;
    j++;
  }
  if (j >= text.length || text[j] !== ']') return null;
  if (label.trim() === '' || label.length > 999) return null;
  j++;
  if (text[j] !== ':') return null;
  j = skipDefWs(text, j + 1);
  if (j < 0) return null;
  let href;
  if (text[j] === '<') {
    const gt = text.indexOf('>', j + 1);
    if (gt < 0) return null;
    const inner = text.slice(j + 1, gt);
    if (inner.includes('\n') || inner.includes('<')) return null;
    href = unescapeStr(inner);
    j = gt + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < text.length) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '\\' && ASCII_PUNCT.has(text[j + 1] || '')) { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) return null; }
      j++;
    }
    if (j === start || depth !== 0) return null;
    href = unescapeStr(text.slice(start, j));
  }
  const lineEnd = text.indexOf('\n', j);
  const lend = lineEnd < 0 ? text.length : lineEnd;
  const rest = text.slice(j, lend);
  if (/^[ \t]*$/.test(rest)) {
    // A title may stand alone on the following line.
    if (lend < text.length) {
      const q = skipDefWs(text, j);
      if (q > 0 && (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
        const t = scanTitle(text, q);
        if (t) {
          const te = text.indexOf('\n', t.end);
          const tl = te < 0 ? text.length : te;
          if (/^[ \t]*$/.test(text.slice(t.end, tl))) {
            return { label, href, title: t.title, end: tl };
          }
        }
      }
    }
    return { label, href, title: null, end: lend };
  }
  // Anything else on the destination's line must be a lone title, set off
  // by whitespace.
  if (rest[0] !== ' ' && rest[0] !== '\t') return null;
  let q = j;
  while (text[q] === ' ' || text[q] === '\t') q++;
  if (text[q] !== '"' && text[q] !== "'" && text[q] !== '(') return null;
  const t = scanTitle(text, q);
  if (!t) return null;
  const te = text.indexOf('\n', t.end);
  const tl = te < 0 ? text.length : te;
  if (!/^[ \t]*$/.test(text.slice(t.end, tl))) return null;
  return { label, href, title: t.title, end: tl };
}

// If lines[i] starts a link reference definition, register it and return
// {next}; otherwise return null.
function tryParseDef(lines, i, defs) {
  let text = '';
  for (let k = i; k < lines.length && k < i + 12; k++) {
    if (isBlankLine(lines[k])) break;
    text += (k > i ? '\n' : '') + lines[k];
    const lastLine = k + 1 >= lines.length || isBlankLine(lines[k + 1]) || k === i + 11;
    const r = parseDefText(text);
    if (!r) continue;
    if (r.end < text.length || lastLine) {
      const key = normalizeLabel(r.label);
      if (!defs.has(key)) defs.set(key, { href: r.href, title: r.title });
      return { next: i + text.slice(0, r.end).split('\n').length };
    }
  }
  return null;
}

// --- Tables (GFM) -------------------------------------------------------------

// Split a table row on pipes that are neither escaped nor inside a code
// span. An escaped pipe becomes a literal pipe in the cell.
function splitTableRow(line) {
  // marked splits rows on unescaped pipes only: a pipe inside what
  // looks like a code span still splits the row.
  const cells = [];
  let cur = '';
  let p = 0;
  const s = line;
  while (p < s.length) {
    const ch = s[p];
    if (ch === '\\' && s[p + 1] === '|') { cur += '|'; p += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; p++; continue; }
    cur += ch;
    p++;
  }
  cells.push(cur);
  return cells;
}

// Split and drop the empty edge cells a leading/trailing pipe produces.
function tableCells(line) {
  const trimmed = line.trim();
  const cells = splitTableRow(trimmed);
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells;
}

// Header + delimiter pair at lines i, i+1: {header, aligns} or null.
function matchTableHeader(hLine, dLine) {
  if (leadInfo(hLine).cols > 3 || leadInfo(dLine).cols > 3) return null;
  if (!hLine.includes('|') || !dLine.includes('|')) return null;
  const dcells = tableCells(dLine);
  if (dcells.length === 0) return null;
  const aligns = [];
  for (const c of dcells) {
    const t = c.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    aligns.push(t.startsWith(':') && t.endsWith(':') ? 'center' : t.endsWith(':') ? 'right' : t.startsWith(':') ? 'left' : null);
  }
  const hcells = tableCells(hLine);
  if (hcells.length !== dcells.length) return null;
  return { header: hcells.map((c) => c.trim()), aligns };
}

// A table's body rows run until a blank line or the start of another
// block-level structure.
function tableRowBreak(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return false;
  if (line[idx] === '>') return true;
  if (fenceStart(line)) return true;
  if (matchATX(line)) return true;
  if (isHRLine(line)) return true;
  const ht = htmlBlockType(line);
  if (ht !== 0 && ht !== 7) return true;
  const lm = matchListMarker(line);
  if (lm && !lm.blankItem && (!lm.ordered || lm.num === 1)) return true;
  return false;
}

const WS_ONLY = /^[ \t]*$/;

function matchTable(lines, i, tailOpen) {
  const m = matchTableHeader(lines[i], lines[i + 1]);
  if (!m) return null;
  const raw = [];
  let j = i + 2;
  // Rows run until another block's start or a whitespace-only line that
  // does not end in a tab. A whitespace-only line ending in a tab is
  // collected, and becomes an (empty) row iff the body holds at least
  // one real row — except that a whitespace-only final line with no
  // terminating newline is never a row.
  while (j < lines.length) {
    const L = lines[j];
    if (WS_ONLY.test(L) && !L.endsWith('\t')) break;
    // A line indented a full code level is not a row: the table ends
    // and the line is parsed as indented code instead.
    if (!WS_ONLY.test(L) && leadInfo(L).cols >= 4) break;
    if (tableRowBreak(L)) break;
    raw.push(L);
    j++;
  }
  const hasReal = raw.some((L) => !WS_ONLY.test(L));
  const rows = [];
  for (let k = 0; k < raw.length; k++) {
    const L = raw[k];
    if (WS_ONLY.test(L)) {
      if (!hasReal) continue;
      if (tailOpen && i + 2 + k === lines.length - 1) continue;
    }
    const cells = tableCells(L).map((c) => c.trim());
    while (cells.length < m.header.length) cells.push('');
    rows.push(cells.slice(0, m.header.length));
  }
  return { token: { t: 'table', header: m.header, aligns: m.aligns, rows }, next: j };
}

// --- Block quotes ---------------------------------------------------------------

function lastBlockIsPara(tokens) {
  if (!tokens.length) return false;
  const last = tokens[tokens.length - 1];
  if (last.t === 'paragraph') return true;
  if (last.t === 'quote') return lastBlockIsPara(last.children);
  if (last.t === 'list' && last.items.length) return lastBlockIsPara(last.items[last.items.length - 1].children);
  return false;
}

// The reference's stop tests for a dedented line that follows the
// item's FIRST line, judged on that line in its post-bullet frame:
// first non-space (tabs counted as four spaces) at column 4+, or a
// fence, heading, thematic break or HTML block beginning within the
// clamped indent tolerance.
const LAZY_PREV_RES = [0, 1, 2, 3].map((t) => ({
  fence: new RegExp(`^ {0,${t}}(?:\`\`\`|~~~)`),
  heading: new RegExp(`^ {0,${t}}#{1,6}(?:\\s|$)`),
  hr: new RegExp(`^ {0,${t}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
  html: new RegExp(`^ {0,${t}}(?:</?(?:${[...BLOCK_TAGS].join('|')})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
}));
function prevBlocksLazy(m, contentIndent) {
  if (m.replace(/\t/g, '    ').search(/[^ ]/) >= 4) return true;
  const res = LAZY_PREV_RES[Math.max(0, Math.min(3, contentIndent - 1))];
  return res.fence.test(m) || res.heading.test(m) || res.hr.test(m) || res.html.test(m);
}

// In marked's list handling, a lazy continuation line only joins the
// item's paragraph when the paragraph's last line is not itself deeply
// indented (4+ columns once the item indentation is stripped): a deep
// last line closes the paragraph for laziness purposes.
function lastLineDeep(buf, contentIndent) {
  const L = buf[buf.length - 1];
  if (L === undefined) return false;
  // A lazy line counts by its depth after the item's own dedent.
  const s = L.charCodeAt(0) === 1 ? itemStrip(L.slice(1), contentIndent) : L;
  return leadInfo(s).cols >= 4;
}

// Would the block sequence in bufLines end inside an open paragraph?
// A trailing blank line closes any paragraph, so it ends the laziness.
// Collection loops re-inspect the tail of a growing line buffer for
// every new line; cache the buffer's block parse keyed by its length
// (buffers only ever grow by pushes during collection).
const bufParseCache = new WeakMap();
function parseBufCached(lines, inItem) {
  let per = bufParseCache.get(lines);
  if (!per) { per = new Map(); bufParseCache.set(lines, per); }
  const hit = per.get(!!inItem);
  if (hit && hit.len === lines.length) return hit.toks;
  const toks = parseBlockLines(lines, new Map(), { eol: false, inItem: !!inItem });
  per.set(!!inItem, { len: lines.length, toks });
  return toks;
}

function endsWithOpenParagraph(bufLines, inItem) {
  if (!bufLines.length) return false;
  if (isBlankLine(bufLines[bufLines.length - 1])) return false;
  // A trailing SOFT line is a blank line inside a quote: the quote's
  // paragraph is closed, not open.
  if (bufLines[bufLines.length - 1].startsWith(SOFT)) return false;
  return lastBlockIsPara(parseBufCached(bufLines, inItem));
}

function lastBlockIsClosedQuote(bufLines) {
  if (!bufLines.length) return false;
  const toks = parseBufCached(bufLines, true);
  if (!toks.length || toks[toks.length - 1].t !== 'quote') return false;
  return !lastBlockIsPara(toks);
}

function lastBlockIsList(bufLines) {
  if (!bufLines.length) return false;
  const toks = parseBufCached(bufLines, true);
  return toks.length > 0 && toks[toks.length - 1].t === 'list';
}

function lastBlockIsTable(bufLines) {
  if (!bufLines.length) return false;
  const toks = parseBufCached(bufLines, false);
  return toks.length > 0 && toks[toks.length - 1].t === 'table';
}

function lastBlockIsHtml(bufLines) {
  if (!bufLines.length) return false;
  const toks = parseBufCached(bufLines, false);
  return toks.length > 0 && toks[toks.length - 1].t === 'html';
}

// True when the buffer's last line is a quote line whose content is
// blank (the quote's inner text ends on a blank line).
function quoteEndsBlank(buf) {
  if (!buf.length) return false;
  let L = buf[buf.length - 1];
  for (;;) {
    const li = leadInfo(L);
    if (li.cols <= 3 && L[li.idx] === '>') {
      L = quoteStrip(L.slice(li.idx + 1), li.cols + 1);
      if (isBlankLine(L)) return true;
      continue;
    }
    return false;
  }
}

// Lines collected for a quote's inner parse (or a list item's buffer) can
// carry two markers: '\u0001' prefixes a lazy continuation line (its
// leading whitespace is not content), '\u0002' prefixes a line that held
// only spaces behind an explicit '>' (content for an open paragraph, a
// blank everywhere else).
const LAZY = '\u0001';
const SOFT = '\u0002';
// '\u0005' prefixes a lazy line collected by a blockquote (rather than
// by a list): a list whose item paragraph ends on such a line accepts
// no further lazy continuation.
const QLAZY = '\u0005';
// '\u0003' prefixes a lazy setext-underline line inside a quote: marked
// keeps such a line in the paragraph text but indents it by 4 spaces,
// so it can no longer act as a heading underline.
const PAD = '\u0003';
// '\u0006' prefixes a line a list collected as a standalone block (a
// lone type-7 tag line): it must break any open paragraph and be
// lexed as its own block.
const BLK = '\u0006';
// '\u0004' prefixes a quote-stripped line whose leading whitespace run
// contained a tab. It stores the RAW remainder (after the base column
// digit and the run's first character): when a nested quote swallows
// the line lazily, the reference's re-lex hands it the raw form ('>'
// plus exactly one whitespace char removed); when the line is content
// at this level, the expanded form (quoteStrip) applies instead.
const EXPD = '\u0004';

let expdCount = 0;

function expdLine(baseCol, seg) {
  expdCount++;
  return EXPD + baseCol + seg[0] + seg.slice(1);
}

function expdRaw(line) {
  return line.slice(3);
}

function unwrapExpd(line) {
  if (!line.startsWith(EXPD)) return line;
  return quoteStrip(line[2] + line.slice(3), line.charCodeAt(1) - 48);
}

// '\u0007' marks a segment boundary inside a quote's inner lines: the
// reference lexes each quote segment in its own block pass, so a list
// (or fence, code, HTML block) never merges across it, while
// paragraphs still flow across.
const SEGB = '\u0007';

function collectQuote(lines, i, defs, ctx) {
  const inner = [];
  const n = lines.length;
  let j = i;
  // Segment tracking for the reference's quote lexing: a segment is a
  // run of '>' lines (plus leading lazy lines); once a lazy line follows
  // a '>' line the segment is broken, and later '>' lines belong to the
  // "remaining lines" a nested quote re-lexes from their raw form.
  let segHasQuote = false;
  let segBroke = false;
  while (j < n) {
    const line = lines[j];
    // A segment boundary from an outer quote is transparent here: a
    // nested quote re-lexes across it. Pass it through so block
    // boundaries still apply at the levels below.
    if (line.startsWith(SEGB)) { inner.push(SEGB); j++; continue; }
    const { cols: ind, idx } = leadInfo(line);
    if (ind <= 3 && line[idx] === '>') {
      const wasBroke = segBroke;
      if (segBroke && inner.length) { inner.push(SEGB); segBroke = false; }
      segHasQuote = true;
      // The '>' plus one optional space of indentation comes off, with
      // tab widths measured from the column just past the '>'.
      const seg = line.slice(idx + 1);
      const stripped = quoteStrip(seg, ind + 1);
      if (stripped !== '' && isBlankLine(stripped)) {
        inner.push(SOFT + stripped);
      } else if (wasBroke && (seg[0] === ' ' || seg[0] === '\t')) {
        // Past a broken segment, keep the raw remainder when the
        // whitespace run holds a tab: a nested quote re-lexing this
        // line lazily needs it verbatim (see EXPD).
        let hasTab = false;
        for (let k = 0; k < seg.length && (seg[k] === ' ' || seg[k] === '\t'); k++) {
          if (seg[k] === '\t') { hasTab = true; break; }
        }
        inner.push(hasTab ? expdLine(ind + 1, seg) : stripped);
      } else {
        inner.push(stripped);
      }
      j++;
      continue;
    }
    // A SOFT line is a blank line one quote level up; at this level it
    // is a plain blank separator, never lazy content.
    if (isBlankLine(line) || line.startsWith(SOFT)) break;
    // A table that starts inside the quote keeps collecting its rows
    // as raw quote content (the inner parse splits paragraph/table).
    if (inner.length && lastBlockIsTable(inner) && leadInfo(line).cols < 4 && !tableRowBreak(line)) {
      if (segHasQuote) segBroke = true;
      inner.push(line);
      j++;
      continue;
    }
    // A table header line (with its delimiter line) is collected into
    // the quote even though it would interrupt the paragraph outside.
    if (inner.length && endsWithOpenParagraph(inner, ctx.inItem) &&
        matchTableHeader(line, lines[j + 1] || '') !== null) {
      if (segHasQuote) segBroke = true;
      inner.push(line);
      inner.push(lines[j + 1]);
      j += 2;
      continue;
    }
    // Lazy continuation of a paragraph inside the quote. A list marker
    // line is never lazy here, whatever its kind or start number:
    // marked ends the quote and lets the line open a list outside.
    // The quote also runs on past a trailing list: the reference's
    // segment loop keeps feeding lines to the quote after a list
    // token, so a plain line lands inside the quote (as the list's
    // lazy tail or as a quote-level block).
    const lazyLm = matchListMarker(line);
    if (inner.length && (endsWithOpenParagraph(inner, ctx.inItem) || lastBlockIsList(inner)) && !lazyLm && !interruptsParagraph(line, lines[j + 1], ctx.inItem)) {
      // A line an outer container collected lazily is quote-collected
      // now too: it takes the QLAZY marker so the paragraph shaping
      // phase (the code-merge illusion) ends with it, as the reference's
      // segment-based quote lexing dictates. A tab-run line stripped by
      // an outer quote enters in its raw form (see EXPD).
      if (segHasQuote) segBroke = true;
      inner.push(isSetextUnderline(line) ? PAD + line :
        line.startsWith(EXPD) ? QLAZY + expdRaw(line) :
        (line.startsWith(QLAZY) ? line : QLAZY + stripLazyPrefix(line)));
      j++;
      continue;
    }
    break;
  }
  return { token: { t: 'quote', children: parseBlockLines(inner, defs, { eol: false, inItem: ctx.inItem, paraStrip: false }) }, next: j };
}

// --- Lists ------------------------------------------------------------------------

function matchListMarker(line) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return null;
  const rest = line.slice(idx);
  let ordered = false;
  let bullet = '';
  let delim = '';
  let num = 0;
  let markerWidth = 0;
  let m = /^([-+*])(?=[ \t]|$)/.exec(rest);
  if (m) {
    bullet = m[1];
    markerWidth = 1;
  } else if ((m = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest))) {
    ordered = true;
    num = parseInt(m[1], 10);
    delim = m[2];
    markerWidth = m[1].length + 1;
  } else return null;
  const markerEndCol = ind + markerWidth;
  const after = rest.slice(markerWidth);
  let spCols = 0;
  {
    let col = markerEndCol;
    for (const ch of after) {
      if (ch === ' ') { col++; spCols++; }
      else if (ch === '\t') { const w = 4 - (col % 4); col += w; spCols += w; }
      else break;
    }
  }
  const blankItem = after.replace(/^[ \t]+/, '') === '';
  const contentIndent = (blankItem || spCols > 4) ? markerEndCol + 1 : markerEndCol + spCols;
  return { ordered, bullet, delim, num, contentIndent, blankItem, idx, markerWidth, markerEndCol };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// Strip a list item's content indent from a continuation line. The
// reference expands the line's leading whitespace run to spaces first
// (a tab counts its full width at its original column), then removes
// the indent, so a tab just past the cut becomes spaces.
function itemStrip(line, want) {
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') col += 1;
    else col += 4 - (col % 4);
    i++;
  }
  if (want >= col) return line.slice(i);
  return ' '.repeat(col - want) + line.slice(i);
}

// The fence open at the end of a line buffer, if any. Whether a
// following line then belongs to the item is decided per line in
// parseList (indented lines are fence content; dedented lines go
// through the reference's lazy-line test on the previous line).
const fenceStateCache = new WeakMap();
function fenceStateAtEnd(buf) {
  // Incremental scan: buffers grow by appends while gathering, so the
  // fence state for every prefix length is cached and a call only
  // processes the lines appended since the previous one.
  let rec = fenceStateCache.get(buf);
  if (!rec) {
    rec = { states: [null] };
    fenceStateCache.set(buf, rec);
  }
  const states = rec.states;
  if (states.length > buf.length + 1) states.length = buf.length + 1;
  for (let k = states.length - 1; k < buf.length; k++) {
    let open = states[k];
    const L = buf[k];
    if (open) {
      const li = leadInfo(L);
      if (li.cols <= 3) {
        const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(L.slice(li.idx));
        if (cm && cm[1][0] === open.ch && cm[1].length >= open.len) open = null;
      }
    } else {
      const fs = fenceStart(L);
      if (fs) open = { ch: fs[1][0], len: fs[1].length, startIdx: k };
    }
    states.push(open);
  }
  return states[buf.length];
}

function parseList(lines, i, defs, ctx) {
  const first = matchListMarker(lines[i]);
  if (!first) return null;
  const n = lines.length;
  const rawItems = [];
  let loose = false;
  let cur = null;
  const startItem = (marker, lineIdx) => {
    const line = lines[lineIdx];
    const seg = line.slice(marker.idx + marker.markerWidth);
    const firstContent = contentFrom(seg, marker.contentIndent - marker.markerEndCol, marker.markerEndCol);
    // The reference judges a dedented line after the item's first line
    // by that first line in its post-bullet frame (leading whitespace
    // tab-expanded from the bullet's end column): if its first
    // non-space sits at column 4+, or it begins a fence, heading, rule
    // or HTML block in that frame, the dedented line ends the item
    // instead of joining lazily.
    const lazyPrev = seg.replace(/^[ \t]+/, (run) => {
      let col = marker.markerEndCol;
      let out = '';
      for (const ch of run) {
        if (ch === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
        else { out += ' '; col++; }
      }
      return out;
    });
    cur = { buf: [firstContent], contentIndent: marker.contentIndent, blankStart: marker.blankItem, rawTail: line, qLazyTail: false, followedByBlank: false, lazyPrev, lazyPrevFirst: true };
    rawItems.push(cur);
  };
  startItem(first, i);
  let j = i + 1;
  while (j < n) {
    const line = lines[j];
    // A quote segment boundary ends the list: the reference lexes the
    // next segment in a fresh block pass, so its list is a new token.
    if (line.startsWith(SEGB)) break;
    const fenceOpen = fenceStateAtEnd(cur.buf);
    if (fenceOpen && !isBlankLine(line)) {
      // Inside an unclosed fence, a line with the item's indentation is
      // fence content even when it looks like a list marker or a rule.
      if (leadInfo(line).cols >= cur.contentIndent) {
        cur.buf.push(itemStrip(line, cur.contentIndent));
        cur.rawTail = line;
        j++;
        continue;
      }
      // A fence-start line is never swallowed: it ends the item and
      // opens a new fence outside, even when it could have closed
      // the item's open fence. Lines that start a block of their own
      // (heading, rule, HTML block, quote, list marker) likewise end
      // the item. Any other dedented line is judged by the reference's
      // one gathering rule for dedented lines, fence or no fence: it
      // joins the item only when the previous gathered line does not
      // block laziness (prevBlocksLazy — a fence opener that begins
      // within the item frame's clamped indent tolerance blocks it, so
      // the fence stays empty and the line falls outside; an opener
      // that sits deeper in the frame does not block, and the line
      // becomes fence content). The reference's gathering tracks no
      // fence state beyond this per-line test.
      const candBlock = !!(matchATX(line) || isHRLine(line) || htmlBlockType(line) !== 0 ||
        /^[ ]{0,3}>/.test(line) || matchListMarker(line));
      const lineIsRun = leadInfo(line).cols <= 3 && /^[`~]{3,}/.test(line.slice(leadInfo(line).idx));
      const mPrev = cur.buf.length === 1 ? cur.lazyPrev : itemStrip(cur.rawTail, cur.contentIndent);
      if (!fenceStart(line) && !lineIsRun && !candBlock && !prevBlocksLazy(mPrev, cur.contentIndent)) {
        cur.buf.push(line);
        cur.rawTail = line;
        j++;
        continue;
      }
      // Fall through: the normal line handling below ends the item.
    }
    // A SOFT line is a blank line wearing a marker (a quote's '>'
    // line that held only spaces): the reference's item text has a
    // real blank line there.
    if (isBlankLine(line) || line.startsWith(SOFT)) {
      let k = j;
      while (k < n && (isBlankLine(lines[k]) || lines[k].startsWith(SOFT))) k++;
      // Blank lines gathered while the item is open belong to its
      // text in stripped form (possibly empty) — an HTML block's raw
      // text can keep a trailing one. They are pushed whatever ends
      // the item afterwards.
      for (let b = j; b < k; b++) {
        const bl = lines[b];
        cur.buf.push(bl.startsWith(SOFT) ? itemStrip(bl.slice(1), cur.contentIndent) : itemStrip(bl, cur.contentIndent));
      }
      if (k >= n) { j = k; break; }
      const nl = lines[k];
      if (leadInfo(nl).cols >= cur.contentIndent) {
        // An item that began blank and still has no content ends at the
        // blank line; the indented line belongs to the outer context.
        if (cur.blankStart && cur.buf.every((l) => isBlankLine(l))) break;
        cur.qLazyTail = false;
        j = k;
        continue;
      }
      const nm = matchListMarker(nl);
      if (nm && sameListType(nm, first) && !isHRLine(nl)) {
        loose = true;
        cur.followedByBlank = true;
        startItem(nm, k);
        j = k + 1;
        continue;
      }
      break;
    }
    // A line an outer container marked lazy is judged by its bare
    // form: deep enough here, it is an ordinary continuation.
    const bare = (line.startsWith(LAZY) || line.startsWith(QLAZY)) ? stripLazyPrefix(line) : line;
    const ind = leadInfo(bare).cols;
    if (ind >= cur.contentIndent) {
      if (line.startsWith(QLAZY)) cur.qLazyTail = true;
      const stripped = itemStrip(bare, cur.contentIndent);
      // A lone type-7 tag line after the item's open paragraph is its
      // own HTML block (the reference lexes item text line by line),
      // glued to the paragraph — same rule as the lazy branch below.
      if (htmlBlockType(stripped) === 7 && /^<\/?[A-Za-z][^>]*>[ \t]*$/.test(stripped.trim()) &&
          endsWithOpenParagraph(cur.buf, true)) {
        cur.buf.push(BLK + stripped);
      } else {
        cur.buf.push(stripped);
      }
      cur.rawTail = line;
      j++;
      continue;
    }
    if (isHRLine(line)) break;
    const m = matchListMarker(line);
    if (m) {
      if (sameListType(m, first)) {
        startItem(m, j);
        j++;
        continue;
      }
      break;
    }
    // A table that starts after the item's paragraph is collected
    // into the item (header and delimiter together), and its rows
    // keep joining while the item's last block is that table.
    if (lastBlockIsTable(cur.buf) && leadInfo(line).cols < 4 && !tableRowBreak(line)) {
      cur.buf.push(line);
      cur.rawTail = line;
      j++;
      continue;
    }
    if (endsWithOpenParagraph(cur.buf, true) &&
        matchTableHeader(line, lines[j + 1] || '') !== null) {
      cur.buf.push(line);
      cur.buf.push(lines[j + 1]);
      cur.rawTail = lines[j + 1];
      j += 2;
      continue;
    }
    // When the item's last block is a quote that is closed (its final
    // inner line is blank, or its last inner block is not a paragraph),
    // a plain line still joins the item as a new block, but a link
    // reference definition ends the item.
    if ((quoteEndsBlank(cur.buf) || lastBlockIsClosedQuote(cur.buf)) && !/^[ ]{0,3}\[[^\]\n]*\]:/.test(line) &&
        !interruptsParagraph(line, lines[j + 1], true)) {
      cur.buf.push(line);
      cur.rawTail = line;
      j++;
      continue;
    }
    // A lone type-7 tag line after the item's paragraph becomes its
    // own HTML block inside the item, glued to the paragraph.
    if (endsWithOpenParagraph(cur.buf, true) && htmlBlockType(line) === 7 &&
        /^<\/?[A-Za-z][^>]*>[ \t]*$/.test(line.trim())) {
      cur.buf.push(BLK + line);
      cur.rawTail = line;
      j++;
      continue;
    }
    // Lazy continuation of the item's open paragraph. A line starting
    // with a fence run is never lazy here, even when the run could not
    // open a fence (backtick fence whose info contains a backtick).
    const liF = leadInfo(line);
    const fenceRun = liF.cols <= 3 && /^[`~]{3,}/.test(line.slice(liF.idx));
    if ((endsWithOpenParagraph(cur.buf, true) || lastBlockIsHtml(cur.buf)) && !lastLineDeep(cur.buf, cur.contentIndent) && !fenceRun &&
        !(cur.buf.length === 1 && prevBlocksLazy(cur.lazyPrev, cur.contentIndent)) &&
        !(quoteEndsBlank(cur.buf) && /^[ ]{0,3}\[[^\]\n]*\]:/.test(line)) &&
        !badFenceRun(cur.buf[cur.buf.length - 1] || '') &&
        !cur.qLazyTail && !((cur.buf[cur.buf.length - 1] || '').startsWith(QLAZY) && !line.startsWith(QLAZY) && !line.startsWith(LAZY)) && !interruptsParagraph(line, lines[j + 1], true)) {
      cur.buf.push(line.startsWith(LAZY) || line.startsWith(QLAZY) ? line : LAZY + line);
      j++;
      continue;
    }
    // Once the item holds a completed nested list, a plain line still
    // joins the item as a new block (marked keeps feeding the item
    // until a line that clearly belongs outside).
    if (lastBlockIsList(cur.buf) && !lastLineDeep(cur.buf, cur.contentIndent) && !matchListMarker(line) && !isHRLine(line) &&
        !fenceStart(line) && !fenceRun && !matchATX(line) && htmlBlockType(line) === 0 &&
        line[leadInfo(line).idx] !== '>' && !/^[ ]{0,3}\[[^\]\n]*\]:/.test(line)) {
      cur.buf.push(line);
      cur.rawTail = line;
      j++;
      continue;
    }
    break;
  }

  const finishItem = (children, pos, followedByBlank) => {
    // A paragraph that follows a nested list inside the item keeps
    // its <p> wrapper even in a tight list.
    let sawListChild = false;
    for (const child of children) {
      if (child.t === 'list') sawListChild = true;
      else if (sawListChild && child.t === 'paragraph') child.forceP = true;
    }
    // A paragraph ending on a deep line, immediately followed (no
    // blank line) by another block of the same item, keeps a trailing
    // newline in its rendered text: visible inside <p> in a loose
    // list, and as the block separator in a tight one.
    let ci = 0;
    for (let k = 0; k < pos.length; k++) {
      if (pos[k].def) continue;
      const child = children[ci++];
      if (!child || child.t !== 'paragraph' || !child.deepEnd) continue;
      const next = pos[k + 1];
      if (next && next.start === pos[k].end) child.trailNl = true;
    }
    void followedByBlank;
    let task = null;
    if (children.length && children[0].t === 'paragraph') {
      const txt = children[0].text;
      // The reference's task test: a checkbox marker, whitespace and
      // then a non-space — a lone marker is plain text, and ordered
      // items get checkboxes too.
      const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(txt);
      if (tm) {
        task = tm[1] !== ' ';
        children[0] = { ...children[0], text: txt.slice(tm[0].length) };
        if (children[0].text === '' && children.length === 1) children.shift();
      }
    }
    return { children, task };
  };
  const records = [];
  for (let ri = 0; ri < rawItems.length; ri++) {
    const raw = rawItems[ri];
    const buf = raw.buf;
    // marked trims the raw text of the list's LAST item before lexing
    // it: trailing blank lines and trailing spaces on its last line
    // never reach the output, whatever block they belong to. Earlier
    // items keep their trailing blank lines — the block parsers
    // decide what they mean there (an HTML block can keep one).
    if (ri === rawItems.length - 1) {
      while (buf.length && isBlankLine(buf[buf.length - 1])) buf.pop();
      if (buf.length) buf[buf.length - 1] = buf[buf.length - 1].replace(/[ \t]+$/, '');
    }
    const pos = [];
    const children = parseBlockLines(buf, defs, { eol: false, inItem: true, paraStrip: true }, pos);
    // The list is loose when two blocks of one item are separated by a
    // blank line at the item's own level (definitions count as blocks).
    if (!loose) {
      for (let k = 1; k < pos.length; k++) {
        let sep = false;
        for (let m = pos[k - 1].end; m < pos[k].start; m++) {
          if (isBlankLine(buf[m])) { sep = true; break; }
        }
        if (sep) { loose = true; break; }
      }
    }
    const item = finishItem(children, pos, raw.followedByBlank);
    // When the item is separated from the next item by exactly one
    // blank line, that newline belongs to this item's text: a final
    // paragraph ending on a deep (code-merged) line keeps it as a
    // trailing newline. Two or more blank lines trim it away (the
    // reference's ge() rule for code text).
    if (raw.followedByBlank && item.children.length) {
      let nb = 0;
      for (let b = buf.length - 1; b >= 0 && isBlankLine(buf[b]); b--) nb++;
      const last = item.children[item.children.length - 1];
      if (nb === 1 && last.t === 'paragraph' && last.deepEnd) last.trailNl = true;
    }
    records.push({ raw, buf, pos, item });
  }
  // In a loose list, an item followed by a blank line whose last block
  // is an HTML block keeps that block's trailing newline (types 1-5
  // read it from the container-eol flag, types 6-7 from eol): re-lex
  // those items with both flags set.
  if (loose) {
    for (const rec of records) {
      const ch = rec.item.children;
      if (!rec.raw.followedByBlank || !ch.length || ch[ch.length - 1].t !== 'html' || ch[ch.length - 1].ht > 5) continue;
      // When the item's buffer already ends with the blank line that
      // followed it, the first parse saw the trailing newline itself;
      // the container-eol re-lex would only double it.
      if (rec.buf.length && isBlankLine(rec.buf[rec.buf.length - 1])) continue;
      const pos2 = [];
      const children2 = parseBlockLines(rec.buf, defs, { eol: true, ceol: true, inItem: true, paraStrip: true }, pos2);
      rec.item = finishItem(children2, pos2, rec.raw.followedByBlank);
    }
  }
  const items = records.map((r) => r.item);
  return { token: { t: 'list', ordered: first.ordered, start: first.num, loose, items }, next: j };
}

// --- Paragraphs ---------------------------------------------------------------------

function interruptsParagraph(line, nextLine, inItem) {
  const { cols: ind, idx } = leadInfo(line);
  if (ind > 3) return false;
  if (fenceStart(line)) return true;
  if (matchATX(line)) return true;
  if (isHRLine(line)) return true;
  if (line[idx] === '>') return true;
  const lm = matchListMarker(line);
  // At the top level an ordered list interrupts only when it starts at
  // 1; inside a list item any ordered list interrupts.
  if (lm && !lm.blankItem && (!lm.ordered || lm.num === 1 || inItem)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  // A table delimiter row consists only of spaces, pipes, colons and
  // dashes; anything else in the next line rules a table out cheaply.
  if (nextLine !== undefined && !/[^\s|:+-]/.test(nextLine) && matchTableHeader(line, nextLine)) return true;
  return false;
}

function stripLazyPrefix(s) {
  let r = s;
  while (r.startsWith(LAZY) || r.startsWith(QLAZY)) r = r.slice(1);
  return unwrapExpd(r);
}

function collectParagraph(lines, i, inItem, paraStrip, tailOpen) {
  const firstLine = lines[i];
  // Paragraph text is the raw lines: leading spaces are content.
  const plines = [firstLine.startsWith(LAZY) || firstLine.startsWith(QLAZY) ? contentFrom(stripLazyPrefix(firstLine), Infinity) : unwrapExpd(firstLine)];
  // The same lines without the item paraStrip shaping, for setext text.
  const rawPlines = [plines[0]];
  // marked quirk (list items): a paragraph line sitting 4+ columns deep
  // "closes" the text flow — a following non-deep line is separated from
  // it by a blank line inside the paragraph text, and a paragraph ending
  // on a deep line carries a trailing newline into tight item rendering.
  let prevDeep = false;
  // Lazy lines lose 4 leading columns while they are "deep", but the
  // shaping stops for the rest of the paragraph once a non-deep lazy
  // line has appeared.
  let lazyShape = true;
  let j = i + 1;
  while (j < lines.length) {
    let L = lines[j];
    if (isBlankLine(L)) {
      // marked quirk: a whitespace-only final line that has no
      // terminating newline is paragraph content, not a blank line.
      if (tailOpen && j === lines.length - 1) { plines.push(L); rawPlines.push(L); prevDeep = false; j++; break; }
      // In a list item, a paragraph that already has a deep line runs on
      // across a blank line when the next non-blank line is deep too:
      // the blank becomes an empty line inside the paragraph text.
      if (paraStrip && prevDeep) {
        let k = j;
        while (k < lines.length && isBlankLine(lines[k])) k++;
        if (k < lines.length && !lines[k].startsWith(LAZY) && !lines[k].startsWith(QLAZY) &&
            !lines[k].startsWith(PAD) && !lines[k].startsWith(SOFT) &&
            leadInfo(lines[k]).cols >= 4) {
          for (let b = j; b < k; b++) { plines.push(''); rawPlines.push(''); }
          j = k;
          continue;
        }
      }
      break;
    }
    if (L.startsWith(BLK)) break;
    // Paragraphs flow across quote segment boundaries.
    if (L.startsWith(SEGB)) { j++; continue; }
    // A tab-run quote line used as content at this level takes its
    // expanded form (the raw form is only for nested-quote laziness).
    if (L.startsWith(EXPD)) L = unwrapExpd(L);
    if (L.startsWith(PAD)) {
      const t = '    ' + L.slice(1);
      plines.push(t);
      rawPlines.push(t);
      prevDeep = false;
      j++;
      continue;
    }
    if (L.startsWith(LAZY) || L.startsWith(QLAZY)) {
      // A lazy continuation line keeps its own leading spaces in the
      // paragraph text, except that a deep one (4+ columns) loses
      // exactly 4 while the paragraph is still in its shaping phase.
      // A non-deep lazy line ends that phase and, right after a deep
      // line, is separated from it by a blank line in the text.
      let t = stripLazyPrefix(L);
      if (leadInfo(t).cols >= 4) {
        if (lazyShape) {
          t = contentFrom(t, 4);
          prevDeep = true;
        } else prevDeep = false;
      } else {
        if (prevDeep) { plines.push(''); rawPlines.push(''); }
        prevDeep = false;
        // Only a quote-collected lazy line ends the shaping phase.
        if (L.startsWith(QLAZY)) lazyShape = false;
      }
      plines.push(t);
      rawPlines.push(t);
      j++;
      continue;
    }
    if (L.startsWith(SOFT)) { plines.push(L.slice(1)); rawPlines.push(L.slice(1)); j++; continue; }
    const su = isSetextUnderline(L);
    if (su) {
      // A setext heading's text loses its first line's indentation
      // (unlike a paragraph, which keeps it).
      const hlines = rawPlines.slice();
      hlines[0] = contentFrom(hlines[0], leadInfo(hlines[0]).cols);
      return { token: { t: 'heading', level: su, text: hlines.join('\n').replace(/[ \t]+$/, '') }, next: j + 1 };
    }
    if (interruptsParagraph(L, lines[j + 1], inItem)) break;
    const deep = paraStrip && leadInfo(L).cols >= 4;
    if (prevDeep && !deep) { plines.push(''); rawPlines.push(''); }
    prevDeep = deep;
    rawPlines.push(L);
    if (paraStrip && L.startsWith('    ')) {
      // marked quirk: a paragraph continuation line that sits 4+ columns
      // deep inside a list item loses exactly 4 of its spaces in the
      // rendered text (block structure still uses the original indent).
      plines.push(L.slice(4));
      j++;
      continue;
    }
    plines.push(L);
    j++;
  }
  const fl0 = (firstLine.startsWith(LAZY) || firstLine.startsWith(QLAZY)) ? stripLazyPrefix(firstLine) : firstLine;
  return { token: { t: 'paragraph', text: plines.join('\n'), deepEnd: prevDeep, forceP: false }, next: j };
}

// --- The block loop -------------------------------------------------------------------

function parseBlockLines(lines, defs, ctx, pos) {
  const tokens = [];
  const n = lines.length;
  let i = 0;
  // Block dispatch works on the expanded form of tab-run quote lines
  // (EXPD); only collectQuote sees the stored raw form, so a nested
  // quote can still recover it for lazy lines.
  let eff = lines;
  let blkCopied = false;
  if (expdCount > 0) {
    for (let q = 0; q < n; q++) {
      if (lines[q].charCodeAt(0) === 4) { eff = lines.map(unwrapExpd); break; }
    }
  }
  // The deep-line shaping of item paragraphs stops after a nested list
  // in the same container (marked re-lexes the rest of the item with
  // the sublist's indentation still in the text).
  let sawList = false;
  while (i < n) {
    const line = eff[i];
    if (isBlankLine(line) || line.startsWith(SOFT) || line.startsWith(SEGB)) { i++; continue; }
    if (line.startsWith(BLK)) {
      // Strip the marker on a private copy: heuristic parses (the
      // open-paragraph probes) share the caller's array and must not
      // strip it for the real parse.
      const un = line.slice(1);
      if (eff === lines) { eff = lines = lines.slice(); }
      else if (!blkCopied) { eff = eff.slice(); lines = lines.slice(); blkCopied = true; }
      eff[i] = un;
      lines[i] = un;
      continue;
    }
    const ind = leadInfo(line).cols;
    let r;
    if (ind <= 3 && (r = matchFence(eff, i))) { tokens.push(r.token); if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    if (ind <= 3 && (r = matchATX(line))) { tokens.push(r); if (pos) pos.push({ start: i, end: i + 1 }); i++; continue; }
    if (ind >= 4) { r = collectIndentedCode(eff, i); tokens.push(r.token); if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    if (isHRLine(line)) { tokens.push({ t: 'hr' }); if (pos) pos.push({ start: i, end: i + 1 }); i++; continue; }
    if (ind <= 3 && line[leadInfo(line).idx] === '>') { r = collectQuote(lines, i, defs, ctx); tokens.push(r.token); if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    if (ind <= 3 && (r = parseList(eff, i, defs, ctx))) { tokens.push(r.token); sawList = true; if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    if (ind <= 3 && (r = matchHtmlBlock(eff, i, ctx))) { tokens.push(r.token); if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    if (ind <= 3 && (r = tryParseDef(eff, i, defs))) { if (pos) pos.push({ start: i, end: r.next, def: 1 }); i = r.next; continue; }
    if (ind <= 3 && i + 1 < n && (r = matchTable(eff, i, ctx.tailOpen))) { tokens.push(r.token); if (pos) pos.push({ start: i, end: r.next }); i = r.next; continue; }
    r = collectParagraph(eff, i, ctx.inItem, ctx.paraStrip && !sawList, ctx.tailOpen);
    tokens.push(r.token);
    if (pos) pos.push({ start: i, end: r.next });
    i = r.next;
  }
  return tokens;
}

// --- Rendering ---------------------------------------------------------------------------

function renderBlocks(tokens, defs) {
  let out = '';
  for (const t of tokens) out += renderBlock(t, defs);
  return out;
}

function renderBlock(t, defs) {
  switch (t.t) {
    case 'paragraph':
      return '<p>' + renderInline(t.text, defs) + (t.trailNl ? '\n' : '') + '</p>\n';
    case 'heading':
      return '<h' + t.level + '>' + renderInline(t.text, defs) + '</h' + t.level + '>\n';
    case 'code':
      return '<pre><code' + (t.lang ? ' class="language-' + escapeAttr(t.lang) + '"' : '') + '>' +
        escapeCode(t.text) + '</code></pre>\n';
    case 'hr':
      return '<hr>\n';
    case 'html':
      return t.text;
    case 'quote':
      return '<blockquote>\n' + renderBlocks(t.children, defs) + '</blockquote>\n';
    case 'list':
      return renderList(t, defs);
    case 'table':
      return renderTable(t, defs);
  }
  return '';
}

function renderList(t, defs) {
  const tag = t.ordered ? 'ol' : 'ul';
  let out = '<' + tag + (t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : '') + '>\n';
  for (const item of t.items) {
    let body = '';
    item.children.forEach((child, ci) => {
      if (!t.loose && child.t === 'paragraph' && !child.forceP) {
        body += renderInline(child.text, defs);
        // A tight paragraph ending on a deep line is followed by a
        // newline before the next block (see collectParagraph).
        if (child.trailNl && ci < item.children.length - 1) body += '\n';
      } else {
        body += renderBlock(child, defs);
      }
    });
    if (item.task !== null) {
      const box = item.task
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      if (t.loose && body.startsWith('<p>')) {
        body = '<p>' + box + ' ' + body.slice(3);
      } else {
        body = box + (body ? ' ' + body : '');
      }
    }
    out += '<li>' + body + '</li>\n';
  }
  return out + '</' + tag + '>\n';
}

function renderTable(t, defs) {
  const cell = (tagName, align, content) =>
    '<' + tagName + (align ? ' align="' + align + '"' : '') + '>' + renderInline(content, defs) + '</' + tagName + '>';
  let out = '<table>\n<thead>\n<tr>\n';
  out += t.header.map((c, k) => cell('th', t.aligns[k], c)).join('\n');
  out += '\n</tr>\n</thead>\n';
  if (t.rows.length) {
    out += '<tbody>';
    for (const row of t.rows) {
      out += '<tr>\n' + row.map((c, k) => cell('td', t.aligns[k], c)).join('\n') + '\n</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  inlState = freshInlineState();
  expdCount = 0;
  // A trailing CR is a line terminator too: the empty segment after
  // it is not an unterminated whitespace line (see the tailOpen rule).
  const eol = src.endsWith('\n') || src.endsWith('\r');
  const norm = src.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  if (eol) lines.pop();
  const defs = new Map();
  const tokens = parseBlockLines(lines, defs, { eol, inItem: false, tailOpen: !eol });
  return renderBlocks(tokens, defs);
}

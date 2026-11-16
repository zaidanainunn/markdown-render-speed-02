// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Written for the make.fun
// markdown-render-speed-02 bounty. parse(markdown) returns, for every
// string, exactly the HTML that marked.parse(markdown) returns.
//
// Architecture (index-scanner, direct-to-HTML — no token tree):
//   * One global index cursor over the source. No split('\n') of the whole
//     document, no src.slice(pos) per block, no substring per token.
//   * Block layer: a line scanner. At each block start the first
//     non-space character (charCodeAt) decides which grammars can match,
//     so a paragraph start never pays for the code/fence/heading/hr/
//     blockquote/list/html/def attempts that cannot match there.
//   * Inline layer: plain-text spans are skipped with native indexOf()
//     (several native scans, take the minimum) instead of the giant
//     inlineText regex; regexes and special parsers run only after a
//     candidate delimiter is found. Emphasis closers are found by one
//     delimiter scan per inline run, as in marked.
//   * Link reference definitions are collected in the same block walk
//     that builds the frame list, so inline rendering (which runs after
//     the walk) resolves forward references. Frames hold a kind, source
//     offsets and the small data rendering needs — never a token tree.
//   * Rendering emits HTML straight into one output array.
//
// The grammar regexes below are marked 18.1.3's (MIT, github.com/markedjs
// /marked, tag v18.1.3), the reference the competition vendors in the kit;
// everything around them — the cursor scanner, the indexOf plain-text
// skipping, the frame walk, the direct renderer — is written here. The
// file is dependency-free and deterministic: no wall clock, no
// environment, no randomness, nothing kept between parse() calls.

const GR = {
  // ---- shared helpers ----
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // ---- block grammar (gfm) ----
  blockquote:
    /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  lheading:
    /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  newline: /^(?:[ \t]*(?:\n|$))+/,
  paragraph:
    /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
  table:
    /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  text: /^[^\n]+/,
  // ---- inline grammar (gfm) ----
  inlineBackpedal:
    /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode:
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  autolink:
    /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  blockSkip:
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  inlineCode: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim:
    /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  emStrongLDelim:
    /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst:
    /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd:
    /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  reflink:
    /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  reflinkSearch:
    /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
};

// ---- sticky block/inline grammars ----
// A sticky regex is the anchored grammar with the leading ^ dropped (the
// `y` flag anchors at lastIndex already), so exec() at a cursor is exactly
// the match the same grammar would give on the sliced remainder — without
// ever slicing.
function sticky(re) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), re.flags + 'y');
}
const S = {
  newline: sticky(GR.newline),
  code: sticky(GR.code),
  fences: sticky(GR.fences),
  heading: sticky(GR.heading),
  hr: sticky(GR.hr),
  blockquote: sticky(GR.blockquote),
  list: sticky(GR.list),
  html: sticky(GR.html),
  def: sticky(GR.def),
  table: sticky(GR.table),
  lheading: sticky(GR.lheading),
  paragraph: sticky(GR.paragraph),
  blockText: sticky(GR.text),
  escape: sticky(GR.escape),
  tag: sticky(GR.tag),
  link: sticky(GR.link),
  reflink: sticky(GR.reflink),
  nolink: sticky(GR.nolink),
  emStrongLDelim: sticky(GR.emStrongLDelim),
  inlineCode: sticky(GR.inlineCode),
  br: sticky(GR.br),
  delLDelim: sticky(GR.delLDelim),
  autolink: sticky(GR.autolink),
  url: sticky(GR.url),
};

// Run a sticky grammar at cursor `pos` in `src`; null when it cannot match.
function at(re, src, pos) {
  re.lastIndex = pos;
  return re.exec(src);
}

// ---- indent-parameterized block helpers ----
// The cache holds at most the four indent levels 0..3. The level a helper
// is BUILT with is the clamped level, not the requested one: a request for
// indent 3 builds the {0,2} form, a request for 5 builds {0,3}. That is
// what makes a three-space-indented sub-list belong to its parent item
// instead of starting a sibling item (CommonMark example 9 and friends).
function memoIndent(fn) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = fn(k));
  };
}
const BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
// The list-item regex, prebuilt for the five possible bullets instead of
// compiled fresh for every list: `*`, `+`, `-`, and ordered `1.` / `1)`.
const ITEM_RE = {
  '*': /^( {0,3}\*)((?:[\t ][^\n]*)?(?:\n|$))/,
  '+': /^( {0,3}\+)((?:[\t ][^\n]*)?(?:\n|$))/,
  '-': /^( {0,3}\-)((?:[\t ][^\n]*)?(?:\n|$))/,
  '.': /^( {0,3}\d{1,9}\.)((?:[\t ][^\n]*)?(?:\n|$))/,
  ')': /^( {0,3}\d{1,9}\))((?:[\t ][^\n]*)?(?:\n|$))/,
};
// Sticky forms of the item regexes, for matching at a cursor without
// slicing the remaining list source.
function stickyItem(re) {
  return new RegExp(re.source.replace(/(^|\|)\^/g, '$1'), re.flags + 'y');
}
const ITEM_S = {
  '*': stickyItem(ITEM_RE['*']),
  '+': stickyItem(ITEM_RE['+']),
  '-': stickyItem(ITEM_RE['-']),
  '.': stickyItem(ITEM_RE['.']),
  ')': stickyItem(ITEM_RE[')']),
};
const nextBulletRegex = memoIndent(
  (a) =>
    new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
);
const hrRegex = memoIndent(
  (a) =>
    new RegExp(
      `^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
    ),
);
const fencesBeginRegex = memoIndent(
  (a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`),
);
const headingBeginRegex = memoIndent(
  (a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`),
);
const htmlBeginRegex = memoIndent(
  (a) =>
    new RegExp(
      `^ {0,${a}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
);
const blockquoteBeginRegex = memoIndent((a) => new RegExp(`^ {0,${a}}>`));

// ---- small string helpers (marked's helpers, written out) ----
const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function isWordChar(c) {
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}
function isHexChar(c) {
  const code = c.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}
// True when s[i] ('&') starts a valid entity reference, mirroring the
// negative lookahead in escapeTestNoEncode: &#1-7 digits; &#x 1-6 hex; &word;
function isEntityStart(s, i) {
  if (s[i] !== '&') return false;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      let n = 0;
      while (j < s.length && isHexChar(s[j]) && n < 6) { j++; n++; }
      return n > 0 && s[j] === ';';
    }
    let n = 0;
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && n < 7) { j++; n++; }
    return n > 0 && s[j] === ';';
  }
  let n = 0;
  while (j < s.length && isWordChar(s[j])) { j++; n++; }
  return n > 0 && s[j] === ';';
}
// Escape HTML. encode=true escapes & always; encode=false leaves valid
// entity references alone. A manual scan instead of a regex replace with a
// callback: the fast path (no special char for the mode) returns the string
// untouched.
function esc(s, encode) {
  if (encode) {
    if (!GR.escapeTest.test(s)) return s;
  } else if (!GR.escapeTestNoEncode.test(s)) {
    return s;
  }
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (encode || !isEntityStart(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Decode numeric character references; a bare & (not part of any entity)
// becomes &amp;. Only runs the replace when a numeric reference is present
// (the later esc() pass handles any bare & that is left).
function unescape(s) {
  if (!GR.numericCharacterReference.test(s)) return s;
  return s.replace(
    GR.numericCharacterReferenceOrAmpersand,
    (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
      if (n === 38) return '&amp;';
      return String.fromCodePoint(n);
    },
  );
}
// True when `s` ends with a double blank line: a newline, optional
// spaces/tabs, another newline, optional trailing spaces/tabs. (The same
// answer `/\n[ \t]*\n[ \t]*$/.test(s)` gives, without a regex scan over
// the whole item text on every list item.)
function endsDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}
// Sanitize a URL for href/src: encodeURI, keeping % as %, else null.
// (marked does not block javascript:/data: schemes; neither do we.)
function cleanUrl(a) {
  try {
    // encodeURI only produces %25 from a literal % in the input, so when
    // the input has no % the undo-replace below is a no-op: skip its scan.
    if (!a.includes('%')) return encodeURI(a);
    return encodeURI(a).replace(GR.percentDecode, '%');
  } catch {
    return null;
  }
}
// Split one table row on unescaped pipes, trimming cells. A pipe counts as
// a separator unless an odd run of backslashes escapes it; code spans do
// not protect a pipe (that is marked's behaviour, quirks included).
function splitCells(row, count) {
  const t = row.replace(GR.findPipe, (ch, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\'; ) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(GR.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count; ) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(GR.slashPipe, '|');
  return cells;
}
// Trim trailing char `c` (or, when invert, trailing chars that are not `c`).
function rtrim(a, c, invert) {
  let i = a.length;
  if (invert) {
    while (i > 0 && a[i - 1] !== c) i--;
  } else {
    while (i > 0 && a[i - 1] === c) i--;
  }
  return a.slice(0, i);
}
// Indented code: drop trailing blank lines, keeping at most two newlines.
function stripTrailingBlankLines(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && GR.blankLine.test(lines[t]); ) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}
// Normalize a link reference label: trim, collapse whitespace, Unicode fold.
function normLabel(a) {
  return a
    .trim()
    .replace(GR.multipleSpaceGlobal, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}
// Find the index of the closing bracket matching the opener at the start of
// `a` (pair is "()" or "[]"); -2 when unbalanced-open, -1 when not found.
function findClosingBracket(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '\\') i++;
    else if (a[i] === pair[0]) depth++;
    else if (a[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to spaces on a 4-column grid, starting at column `offset`.
function expandTabs(a, offset = 0) {
  let col = offset;
  let out = '';
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (ch === '\t') {
      const pad = 4 - (col % 4);
      out += '    '.slice(0, pad);
      col += pad;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
// Number of Unicode code points in `s` (the same number
// `[...s].length` gives, without allocating the array). Used on short
// delimiter runs, where the spread was a per-attempt allocation.
function cpLen(s) {
  let n = 0;
  for (const _ch of s) n++;
  return n;
}
// The last code point of `s` as a string (the same string
// `[...s].at(-1) ?? ''` gives, without allocating the array). A trailing
// low surrogate belongs to the code point before it.
function lastCodePoint(s) {
  if (s.length === 0) return '';
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xdc00 && c <= 0xdfff && s.length > 1) return s.slice(-2);
  return s.slice(-1);
}
// Fenced code: remove the fence indent from each line of the content.
function indentCodeComp(fence, code) {
  const m = fence.match(GR.indentCodeCompensation);
  if (m === null) return code;
  const indent = m[1];
  return code
    .split('\n')
    .map((line) => {
      const lead = line.match(GR.beginningSpace);
      if (lead === null) return line;
      const [spaces] = lead;
      return line.slice(Math.min(spaces.length, indent.length));
    })
    .join('\n');
}
// The first line of `s` (the same string `s.split('\n', 1)[0]` gives,
// without allocating the split array).
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}
// Index of the first character of `s` that is not a space, or -1 when the
// string is all spaces (the same answer `s.search(/[^ ]/)` gives, without
// a regex exec per call).
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') return i;
  return -1;
}
// Column of the first character of `s` that is not a space or a tab (a tab
// counts as 4 columns, the way `s.replace(/\t/g, '    ')` counts it), or
// -1 when the string is all spaces and tabs. (The same answer
// `s.replace(/\t/g, '    ').search(/[^ ]/)` gives, without the replace and
// the regex exec.)
function firstNonSpaceCol(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4;
    else return col;
  }
  return -1;
}
// Expand the leading spaces/tabs of `line` the way marked does: a tab goes
// to the next 4-column stop starting at column `offset`, a space counts 1.
// (The same string `line.replace(/^[ \t]+/, v => expandTabs(v, offset))`
// gives, without a regex exec and a callback per line.)
function expandLeading(line, offset = 0) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i === 0) return line;
  let col = offset;
  let out = '';
  for (let j = 0; j < i; j++) {
    if (line[j] === '\t') {
      const pad = 4 - (col % 4);
      out += '    '.slice(0, pad);
      col += pad;
    } else {
      out += ' ';
      col++;
    }
  }
  return out + line.slice(i);
}


// ---- delimiter masking for emphasis scanning ----
// Scan `src` once for the last delimiter run of each kind that could close
// an emphasis span: a run whose preceding character is not whitespace.
// Returns the same shape marked's fe() returns. (Called on the MASKED
// source, where link texts and code spans are already blanked, so their
// delimiters cannot close.)
function scanDelims(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  // Fast path: no emphasis/delimiter character at all — nothing to record.
  // (Three native indexOf scans beat a per-character loop on plain text.)
  if (src.indexOf('*') === -1 && src.indexOf('_') === -1 && src.indexOf('~') === -1) {
    return { maskedSrc: src, lastEm, lastDel };
  }
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const r = src[i];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === r; ) j++;
    // The recorded index is the run's START (marked's fe() assigns before
    // advancing past the run); it bounds how far the closer search may go.
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = i;
      else lastEm[r] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}
// The masked source used while scanning for emphasis closers: link texts
// and code spans are blanked out (length preserved) so their * _ ~ cannot
// close an emphasis span that starts outside them.
//
// Fast path: the three replaces below can only change a string that
// contains a link bracket, a backtick, a backslash escape, or a tag
// opener. anyPunctuationOutsideCode needs a backtick or a backslash, and
// blockSkip needs `[`, a backtick, or `<` (the reflinkSearch part is
// already guarded by `[`). With none of the four present every replace is
// the identity, so return the string untouched instead of running two
// full-source regex scans over a plain emphasis paragraph.
function blankLinksAndCode(state, src) {
  if (
    !src.includes('[') &&
    !src.includes('`') &&
    !src.includes('\\') &&
    !src.includes('<')
  )
    return src;
  let t = src;
  if (state.links && src.includes('[')) {
    const re = GR.reflinkSearch;
    const replaceRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(state.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (hasLinkInText(state, inner))
          return (
            '[' + inner.replace(re, replaceRef) + '][' + 'a'.repeat(r.length - o - 2) + ']'
          );
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(re, replaceRef);
  }
  // Each masking replace runs only when its trigger characters are present
  // in the string it operates on: anyPunctuationOutsideCode needs a
  // backtick or a backslash, blockSkip needs `[`, a backtick, or `<`.
  // Otherwise the replace is the identity, so skip the full-source scan
  // for it (a paragraph with emphasis and a link but no code span or
  // escape skips the first replace; one with emphasis and an escape but
  // no link, code span, or tag skips the second).
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(GR.anyPunctuationOutsideCode, (whole, codeSpan, escPunct) =>
      escPunct
        ? '+'.repeat(whole.length)
        : codeSpan
          ? codeSpan +
            whole.slice(codeSpan.length, -codeSpan.length).replace(/`/g, '+') +
            codeSpan
          : whole,
    );
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(GR.blockSkip, (whole, _g1, codeSpan) => {
      const o = codeSpan ? codeSpan.length : 0;
      return whole.slice(0, o) + '[' + 'a'.repeat(whole.length - o - 2) + ']';
    });
  }
  return t;
}
// True when `text` contains a link (a [...] that the link regex accepts and
// is not an image), ignoring code spans and tags. The reflinkSearch loop is
// the part that matters for nested references: a defined, non-image
// reference link whose inner text has no link of its own still counts, so
// the outer span is masked (CommonMark example 533).
function hasLinkInText(state, text) {
  if (!text.includes('[')) return false;
  const linkRe = GR.link;
  for (const m of text.matchAll(GR.blockSkip)) {
    if (linkRe.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(GR.reflinkSearch)) {
    const s2 = m[0];
    const r = s2.lastIndexOf('[');
    if (
      !(
        s2.charAt(0) === '!' ||
        !Object.hasOwn(state.links, normLabel(s2.slice(r + 1, -1)))
      ) &&
      !(r > 1 && hasLinkInText(state, s2.slice(1, r - 1)))
    )
      return true;
  }
  return false;
}
// True when a link's text contains a `<` that starts a tag/autolink, or a
// code span, before the end of the text: such a link is not a link at all.
function linkTextHasTagOrCode(src, text, offset) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      const m = at(S.inlineCode, text, i);
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (text[i] !== '<') continue;
    const tag = at(S.tag, src, offset + i) || at(S.autolink, src, offset + i);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// True when any of the block-interrupt grammars in `re` can match `line`.
// Every one of them is anchored `^ {0,a}...` with `a` the clamped indent
// level, so the first non-space character decides which of them can
// possibly match: a line whose first non-space character is anything else
// — or sits past `a` spaces, or is a tab — matches none of them. This
// turns up to six regex execs per list-item line into a short scan plus at
// most two. `re` holds whichever of fences/heading/html/quote/nextBullet/
// hr the caller needs; an absent one is simply never matched. (All six
// regexes are flagless, so .test() is pure and the order of the original
// || chain does not matter.)
function lineInterrupts(line, a, re) {
  let sp = 0;
  while (sp < line.length && line[sp] === ' ') sp++;
  if (sp > a || sp >= line.length) return false;
  const c = line[sp];
  switch (c) {
    case '`':
    case '~':
      return !!re.fences && re.fences.test(line);
    case '#':
      return !!re.heading && re.heading.test(line);
    case '<':
      return !!re.html && re.html.test(line);
    case '>':
      return !!re.quote && re.quote.test(line);
    case '*':
      return (!!re.nextBullet && re.nextBullet.test(line)) || (!!re.hr && re.hr.test(line));
    case '+':
      return !!re.nextBullet && re.nextBullet.test(line);
    case '-':
      return (!!re.nextBullet && re.nextBullet.test(line)) || (!!re.hr && re.hr.test(line));
    case '_':
      return !!re.hr && re.hr.test(line);
    default:
      return !!re.nextBullet && c >= '0' && c <= '9' && re.nextBullet.test(line);
  }
}


// ---- inline rendering (fused tokenize + render) ----
// The plain-text scanner: the fastest path through inline content. It
// finds where the current plain-text span ends using only native indexOf()
// scans (several native scans, take the minimum) — never a per-character
// JS loop and never the giant inlineText regex. It returns the index where
// the span ends, or `pos` when a handler must run at `pos` itself.
//
// A span ends at the earliest of:
//   * a sentinel character: ` \ [ < ! * ~ _  (backtick, bracket, tag,
//     escape, image-bang, emphasis, strikethrough, underscore)
//   * two or more spaces before a newline (a hard break)
//   * `www.` (preceded by whitespace, *, _, ~ or (, and followed by a
//     domain character), `mailto:` / `xmpp:` (preceded by a
//     non-alphanumeric), or a scheme `://` (http/https/ftp, followed by a
//     domain character) — the starts of extended autolinks
//   * the start of an email-like run (word characters ending in @, with a
//     dot in the domain — otherwise it cannot be an autolink and the span
//     runs straight through it)
// These are exactly the positions marked's inlineText regex stops at; a
// span that ran past one of them would swallow a token. Anything else
// (including a lone `http` without `://`, or an @ without a dotted domain)
// is plain text either way, so the span need not stop for it.
function isEmailCharCode(c) {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 ||
    c === 45
  );
}
function isDomainCharCode(c) {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 45 || c === 95
  );
}
function isAlnumCode(c) {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122)
  );
}
function scanPlain(src, pos) {
  const end = src.length;
  let stop = end;
  // Sentinel characters (single native scans).
  let i = src.indexOf('`', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('[', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('<', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('\\', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('!', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('*', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('~', pos);
  if (i !== -1 && i < stop) stop = i;
  i = src.indexOf('_', pos);
  if (i !== -1 && i < stop) stop = i;
  // Two or more spaces before a newline: the span ends at the first space
  // of the FIRST such run. The old text regex stops at (?= {2,}\n) at any
  // position, so every newline must be checked — a plain \n earlier in the
  // span must not hide a hard break on a later line.
  {
    let nlFrom = pos;
    for (;;) {
      const nl = src.indexOf('\n', nlFrom);
      if (nl === -1 || nl >= stop) break;
      let s = nl;
      while (s > pos && src[s - 1] === ' ') s--;
      if (nl - s >= 2) {
        if (s < stop) stop = s;
        break;
      }
      nlFrom = nl + 1;
    }
  }
  // www. — preceded by whitespace, *, _, ~ or (, followed by a domain char.
  let from = pos;
  for (;;) {
    const j = src.indexOf('www.', from);
    if (j === -1 || j >= stop) break;
    const prev = j === 0 ? 32 : src.charCodeAt(j - 1);
    const after = src.charCodeAt(j + 4);
    if (
      (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11 ||
        prev === 42 || prev === 95 || prev === 126 || prev === 40) &&
      isDomainCharCode(after)
    ) {
      stop = j;
      break;
    }
    from = j + 1;
  }
  // mailto: / xmpp: — preceded by a non-alphanumeric (or start). EXCEPT
  // when the preceding char is part of a `~` / backtick run of length 2+:
  // marked's text regex consumes such a run as its first unit, so the
  // mailto:/xmpp: stop never fires there — the text runs on to the email
  // stop instead (e.g. "~~a *b*~~xmpp:a@b.co" renders "~~xmpp:" as text
  // plus an "a@b.co" email link, not an xmpp: autolink).
  for (let w = 0; w < 2; w++) {
    const word = w === 0 ? 'mailto:' : 'xmpp:';
    let f = pos;
    for (;;) {
      const j = src.indexOf(word, f);
      if (j === -1 || j >= stop) break;
      const pc = j === 0 ? -1 : src.charCodeAt(j - 1);
      const inRun = (pc === 126 || pc === 96) && j >= 2 && src.charCodeAt(j - 2) === pc;
      if (j === 0 || (!isAlnumCode(pc) && !inRun)) {
        stop = j;
        break;
      }
      f = j + 1;
    }
  }
  // scheme:// — http, https or ftp immediately before ://, domain char after.
  {
    let f = pos;
    for (;;) {
      const j = src.indexOf('://', f);
      if (j === -1 || j >= stop) break;
      let schemeStart = -1;
      const c4 = src.slice(j - 4, j).toLowerCase();
      const c5 = src.slice(j - 5, j).toLowerCase();
      const c3 = src.slice(j - 3, j).toLowerCase();
      if (c4 === 'http') schemeStart = j - 4;
      else if (c5 === 'https') schemeStart = j - 5;
      else if (c3 === 'ftp') schemeStart = j - 3;
      if (schemeStart >= pos && isDomainCharCode(src.charCodeAt(j + 3))) {
        stop = schemeStart;
        break;
      }
      f = j + 1;
    }
  }
  // Email-like run: word characters ending in @, with a dot in the domain.
  // The span ends at the run's start (the dispatch then tries the autolink).
  {
    let f = pos;
    for (;;) {
      const j = src.indexOf('@', f);
      if (j === -1 || j >= stop) break;
      let s = j;
      while (s > pos && isEmailCharCode(src.charCodeAt(s - 1))) s--;
      // The domain must contain a dot, or this @ can never start an
      // autolink: skip it and look for the next @.
      let hasDot = false;
      let k = j + 1;
      while (k < end && (isDomainCharCode(src.charCodeAt(k)) || src.charCodeAt(k) === 46)) {
        if (src.charCodeAt(k) === 46) hasDot = true;
        k++;
      }
      if (hasDot) {
        if (s < stop) stop = s;
        break;
      }
      f = j + 1;
    }
  }
  return stop;
}

// Stop-list regexes for buildStops (module-level, reset per use).
const SENTINEL_RE = /[`[<\\!*~_]/g;
const HARDBREAK_RE = / {2,}\n/g;

// buildStops collects EVERY position where a plain-text span must end, in
// one pass per pattern family, and returns them sorted. It applies exactly
// scanPlain's stop rules, but for the whole string at once: a long inline
// string (a document paragraph) is then walked with a pointer instead of
// re-scanning the remainder from every span start — scanPlain is O(spans
// x string), this is O(string + spans). Only worth it for long strings;
// short ones keep scanPlain (no allocation).
function buildStops(src) {
  const stops = [];
  const end = src.length;
  SENTINEL_RE.lastIndex = 0;
  let m;
  while ((m = SENTINEL_RE.exec(src)) !== null) stops.push(m.index);
  HARDBREAK_RE.lastIndex = 0;
  while ((m = HARDBREAK_RE.exec(src)) !== null) stops.push(m.index);
  let from = 0;
  for (;;) {
    const j = src.indexOf('www.', from);
    if (j === -1) break;
    const prev = j === 0 ? 32 : src.charCodeAt(j - 1);
    if (
      (prev === 32 || prev === 9 || prev === 10 || prev === 13 || prev === 12 || prev === 11 ||
        prev === 42 || prev === 95 || prev === 126 || prev === 40) &&
      isDomainCharCode(src.charCodeAt(j + 4))
    ) {
      stops.push(j);
    }
    from = j + 1;
  }
  for (let w = 0; w < 2; w++) {
    const word = w === 0 ? 'mailto:' : 'xmpp:';
    let f = 0;
    for (;;) {
      const j = src.indexOf(word, f);
      if (j === -1) break;
      // Same run exclusion as scanPlain: a ~/` run of length 2+ before
      // the scheme swallows the stop (see scanPlain).
      const pc = j === 0 ? -1 : src.charCodeAt(j - 1);
      const inRun = (pc === 126 || pc === 96) && j >= 2 && src.charCodeAt(j - 2) === pc;
      if (j === 0 || (!isAlnumCode(pc) && !inRun)) stops.push(j);
      f = j + 1;
    }
  }
  {
    let f = 0;
    for (;;) {
      const j = src.indexOf('://', f);
      if (j === -1) break;
      let schemeStart = -1;
      const c4 = src.slice(j - 4, j).toLowerCase();
      const c5 = src.slice(j - 5, j).toLowerCase();
      const c3 = src.slice(j - 3, j).toLowerCase();
      if (c4 === 'http') schemeStart = j - 4;
      else if (c5 === 'https') schemeStart = j - 5;
      else if (c3 === 'ftp') schemeStart = j - 3;
      if (schemeStart >= 0 && isDomainCharCode(src.charCodeAt(j + 3))) stops.push(schemeStart);
      f = j + 1;
    }
  }
  {
    let f = 0;
    for (;;) {
      const j = src.indexOf('@', f);
      if (j === -1) break;
      let s = j;
      while (s > 0 && isEmailCharCode(src.charCodeAt(s - 1))) s--;
      let hasDot = false;
      let k = j + 1;
      while (k < end && (isDomainCharCode(src.charCodeAt(k)) || src.charCodeAt(k) === 46)) {
        if (src.charCodeAt(k) === 46) hasDot = true;
        k++;
      }
      if (hasDot) stops.push(s);
      f = j + 1;
    }
  }
  stops.sort((a, b) => a - b);
  return stops;
}

// renderInline renders `src` into the string array `out`. `plain` selects
// plain-text rendering (used for image alt text) instead of HTML. It is the
// fused form of marked's Lexer#inlineTokens + Parser#parseInline: no inline
// token objects are allocated, and the first-character dispatch below skips
// the tokenizers that cannot match at the current position. Plain-text
// spans are skipped by scanPlain (native indexOf) instead of the giant
// inlineText regex.
// `st` is the per-parse state: links, inLink, inRawBlock, linkEmitted,
// linkParenPossible, top, maskStack.
function renderInline(st, src, plain, out) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  const masked =
    src.includes('*') || src.includes('_') || src.includes('~')
      ? blankLinksAndCode(st, src)
      : src;
  st.maskStack.push(scanDelims(masked));
  // Long strings: precompute the stop list once and walk it with a
  // pointer (nextStop), instead of re-scanning from every span start.
  // The pointer only moves forward, because pos never moves backward.
  const stops = src.length > 96 ? buildStops(src) : null;
  let stopPtr = 0;
  const nextStop = (p) => {
    if (stops === null) return scanPlain(src, p);
    while (stopPtr < stops.length && stops[stopPtr] < p) stopPtr++;
    return stopPtr < stops.length ? stops[stopPtr] : src.length;
  };
  try {
    let pos = 0;
    let prevText = false;
    let prevChar = '';
    let lastPos = -1;
    const n = src.length;
    while (pos < n) {
      if (pos === lastPos) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      lastPos = pos;
      if (!prevText) prevChar = '';
      prevText = false;
      const c = src.charCodeAt(pos);
      let adv = 0;
      if (c === 92) {
        // backslash: escape, or a backslash hard break
        adv = hEscape(src, pos, out, plain) || hBr(src, pos, out, plain);
      } else if (c === 60) {
        // <: inline tag, or an autolink
        adv = hTag(st, src, pos, out, plain) || hAutolink(src, pos, out, plain);
      } else if (c === 91) {
        // [: inline link, or a reference link
        adv = hLink(st, src, pos, out, plain) || hReflink(st, src, pos, out, plain);
      } else if (c === 33) {
        // !: an image (inline link with a ! prefix, or a reference image)
        adv = hLink(st, src, pos, out, plain) || hReflink(st, src, pos, out, plain);
      } else if (c === 42 || c === 95) {
        // * or _: emphasis; _ can also start an email autolink
        adv =
          hEmStrong(st, src, pos, masked, prevChar, out, plain) ||
          (c === 95 && !st.inLink ? hUrl(src, pos, out, plain) : 0);
      } else if (c === 96) {
        // `: code span
        adv = hCodespan(src, pos, out, plain);
      } else if (c === 126) {
        // ~: strikethrough
        adv = hDel(st, src, pos, masked, prevChar, out, plain);
      } else if (c === 32) {
        // space: a hard break is two or more spaces before a newline
        adv = hBr(src, pos, out, plain);
      } else if (
        !st.inLink &&
        ((c >= 48 && c <= 57) ||
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          c === 46 ||
          c === 43 ||
          c === 45)
      ) {
        // alphanumerics and . + - can start an extended autolink (www, http, email)
        adv = hUrl(src, pos, out, plain);
      }
      if (adv === 0) {
        // Plain text up to the next candidate delimiter. When no handler
        // matched at this position, exactly one source unit is emitted as
        // text (a lone `!`, `_`, `*`, `~`, `www.` or email-like run that
        // turned out not to be a token) and scanning resumes after it.
        const spanEnd = nextStop(pos);
        if (spanEnd > pos) {
          const raw = src.slice(pos, spanEnd);
          const inRaw = st.inRawBlock;
          const text = inRaw ? raw : unescape(raw);
          if (plain) out.push(text);
          else out.push(inRaw ? text : esc(text));
          adv = raw.length;
          prevText = true;
          if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        } else {
          // A stop sits at pos and the handler failed: emit the first
          // text unit (a backtick/tilde run, or one char) and continue
          // the span to the next stop — matching marked's inlineText,
          // which consumes the delimiter run as its first unit. Emitting
          // a single char here would expose a spurious codespan at the
          // next backtick (e.g. "```foo``" must stay literal).
          let unitEnd = pos + 1;
          const cc = src.charCodeAt(pos);
          if (cc === 96 || cc === 126) {
            while (unitEnd < n && src.charCodeAt(unitEnd) === cc) unitEnd++;
          }
          const spanEnd = unitEnd < n ? nextStop(unitEnd) : unitEnd;
          const raw = src.slice(pos, spanEnd);
          const inRaw = st.inRawBlock;
          const text = inRaw ? raw : unescape(raw);
          if (plain) out.push(text);
          else out.push(inRaw ? text : esc(text));
          adv = raw.length;
          prevText = true;
          if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        }
      }
      pos += adv;
    }
  } finally {
    st.maskStack.pop();
    st.linkParenPossible = savedParen;
  }
}

// Backslash escape: \X renders as the punctuation character X itself.
function hEscape(src, pos, out, plain) {
  const m = at(S.escape, src, pos);
  if (!m) return 0;
  out.push(plain ? m[1] : esc(m[1]));
  return m[0].length;
}

// Inline HTML tag. Updates the inLink / inRawBlock state exactly as marked's
// tag tokenizer does; the tag itself is emitted verbatim.
function hTag(st, src, pos, out, plain) {
  const m = at(S.tag, src, pos);
  if (!m) return 0;
  if (!st.inLink && GR.startATag.test(m[0])) st.inLink = true;
  else if (st.inLink && GR.endATag.test(m[0])) st.inLink = false;
  if (!st.inRawBlock && GR.startPreScriptTag.test(m[0])) st.inRawBlock = true;
  else if (st.inRawBlock && GR.endPreScriptTag.test(m[0])) st.inRawBlock = false;
  out.push(m[0]);
  return m[0].length;
}

// Two-space (or backslash) hard break before a newline.
function hBr(src, pos, out, plain) {
  const m = at(S.br, src, pos);
  if (!m) return 0;
  if (!plain) out.push('<br>');
  return m[0].length;
}

// Code span: backticks, newlines become spaces, one space stripped from each
// end when the content is padded on both sides.
function hCodespan(src, pos, out, plain) {
  const m = at(S.inlineCode, src, pos);
  if (!m) return 0;
  let text = m[2].replace(GR.newLineCharGlobal, ' ');
  const hasNonSpace = GR.nonSpaceChar.test(text);
  const padded = GR.startingSpaceChar.test(text) && GR.endingSpaceChar.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  if (plain) out.push(text);
  else out.push('<code>' + esc(text, true) + '</code>');
  return m[0].length;
}


// Inline link or image [text](href "title"), with marked's exact validity
// checks (angle-bracket hrefs, balanced parens, unescaped closing paren).
function hLink(st, src, pos, out, plain) {
  if (st.linkParenPossible === false) return 0;
  const m = at(S.link, src, pos);
  if (!m) return 0;
  const n = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasTagOrCode(src, m[1], pos + n)) return 0;
  const url = m[2].trim();
  if (GR.startAngleBracket.test(url)) {
    if (!GR.endAngleBracket.test(url)) return 0;
    const stripped = rtrim(url.slice(0, -1), '\\');
    if ((url.length - stripped.length) % 2 === 0) return 0;
  } else {
    const close = findClosingBracket(m[2], '()');
    if (close === -2) return 0;
    if (close > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return 0;
  let href = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (GR.startAngleBracket.test(href)) href = href.slice(1, -1);
  href = href && href.replace(GR.anyPunctuation, '$1');
  return renderLink(st, m, href, title && title.replace(GR.anyPunctuation, '$1'), out, plain);
}

// Reference link [text][label] or shortcut [text]. When the label has no
// definition, only the first character is emitted as literal text.
function hReflink(st, src, pos, out, plain) {
  const m = at(S.reflink, src, pos) || at(S.nolink, src, pos);
  if (!m) return 0;
  const n = m[0].charAt(0) === '!' ? 2 : 1;
  if (linkTextHasTagOrCode(src, m[1], pos + n)) return 0;
  const ref = st.links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    out.push(plain ? ch : esc(ch));
    return 1;
  }
  return renderLink(st, m, ref.href, ref.title, out, plain);
}

// Render a link or image token: the link text is rendered recursively (in
// plain-text mode for an image's alt text), with marked's nested-link rule:
// a link whose text itself contains a link is not a link at all.
function renderLink(st, m, href, title, out, plain) {
  const isImage = m[0].charAt(0) === '!';
  const text = m[1].replace(GR.outputLinkReplace, '$1');
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = [];
  renderInline(st, text, isImage ? true : plain, inner);
  const emitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      st.inRawBlock = savedRaw;
      return 0;
    }
    st.linkEmitted = true;
  }
  const innerStr = inner.join('');
  if (isImage) {
    if (plain) {
      out.push(innerStr);
      return m[0].length;
    }
    const url = cleanUrl(href);
    if (url === null) {
      out.push(esc(innerStr));
      return m[0].length;
    }
    let tag = '<img src="' + esc(url) + '" alt="' + esc(innerStr) + '"';
    if (title) tag += ' title="' + esc(title) + '"';
    out.push(tag + '>');
    return m[0].length;
  }
  if (plain) {
    out.push(innerStr);
    return m[0].length;
  }
  const url = cleanUrl(href);
  if (url === null) {
    out.push(innerStr);
    return m[0].length;
  }
  let tag = '<a href="' + esc(url) + '"';
  if (title) tag += ' title="' + esc(title) + '"';
  out.push(tag + '>' + innerStr + '</a>');
  return m[0].length;
}

// Autolink <scheme:...> or <email>.
function hAutolink(src, pos, out, plain) {
  const m = at(S.autolink, src, pos);
  if (!m) return 0;
  let text, href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  if (plain) {
    out.push(text);
    return m[0].length;
  }
  const url = cleanUrl(href);
  if (url === null) {
    out.push(esc(text, true));
    return m[0].length;
  }
  out.push('<a href="' + esc(url, true) + '">' + esc(text, true) + '</a>');
  return m[0].length;
}

// Extended autolink (GFM): bare www. / http(s) / ftp URLs and email
// addresses. Trailing punctuation is backpedalled off the match.
function hUrl(src, pos, out, plain) {
  const m = at(S.url, src, pos);
  if (!m) return 0;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    const scheme = m[1];
    let raw = m[0];
    let prev;
    do {
      prev = raw;
      raw = GR.inlineBackpedal.exec(raw)?.[0] ?? '';
    } while (raw !== prev);
    text = raw;
    href = scheme === 'www.' ? 'http://' + raw : raw;
    m[0] = raw;
  }
  if (plain) {
    out.push(text);
    return m[0].length;
  }
  const url = cleanUrl(href);
  if (url === null) {
    out.push(esc(text, true));
    return m[0].length;
  }
  out.push('<a href="' + esc(url, true) + '">' + esc(text, true) + '</a>');
  return m[0].length;
}

// Emphasis / strong emphasis. A literal port of marked's emStrong: the
// opening delimiter run, the left/right-flanking checks, the "rule of 3",
// and the closer search over the masked source (link texts and code spans
// blanked out, so their delimiters cannot close).
function hEmStrong(st, src, pos, masked, prevChar, out, plain) {
  const m = at(S.emStrongLDelim, src, pos);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return 0;
  const r = m[0][0];
  const prevSame = prevChar === r;
  const i = pos;
  let l = i;
  for (; l > 0 && masked[l - 1] === r; ) l--;
  const p = lastCodePoint(masked.slice(Math.max(0, l - 2), l));
  const h = p === '*' || p === '_' || !!GR.punctuation.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!GR.punctuation.exec(n);
  if (m[4] && n.match(GR.unicodeAlphaNumeric)) return 0;
  const d = m[1] || m[3] || '';
  if (!d || !n || u) {
    const k = cpLen(m[0]) - 1;
    let mm = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return 0;
    const A = r === '*' ? GR.emStrongRDelimAst : GR.emStrongRDelimUnd;
    const top = st.maskStack[st.maskStack.length - 1];
    const v =
      top && top.maskedSrc === masked
        ? top.lastEm[r]
        : scanDelims(masked).lastEm[r];
    const Q = pos + k;
    if (v < Q) return 0;
    const sliced = masked.slice(pos + k);
    const ee = v - Q;
    let s2;
    A.lastIndex = 0;
    while ((s2 = A.exec(sliced)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      const b = cpLen(g);
      if (s2[3] || s2[4]) {
        mm += b;
        continue;
      } else if (s2[5] || s2[6] || R) {
        if (prevSame && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      mm -= b;
      if (mm > 0) continue;
      const bb = Math.min(b, b + mm + f);
      const te = s2[0].codePointAt(0) > 0xffff ? 2 : 1;
      const M = src.slice(pos, pos + k + s2.index + te + bb);
      const inner = [];
      if (Math.min(k, bb) % 2) {
        renderInline(st, M.slice(1, -1), plain, inner);
        if (plain) out.push(inner.join(''));
        else out.push('<em>' + inner.join('') + '</em>');
      } else {
        renderInline(st, M.slice(2, -2), plain, inner);
        if (plain) out.push(inner.join(''));
        else out.push('<strong>' + inner.join('') + '</strong>');
      }
      return M.length;
    }
  }
  return 0;
}

// Strikethrough ~~text~~ (GFM). Same shape as emStrong, with the closer run
// required to be exactly as long as the opener.
function hDel(st, src, pos, masked, prevChar, out, plain) {
  const m = at(S.delLDelim, src, pos);
  if (!m) return 0;
  if (!(m[1] || '') || !prevChar || GR.punctuation.exec(prevChar)) {
    const o = cpLen(m[0]) - 1;
    let p = o;
    const h = GR.delRDelim;
    const top = st.maskStack[st.maskStack.length - 1];
    const u =
      top && top.maskedSrc === masked
        ? top.lastDel
        : scanDelims(masked).lastDel;
    const d = pos + o;
    if (u < d) return 0;
    const sliced = masked.slice(pos + o);
    const k = u - d;
    let s2;
    h.lastIndex = 0;
    while ((s2 = h.exec(sliced)) !== null && !(s2.index > k)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      let l = cpLen(g);
      if (l !== o) continue;
      if (s2[3] || s2[4]) {
        p += l;
        continue;
      }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = s2[0].codePointAt(0) > 0xffff ? 2 : 1;
      const rawSpan = src.slice(pos, pos + o + s2.index + te + l);
      const inner = [];
      renderInline(st, rawSpan.slice(o, -o), plain, inner);
      if (plain) out.push(inner.join(''));
      else out.push('<del>' + inner.join('') + '</del>');
      return rawSpan.length;
    }
  }
  return 0;
}


// ---- block phase ----
// Per-parse state. `links` collects link reference definitions during the
// frame walk; the rest mirrors marked's Lexer state. There is no inline
// job queue: inline rendering runs after the walk, when every definition
// in the document is known, so a reference defined later still resolves.
function newParseState() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    maskStack: [],
  };
}

// Frame kinds (small ints; frames hold a kind, source offsets and the
// small data rendering needs — never a token tree).
const F_SPACE = 0;
const F_PARAGRAPH = 1;
const F_TEXT = 2;
const F_HEADING = 3;
const F_CODE = 4;
const F_HR = 5;
const F_HTML = 6;
const F_BLOCKQUOTE = 7;
const F_LIST = 8;
const F_TABLE = 9;
const F_CHECKBOX = 10;

// Gates for the two expensive block grammars. Both are necessary conditions
// for the full regex to match, so skipping the regex when the gate fails
// changes nothing — it just avoids running a giant regex on blocks that
// cannot be a table or a setext heading.
// A table needs its delimiter row on the very next line: up to 3 spaces,
// then only | : - space tab, with at least one -.
function couldBeTable(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return false;
  let i = nl + 1;
  let sp = 0;
  while (i < src.length && src[i] === ' ' && sp < 3) { i++; sp++; }
  let hasDash = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\n') break;
    if (c === '-') hasDash = true;
    else if (c !== '|' && c !== ':' && c !== ' ' && c !== '\t') return false;
  }
  return hasDash;
}
// A setext heading needs an underline line (=== or ---) before the first
// blank line, because the heading text cannot span a blank line. The search
// is bounded to that region: scanning the whole remainder of a long
// document for every paragraph would cost more than the regex it gates.
const BLANK_LINE = /\n[ \t]*(?:\n|$)/g;
const SETEXT_LINE = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/g;
function couldBeLheading(src, pos) {
  BLANK_LINE.lastIndex = pos;
  const blank = BLANK_LINE.exec(src);
  const limit = blank ? blank.index : src.length;
  const region = src.slice(pos, limit);
  SETEXT_LINE.lastIndex = 0;
  return SETEXT_LINE.test(region);
}

// The block scanner. A cursor-based walk over `src` from `pos` to `end`
// that appends frames to `frames` and collects link definitions into
// `st.links`. It is the same tokenizer order as marked's Lexer#blockTokens
// (newline, indented code, fences, heading, hr, blockquote, list, html,
// def, table, setext, paragraph, text) with the same merging of space /
// indented code / definitions into a preceding paragraph or text frame —
// but the dispatch is by the first non-space character at the cursor, so
// a paragraph start never pays for the code/fence/heading/hr/blockquote/
// list/html/def attempts that cannot match there. `nested` is true when
// scanning blockquote content (paragraphs merge into a preceding
// paragraph); `st.top` says whether a paragraph token is allowed here
// (false inside list items, where the same content is loose text).
function scanBlocks(st, src, pos, end, frames, nested) {
  let p = pos;
  let n = nested;
  let guard = end - pos + 1;
  while (p < end) {
    if (--guard < 0) throw new Error('Infinite loop on byte: ' + src.charCodeAt(p));
    const prev = frames.length > 0 ? frames[frames.length - 1] : undefined;
    // First non-space character of this line, and the leading-space count.
    let i = p;
    let sp = 0;
    while (i < end && src[i] === ' ') { sp++; i++; }
    const ch = i < end ? src[i] : '';
    // Blank line (only spaces/tabs, then a newline or the end).
    if (ch === '\n' || ch === '') {
      const m = at(S.newline, src, p);
      if (m && m[0].length > 0) {
        p += m[0].length;
        if (m[0].length === 1 && prev !== undefined) prev.e += 1;
        else frames.push({ t: F_SPACE, s: p - m[0].length, e: p, raw: m[0] });
        continue;
      }
    }
    // A line of only spaces/tabs ending in a tab is blank too; a tab-led
    // non-blank line is indented code.
    if (ch === '\t') {
      let j = i;
      while (j < end && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j >= end || src[j] === '\n') {
        const m = at(S.newline, src, p);
        if (m && m[0].length > 0) {
          p += m[0].length;
          if (m[0].length === 1 && prev !== undefined) prev.e += 1;
          else frames.push({ t: F_SPACE, s: p - m[0].length, e: p, raw: m[0] });
          continue;
        }
      }
    }
    const isCodeIndent = sp >= 4 || (sp <= 3 && ch === '\t');
    // Indented code block (tried before everything except blank lines).
    if (isCodeIndent) {
      const m = at(S.code, src, p);
      if (m) {
        const raw = stripTrailingBlankLines(m[0]);
        const text = raw.replace(GR.codeRemoveIndent, '');
        p += raw.length;
        if (prev !== undefined && (prev.t === F_PARAGRAPH || prev.t === F_TEXT)) {
          prev.text += '\n' + text;
          prev.e = p;
        } else {
          frames.push({ t: F_CODE, s: p - raw.length, e: p, lang: '', text });
        }
        continue;
      }
    }
    // First-character dispatch for the remaining grammars. Each branch
    // tries its grammars in marked's order; when none matches, control
    // falls through to the common tail (table, setext, paragraph, text).
    let handled = false;
    if (!isCodeIndent) {
      if (ch === '`' || ch === '~') {
        const m = at(S.fences, src, p);
        if (m) {
          const raw = m[0];
          p += raw.length;
          const lang = m[2] ? m[2].trim().replace(GR.anyPunctuation, '$1') : m[2];
          frames.push({ t: F_CODE, s: p - raw.length, e: p, lang, text: indentCodeComp(raw, m[3] || '') });
          handled = true;
        }
      } else if (ch === '#') {
        const m = at(S.heading, src, p);
        if (m) {
          let text = m[2].trim();
          if (GR.endingHash.test(text)) {
            const stripped = rtrim(text, '#');
            if (!stripped || GR.endingSpaceTabChar.test(stripped)) text = stripped.trim();
          }
          const raw = rtrim(m[0], '\n');
          p += raw.length;
          frames.push({ t: F_HEADING, s: p - raw.length, e: p, depth: m[1].length, text, out: [] });
          handled = true;
        }
      } else if (ch === '-' || ch === '_' || ch === '*') {
        const m = at(S.hr, src, p);
        if (m) {
          const raw = rtrim(m[0], '\n');
          p += raw.length;
          frames.push({ t: F_HR, s: p - raw.length, e: p });
          handled = true;
        }
        if (!handled && (ch === '-' || ch === '*')) {
          const lm = at(S.list, src, p);
          if (lm) {
            const list = scanList(st, src, p, end);
            if (list) {
              p = list.e;
              frames.push(list);
              handled = true;
            }
          }
        }
      } else if (ch === '+') {
        const lm = at(S.list, src, p);
        if (lm) {
          const list = scanList(st, src, p, end);
          if (list) {
            p = list.e;
            frames.push(list);
            handled = true;
          }
        }
      } else if (ch === '>') {
        const m = at(S.blockquote, src, p);
        if (m) {
          const q = scanBlockquote(st, m[0]);
          if (q) {
            p += q.raw.length;
            frames.push({ t: F_BLOCKQUOTE, s: p - q.raw.length, e: p, raw: q.raw, text: q.text, frames: q.frames });
            handled = true;
          }
        }
      } else if (ch >= '0' && ch <= '9') {
        const lm = at(S.list, src, p);
        if (lm) {
          const list = scanList(st, src, p, end);
          if (list) {
            p = list.e;
            frames.push(list);
            handled = true;
          }
        }
      } else if (ch === '<') {
        const m = at(S.html, src, p);
        if (m) {
          const raw = stripTrailingBlankLines(m[0]);
          p += raw.length;
          frames.push({ t: F_HTML, s: p - raw.length, e: p, text: raw });
          handled = true;
        }
      } else if (ch === '[') {
        const m = at(S.def, src, p);
        if (m) {
          if (GR.startAngleBracket.test(m[2]) || findClosingBracket(m[2], '()') === -1) {
            const tag = normLabel(m[1]);
            const href = m[2]
              ? m[2].replace(GR.hrefBrackets, '$1').replace(GR.anyPunctuation, '$1')
              : '';
            const title = m[3]
              ? m[3].substring(1, m[3].length - 1).replace(GR.anyPunctuation, '$1')
              : m[3];
            const raw = rtrim(m[0], '\n');
            p += raw.length;
            if (prev !== undefined && (prev.t === F_PARAGRAPH || prev.t === F_TEXT)) {
              prev.text += '\n' + raw;
              prev.e = p;
            } else {
              if (!st.links[tag]) st.links[tag] = { href, title };
            }
            handled = true;
          }
        }
      }
    }
    if (handled) continue;
    // Common tail: table (gated), setext heading (gated), paragraph
    // (only at the top of a block run), loose text.
    if (couldBeTable(src, p)) {
      const m = at(S.table, src, p);
      if (m && GR.tableDelimiter.test(m[2])) {
        const table = scanTable(st, m, p);
        if (table) {
          p = table.e;
          frames.push(table);
          continue;
        }
      }
    }
    if (couldBeLheading(src, p)) {
      const m = at(S.lheading, src, p);
      if (m) {
        const text = m[1].trim();
        const raw = rtrim(m[0], '\n');
        p += raw.length;
        frames.push({
          t: F_HEADING, s: p - raw.length, e: p,
          depth: m[2].charAt(0) === '=' ? 1 : 2, text, out: [],
        });
        continue;
      }
    }
    if (st.top) {
      const m = at(S.paragraph, src, p);
      if (m) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const raw = m[0];
        if (n && prev !== undefined && prev.t === F_PARAGRAPH) {
          prev.text += '\n' + text;
          prev.e = p + raw.length;
        } else {
          frames.push({ t: F_PARAGRAPH, s: p, e: p + raw.length, text, out: [] });
        }
        n = false;
        p += raw.length;
        continue;
      }
    }
    {
      const m = at(S.blockText, src, p);
      if (m) {
        const raw = m[0];
        if (prev !== undefined && prev.t === F_TEXT) {
          prev.text += '\n' + raw;
          prev.e = p + raw.length;
        } else {
          frames.push({ t: F_TEXT, s: p, e: p + raw.length, text: raw, out: [] });
        }
        p += raw.length;
        continue;
      }
    }
    if (p < end) throw new Error('Infinite loop on byte: ' + src.charCodeAt(p));
  }
  st.top = true;
  return p;
}


// List. A port of marked's Tokenizer#list, working on the source range
// (src, pos, end) instead of a sliced remainder: no src.slice(pos) per
// list, no e.substring(...) per line — positions advance by index. Returns
// the list frame, or null when the marker cannot start a list.
function scanList(st, src, pos, end) {
  const m0 = at(S.list, src, pos);
  if (!m0) return null;
  const marker = m0[1].trim();
  const ordered = marker.length > 1;
  const list = {
    t: F_LIST, s: pos, e: pos, raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const itemRe = ITEM_S[ordered ? marker.slice(-1) : marker];
  let sawDoubleBlank = false;
  let e = pos;
  for (; e < end; ) {
    let blankItem = false;
    let itemText = '';
    const m = at(itemRe, src, e);
    if (!m || at(S.hr, src, e)) break;
    const itemStart = e;
    e += m[0].length;
    const firstLine = firstLineOf(m[2]);
    const b = m[1].length;
    let content = expandLeading(firstLine, b);
    const nlAfter = src.indexOf('\n', e);
    let nextLine = nlAfter === -1 || nlAfter >= end ? src.slice(e, end) : src.slice(e, nlAfter);
    let empty = !content.trim();
    let indent = 0;
    if (empty) {
      indent = b + 1;
    } else {
      indent = firstNonSpace(content);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += b;
    }
    if (empty && GR.blankLine.test(nextLine)) {
      e = Math.min(e + nextLine.length + 1, end);
      blankItem = true;
    }
    if (!blankItem) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesRe = fencesBeginRegex(indent);
      const headingRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const quoteRe = blockquoteBeginRegex(indent);
      // The clamped indent level the six grammars above were built with
      // (the same clamp memoIndent applies); the dispatch needs it.
      const a = Math.max(0, Math.min(3, indent - 1));
      const re6 = { fences: fencesRe, heading: headingRe, html: htmlRe, quote: quoteRe, nextBullet, hr: hrRe };
      const re4 = { fences: fencesRe, heading: headingRe, html: htmlRe, hr: hrRe };
      for (; e < end; ) {
        const nl = src.indexOf('\n', e);
        const line = nl === -1 || nl >= end ? src.slice(e, end) : src.slice(e, nl);
        let expanded;
        expanded = expandLeading(line);
        if (lineInterrupts(line, a, re6)) {
          break;
        }
        if (firstNonSpace(expanded) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (
            empty ||
            firstNonSpaceCol(content) >= 4 ||
            lineInterrupts(content, a, re4)
          ) {
            break;
          }
          const qe =
            /^ {0,3}(?:=+|-+) *$/.test(line) && GR.lheading.test(`${content}\n${line}`)
              ? `    ${expanded.replace(/^ {0,3}/, '')}`
              : line;
          itemText += '\n' + qe;
        }
        empty = !line.trim();
        e = Math.min(e + line.length + 1, end);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, e);
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (endsDoubleBlank(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      raw: itemRaw,
      task: GR.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      frames: [],
    });
  }
  const last = list.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  const listRaw = src.slice(pos, e).trimEnd();
  list.raw = listRaw;
  list.e = pos + listRaw.length;
  for (const item of list.items) {
    st.top = false;
    scanBlocks(st, item.text, 0, item.text.length, item.frames, false);
    if (!list.loose) {
      const spaces = item.frames.filter((f) => f.t === F_SPACE);
      list.loose = spaces.length > 0 && spaces.some((f) => GR.anyLine.test(f.raw));
    }
  }
  for (const item of list.items) {
    const first = item.frames[0];
    if (item.task && (first?.t === F_TEXT || first?.t === F_PARAGRAPH)) {
      item.text = item.text.replace(GR.listReplaceTask, '');
      first.text = first.text.replace(GR.listReplaceTask, '');
      const k = GR.listTaskCheckbox.exec(item.raw);
      if (k) {
        const checked = k[0] !== '[ ]';
        item.checked = checked;
        const boxHtml = `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
        if (list.loose) {
          if (
            item.frames[0] &&
            (item.frames[0].t === F_PARAGRAPH || item.frames[0].t === F_TEXT) &&
            item.frames[0].out
          ) {
            // The checkbox HTML goes first in the first block's rendered
            // inline output; the block's text stays the stripped text (the
            // marker is gone from the inline source, as in marked).
            item.frames[0].out.unshift(boxHtml);
          } else {
            item.frames.unshift({ t: F_PARAGRAPH, s: 0, e: 0, text: '', out: [boxHtml] });
          }
        } else {
          item.frames.unshift({ t: F_CHECKBOX, s: 0, e: 0, checked });
        }
      } else if (item.task) {
        item.task = false;
      }
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const f of item.frames) if (f.t === F_TEXT) f.t = F_PARAGRAPH;
    }
  }
  return list;
}


// Block quote. A port of marked's Tokenizer#blockquote: the matched raw
// text is split into lines, the `>` markers stripped, and the content
// re-scanned in chunks; a nested block quote or list at the end is
// re-scanned with the following lines attached.
function scanBlockquote(st, raw0) {
  const lines = rtrim(raw0, '\n').split('\n');
  let raw = '';
  let text = '';
  const frames = [];
  let rest = lines;
  while (rest.length > 0) {
    let started = false;
    const chunk = [];
    let p;
    for (p = 0; p < rest.length; p++) {
      if (GR.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        started = true;
      } else if (!started) chunk.push(rest[p]);
      else break;
    }
    rest = rest.slice(p);
    const joined = chunk.join('\n');
    const inner = joined
      .replace(GR.blockquoteMarkerWhitespace, (whole, marker, spaces) => marker + expandTabs(spaces, marker.length))
      .replace(GR.blockquoteSetextReplace, '\n    $1')
      .replace(GR.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${joined}` : joined;
    text = text ? `${text}\n${inner}` : inner;
    const savedTop = st.top;
    st.top = true;
    scanBlocks(st, inner, 0, inner.length, frames, true);
    st.top = savedTop;
    if (rest.length === 0) break;
    const last = frames.at(-1);
    if (
      last?.t === F_CODE ||
      last?.t === F_HEADING ||
      last?.t === F_HR ||
      last?.t === F_HTML ||
      last?.t === F_TABLE
    ) {
      break;
    }
    if (last?.t === F_BLOCKQUOTE) {
      const g = last;
      const b = rest.join('\n');
      const merged = g.raw + '\n' + b.replace(GR.blockquoteSetextReplace2, '');
      const f = scanBlockquote(st, merged);
      frames[frames.length - 1] = { t: F_BLOCKQUOTE, s: 0, e: 0, raw: f.raw, text: f.text, frames: f.frames };
      const y = merged.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const taken = R ? rest.slice(0, -R) : rest;
      if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
      text = text.substring(0, text.length - g.text.length) + f.text;
      rest = rest.slice(taken.length);
      if (rest.length > 0 && GR.blockquoteStart.test(rest[0])) continue;
      break;
    } else if (last?.t === F_LIST) {
      const g = last;
      const b = g.raw + '\n' + rest.join('\n');
      const mergedList = scanList(st, b, 0, b.length);
      frames[frames.length - 1] = mergedList;
      const f =
        mergedList.raw.length > g.raw.length
          ? b.slice(g.raw.length + 1, mergedList.raw.length).split('\n').length
          : 0;
      if (f > 0) {
        const y = rest.slice(0, f).join('\n');
        raw = `${raw}\n${y}`;
        text = `${text}\n${y}`;
      }
      rest = rest.slice(f);
      continue;
    }
  }
  return { raw, text, frames };
}

// Table (GFM). Header cells, alignments, and body rows; each cell is
// rendered inline in the drain phase.
function scanTable(st, m, p) {
  const header = splitCells(m[1]);
  const alignsRaw = m[2].replace(GR.tableAlignChars, '').split('|');
  const rowsRaw = m[3]?.trim() ? m[3].replace(GR.tableRowBlankLine, '').split('\n') : [];
  const table = { t: F_TABLE, s: p, e: p, header: [], align: [], rows: [] };
  if (header.length !== alignsRaw.length) return null;
  for (const a of alignsRaw) {
    table.align.push(
      GR.tableAlignRight.test(a)
        ? 'right'
        : GR.tableAlignCenter.test(a)
          ? 'center'
          : GR.tableAlignLeft.test(a)
            ? 'left'
            : null,
    );
  }
  for (let i = 0; i < header.length; i++) {
    table.header.push({
      text: header[i],
      out: [],
      header: true,
      align: table.align[i],
    });
  }
  for (const row of rowsRaw) {
    table.rows.push(
      splitCells(row, table.header.length).map((cell, i) => ({
        text: cell,
        out: [],
        header: false,
        align: table.align[i],
      })),
    );
  }
  table.e = p + rtrim(m[0], '\n').length;
  return table;
}


// ---- rendering ----
// Inline drain: render every frame's inline source now that the walk is
// done and every link reference definition in the document is known.
// Walks frames in document order (recursing into quotes, lists and table
// cells), exactly the order the old job queue drained in. inRawBlock is
// reset before each inline render; inLink is deliberately not reset,
// matching marked (a link opened and never closed in one block stays open
// for the next block's inline rendering).
function drainInline(st, frames) {
  for (const fr of frames) {
    switch (fr.t) {
      case F_PARAGRAPH:
      case F_TEXT:
      case F_HEADING:
        st.inRawBlock = false;
        renderInline(st, fr.text, false, fr.out);
        break;
      case F_TABLE:
        for (const cell of fr.header) {
          st.inRawBlock = false;
          renderInline(st, cell.text, false, cell.out);
        }
        for (const row of fr.rows) {
          for (const cell of row) {
            st.inRawBlock = false;
            renderInline(st, cell.text, false, cell.out);
          }
        }
        break;
      case F_BLOCKQUOTE:
        drainInline(st, fr.frames);
        break;
      case F_LIST:
        for (const item of fr.items) drainInline(st, item.frames);
        break;
      default:
        break;
    }
  }
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const inner = cell.out.join('');
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
}

// Direct-to-HTML block rendering: frames emit HTML straight into the
// shared output array. No token tree is walked here — frames hold their
// rendered inline output already, and recursive constructs (quotes,
// lists) render their stored sub-frames.
function renderFrames(frames, out) {
  for (const fr of frames) {
    switch (fr.t) {
      case F_SPACE:
        break;
      case F_HR:
        out.push('<hr>\n');
        break;
      case F_HEADING:
        out.push(`<h${fr.depth}>${fr.out.join('')}</h${fr.depth}>\n`);
        break;
      case F_CODE: {
        const lang = (fr.lang || '').match(GR.notSpaceStart)?.[0];
        const text = fr.text ? fr.text.replace(GR.endingNewline, '') + '\n' : '';
        const body = esc(text, true);
        out.push(
          lang
            ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
            : `<pre><code>${body}</code></pre>\n`,
        );
        break;
      }
      case F_TABLE: {
        let head = '';
        for (const cell of fr.header) head += renderTableCell(cell);
        let body = '';
        for (const row of fr.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderTableCell(cell);
          body += `<tr>\n${rowHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out.push(`<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`);
        break;
      }
      case F_BLOCKQUOTE:
        out.push('<blockquote>\n');
        renderFrames(fr.frames, out);
        out.push('</blockquote>\n');
        break;
      case F_LIST: {
        const tag = fr.ordered ? 'ol' : 'ul';
        const start = fr.ordered && fr.start !== 1 ? ` start="${fr.start}"` : '';
        out.push(`<${tag}${start}>\n`);
        for (const item of fr.items) {
          out.push('<li>');
          renderFrames(item.frames, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        break;
      }
      case F_CHECKBOX:
        out.push(`<input ${fr.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `);
        break;
      case F_HTML:
        out.push(fr.text);
        break;
      case F_PARAGRAPH:
        out.push(`<p>${fr.out.join('')}</p>\n`);
        break;
      case F_TEXT:
        out.push(fr.out.join(''));
        break;
      default:
        throw new Error('Frame with "' + fr.t + '" type was not found.');
    }
  }
}

// The entry point: parse one markdown string to marked-identical HTML.
export function parse(markdown) {
  const st = newParseState();
  // Fast path: normalizing line endings is a no-op when the input has no
  // carriage return, so skip the full-string regex replace for it (most
  // inputs, including every spec example without CRLF).
  const src =
    markdown.indexOf('\r') === -1
      ? markdown
      : markdown.replace(GR.carriageReturn, '\n');
  const frames = [];
  scanBlocks(st, src, 0, src.length, frames, false);
  // Inline rendering runs only now: every link reference definition in the
  // document is known, so forward references resolve.
  drainInline(st, frames);
  const out = [];
  renderFrames(frames, out);
  return out.join('');
}

// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Written for the make.fun
// markdown-render-speed-02 bounty. parse(markdown) returns, for every
// string, exactly the HTML that marked.parse(markdown) returns.
//
// How it works, in one paragraph: the block layer walks the source with a
// cursor and sticky regexes (no slicing the remainder on every block), the
// inline layer fuses tokenizing and rendering into a single pass that emits
// HTML straight into an output array (no inline token objects are ever
// built), and link reference definitions are collected during the block
// layer so inline rendering runs only afterwards and a definition later in
// the document still resolves. Two cheap gates keep the giant table and
// setext-heading grammars from being tried on blocks that cannot be either.
//
// The grammar regexes below are marked 18.1.3's (MIT), the reference the
// competition vendors in the kit; everything around them — the cursor
// lexer, the fused inline renderer, the escaping, the masking — is written
// here. The file is dependency-free and deterministic: no wall clock, no
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
  inlineText:
    /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
};

// ---- sticky block/inline grammars ----
// A sticky regex is the anchored grammar with the leading ^ dropped (the
// `y` flag anchors at lastIndex already), so exec() at a cursor is exactly
// the match the same grammar would give on the sliced remainder — without
// ever slicing. Grammars used with exec-loops or matchAll keep their
// original form.
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
  inlineText: sticky(GR.inlineText),
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
// (DeepSeek suggestion A: hoist per-call regex compilations to module
// level. The memoIndent builders below are already cached the same way.)
const ITEM_RE = {
  '*': /^( {0,3}\*)((?:[\t ][^\n]*)?(?:\n|$))/,
  '+': /^( {0,3}\+)((?:[\t ][^\n]*)?(?:\n|$))/,
  '-': /^( {0,3}\-)((?:[\t ][^\n]*)?(?:\n|$))/,
  '.': /^( {0,3}\d{1,9}\.)((?:[\t ][^\n]*)?(?:\n|$))/,
  ')': /^( {0,3}\d{1,9}\))((?:[\t ][^\n]*)?(?:\n|$))/,
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

// ---- inline rendering (fused tokenize + render) ----
// renderInline renders `src` into the string array `out`. `plain` selects
// plain-text rendering (used for image alt text) instead of HTML. It is the
// fused form of marked's Lexer#inlineTokens + Parser#parseInline: no inline
// token objects are allocated, and the first-character dispatch below skips
// the tokenizers that cannot match at the current position.
// `st` is the per-parse state: links, queue, inLink, inRawBlock,
// linkEmitted, linkParenPossible, top, maskStack.
function renderInline(st, src, plain, out) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  const masked =
    src.includes('*') || src.includes('_') || src.includes('~')
      ? blankLinksAndCode(st, src)
      : src;
  st.maskStack.push(scanDelims(masked));
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
        // plain text up to the next special character
        const m = at(S.inlineText, src, pos);
        if (!m) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
        const raw = m[0];
        const inRaw = st.inRawBlock;
        const text = inRaw ? raw : unescape(raw);
        if (plain) out.push(text);
        else out.push(inRaw ? text : esc(text));
        adv = raw.length;
        prevText = true;
        if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
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
// Per-parse state. `links` collects link reference definitions, `queue`
// collects the inline jobs (rendered only after the block phase, so a
// reference defined later in the document still resolves), and the rest
// mirrors marked's Lexer state.
function newParseState() {
  return {
    links: Object.create(null),
    queue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    maskStack: [],
  };
}
// Queue one inline source for rendering after the block phase. Returns the
// job; its `out` array is filled by the drain, its `src` may still be edited
// (list items and merged paragraphs rewrite it before the drain runs).
function queueInline(st, src) {
  const job = { src, out: [] };
  st.queue.push(job);
  return job;
}

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

// The block lexer. A cursor-based port of marked's Lexer#blockTokens: the
// same tokenizer attempts in the same order, the same merging of space /
// indented code / definitions into a preceding paragraph or text token, and
// the same nested flag. `tokens` accumulates block token objects; each token
// that carries inline content holds `inl`, its queued inline job.
function lexBlocks(st, src, tokens, nested) {
  let pos = 0;
  const end = src.length;
  let guard = Infinity;
  let n = nested;
  while (pos < end) {
    const remain = end - pos;
    if (remain < guard) guard = remain;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    let m;
    // blank lines
    m = at(S.newline, src, pos);
    if (m && m[0].length > 0) {
      pos += m[0].length;
      const prev = tokens.at(-1);
      if (m[0].length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push({ type: 'space', raw: m[0] });
      continue;
    }
    // indented code block
    m = at(S.code, src, pos);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      const text = raw.replace(GR.codeRemoveIndent, '');
      pos += raw.length;
      const prev = tokens.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + text;
        st.queue.at(-1).src = prev.text;
      } else {
        tokens.push({ type: 'code', raw, codeBlockStyle: 'indented', text });
      }
      continue;
    }
    // fenced code block
    m = at(S.fences, src, pos);
    if (m) {
      const raw = m[0];
      pos += raw.length;
      const lang = m[2] ? m[2].trim().replace(GR.anyPunctuation, '$1') : m[2];
      tokens.push({ type: 'code', raw, lang, text: indentCodeComp(raw, m[3] || '') });
      continue;
    }
    // ATX heading
    m = at(S.heading, src, pos);
    if (m) {
      let text = m[2].trim();
      if (GR.endingHash.test(text)) {
        const stripped = rtrim(text, '#');
        if (!stripped || GR.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      const raw = rtrim(m[0], '\n');
      pos += raw.length;
      tokens.push({ type: 'heading', raw, depth: m[1].length, text, inl: queueInline(st, text) });
      continue;
    }
    // thematic break
    m = at(S.hr, src, pos);
    if (m) {
      const raw = rtrim(m[0], '\n');
      pos += raw.length;
      tokens.push({ type: 'hr', raw });
      continue;
    }
    // block quote
    m = at(S.blockquote, src, pos);
    if (m) {
      const tok = lexBlockquote(st, m[0]);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }
    // list
    m = at(S.list, src, pos);
    if (m) {
      const tok = lexList(st, src.slice(pos));
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }
    // raw HTML block
    m = at(S.html, src, pos);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      pos += raw.length;
      tokens.push({
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      });
      continue;
    }
    // link reference definition
    m = at(S.def, src, pos);
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
        pos += raw.length;
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + raw;
          st.queue.at(-1).src = prev.text;
        } else {
          if (!st.links[tag]) st.links[tag] = { href, title };
          tokens.push({ type: 'def', tag, raw, href, title });
        }
        continue;
      }
    }
    // table (GFM) — gated: only try the regex when the next line could be
    // a delimiter row.
    if (couldBeTable(src, pos)) {
      m = at(S.table, src, pos);
      if (m && GR.tableDelimiter.test(m[2])) {
        const tok = lexTable(st, m);
        if (tok) {
          pos += tok.raw.length;
          tokens.push(tok);
          continue;
        }
      }
    }
    // setext heading — gated: only try when an underline line exists before
    // the next blank line.
    if (couldBeLheading(src, pos)) {
      m = at(S.lheading, src, pos);
      if (m) {
        const text = m[1].trim();
        const raw = rtrim(m[0], '\n');
        pos += raw.length;
        tokens.push({
          type: 'heading',
          raw,
          depth: m[2].charAt(0) === '=' ? 1 : 2,
          text,
          inl: queueInline(st, text),
        });
        continue;
      }
    }
    // paragraph (only at the top level of a block run)
    if (st.top) {
      m = at(S.paragraph, src, pos);
      if (m) {
        const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const raw = m[0];
        const prev = tokens.at(-1);
        // The paragraph tokenizer queues its inline job before the merge
        // decision (as in marked): on a merge the just-queued job is popped
        // and the previous paragraph's job is rewritten instead.
        const job = queueInline(st, text);
        if (n && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.text += '\n' + text;
          st.queue.pop();
          prev.inl.src = prev.text;
        } else {
          tokens.push({ type: 'paragraph', raw, text, inl: job });
        }
        n = false;
        pos += raw.length;
        continue;
      }
    }
    // loose text (inside block quotes and list items)
    m = at(S.blockText, src, pos);
    if (m) {
      const raw = m[0];
      const prev = tokens.at(-1);
      // As with paragraphs: the text tokenizer queues its inline job first;
      // a merge pops it and rewrites the previous text token's job.
      const job = queueInline(st, raw);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
        st.queue.pop();
        prev.inl.src = prev.text;
      } else {
        tokens.push({ type: 'text', raw, text: raw, inl: job });
      }
      pos += raw.length;
      continue;
    }
    if (pos < end) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  st.top = true;
  return tokens;
}

// Block quote. A literal port of marked's Tokenizer#blockquote: the matched
// raw text is split into lines, the `>` markers stripped, and the content
// re-lexed in chunks; a nested block quote or list at the end is re-lexed
// with the following lines attached.
function lexBlockquote(st, raw0) {
  const lines = rtrim(raw0, '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
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
    lexBlocks(st, inner, tokens, true);
    st.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens.at(-1);
    if (
      last?.type === 'code' ||
      last?.type === 'heading' ||
      last?.type === 'hr' ||
      last?.type === 'html' ||
      last?.type === 'table'
    ) {
      break;
    }
    if (last?.type === 'blockquote') {
      const g = last;
      const b = rest.join('\n');
      const merged = g.raw + '\n' + b.replace(GR.blockquoteSetextReplace2, '');
      const f = lexBlockquote(st, merged);
      tokens[tokens.length - 1] = f;
      const y = merged.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const taken = R ? rest.slice(0, -R) : rest;
      if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
      text = text.substring(0, text.length - g.text.length) + f.text;
      rest = rest.slice(taken.length);
      if (rest.length > 0 && GR.blockquoteStart.test(rest[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const g = last;
      const b = g.raw + '\n' + rest.join('\n');
      const mergedList = lexList(st, b);
      tokens[tokens.length - 1] = mergedList;
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
  return { type: 'blockquote', raw, tokens, text };
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

// List. A literal port of marked's Tokenizer#list, working on the remaining
// source string (as marked does). Returns the list token, or null.
function lexList(st, input) {
  const m0 = GR.list.exec(input);
  if (!m0) return null;
  let e = input;
  const n = e;
  const consumed = () => n.length - e.length;
  const marker = m0[1].trim();
  const ordered = marker.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +marker.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const itemRe = ITEM_RE[ordered ? marker.slice(-1) : marker];
  let sawDoubleBlank = false;
  for (; e; ) {
    let blankItem = false;
    let itemText = '';
    const m = itemRe.exec(e);
    if (!m || GR.hr.test(e)) break;
    const k = consumed();
    e = e.substring(m[0].length);
    const firstLine = firstLineOf(m[2]);
    const b = m[1].length;
    let content = expandLeading(firstLine, b);
    let nextLine = firstLineOf(e);
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
      e = e.substring(nextLine.length + 1);
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
      for (; e; ) {
        const line = firstLineOf(e);
        let expanded;
        nextLine = line;
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
        e = e.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = n.slice(k, consumed());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (endsDoubleBlank(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: GR.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const last = list.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = n.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    st.top = false;
    item.tokens = lexBlocks(st, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => GR.anyLine.test(t.raw));
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
      item.text = item.text.replace(GR.listReplaceTask, '');
      first.raw = first.raw.replace(GR.listReplaceTask, '');
      first.text = first.text.replace(GR.listReplaceTask, '');
      for (let g = st.queue.length - 1; g >= 0; g--) {
        if (GR.listIsTask.test(st.queue[g].src)) {
          st.queue[g].src = st.queue[g].src.replace(GR.listReplaceTask, '');
          break;
        }
      }
      const k = GR.listTaskCheckbox.exec(item.raw);
      if (k) {
        const checkbox = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            ['paragraph', 'text'].includes(item.tokens[0].type) &&
            'inl' in item.tokens[0] &&
            item.tokens[0].inl
          ) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].inl.out.unshift(
              `<input ${checkbox.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `,
            );
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkbox.raw,
              text: checkbox.raw,
              inl: { src: '', out: [`<input ${checkbox.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `] },
            });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      } else if (item.task) {
        item.task = false;
      }
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// Table (GFM). Header cells, alignments, and body rows; each cell is queued
// for inline rendering.
function lexTable(st, m) {
  const header = splitCells(m[1]);
  const alignsRaw = m[2].replace(GR.tableAlignChars, '').split('|');
  const rowsRaw = m[3]?.trim() ? m[3].replace(GR.tableRowBlankLine, '').split('\n') : [];
  const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
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
      inl: queueInline(st, header[i]),
      header: true,
      align: table.align[i],
    });
  }
  for (const row of rowsRaw) {
    table.rows.push(
      splitCells(row, table.header.length).map((cell, i) => ({
        text: cell,
        inl: queueInline(st, cell),
        header: false,
        align: table.align[i],
      })),
    );
  }
  return table;
}

// ---- rendering (a port of marked's Parser + Renderer) ----
function renderBlocks(tokens, out) {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'heading':
        out.push(`<h${tok.depth}>${tok.inl.out.join('')}</h${tok.depth}>\n`);
        break;
      case 'code': {
        const lang = (tok.lang || '').match(GR.notSpaceStart)?.[0];
        const text = tok.text ? tok.text.replace(GR.endingNewline, '') + '\n' : '';
        const body = esc(text, true);
        out.push(
          lang
            ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
            : `<pre><code>${body}</code></pre>\n`,
        );
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) rowHtml += renderTableCell(cell);
          body += `<tr>\n${rowHtml}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out.push(`<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`);
        break;
      }
      case 'blockquote': {
        // Render straight into the shared output array instead of an
        // intermediate array that is joined and re-pushed: the final
        // out.join('') in parse() flattens the parts once, so the
        // intermediate join only copied the same bytes a second time.
        out.push('<blockquote>\n');
        renderBlocks(tok.tokens, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out.push(`<${tag}${start}>\n`);
        for (const item of tok.items) {
          out.push('<li>');
          renderBlocks(item.tokens, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>\n`);
        break;
      }
      case 'checkbox':
        out.push(`<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `);
        break;
      case 'html':
        out.push(tok.text);
        break;
      case 'def':
        break;
      case 'paragraph':
        out.push(`<p>${tok.inl.out.join('')}</p>\n`);
        break;
      case 'text':
        out.push(tok.inl.out.join(''));
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const inner = cell.inl.out.join('');
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
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
  const tokens = [];
  lexBlocks(st, src, tokens, false);
  // Inline rendering runs only now: every link reference definition in the
  // document is known, so forward references resolve.
  for (const job of st.queue) {
    st.inRawBlock = false;
    renderInline(st, job.src, false, job.out);
  }
  const out = [];
  renderBlocks(tokens, out);
  return out.join('');
}

# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/zaidanainunn/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/zaidanainunn/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

An index-scanner Markdown renderer that returns byte-identical HTML to marked 18.1.3. Instead of building a token tree, it walks the source once with a global index cursor, skips plain text with native `indexOf`, and emits HTML directly into an output array — no dependencies, Node stdlib only. Built by an AI agent for make.fun's “Make Markdown rendering faster” bounty, $250 in USDC.

## How it works

- **Block layer** (`scanBlocks`): first-character dispatch over the source; blocks become small frames holding source offsets, not substrings, so nothing is copied until it is rendered.
- **Inline layer** (`renderInline` + `scanPlain`): plain-text runs are skipped with native `indexOf` over the sentinel set; a regex or a special parser runs only after a candidate delimiter is found.
- **Correctness**: 720/720 practice cases byte-identical to marked 18.1.3, plus 20,000 inline and 5,000 document-shaped random differential tests against marked, all passing.

## Run it

```sh
node /bot/main.ts
```


The driver reads `/input/cases.json` (`{id, markdown}` per case) and writes `/output/html.json` (HTML strings in input order). `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` override the paths for local runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vysnzyza&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

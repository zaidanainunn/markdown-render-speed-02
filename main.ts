// main.ts — driver for the index-scanner markdown renderer.
//
// The grader runs `node /bot/main.ts` (Node 22, erasable syntax only) in a
// fresh process. Input is /input/cases.json: a JSON array of objects with
// {id, markdown}. Each case is rendered on its own by parse() from
// parse.js, and the results are written to /output/html.json as a JSON
// array of HTML strings, one per case, in the same order as the input.
// When the container paths are absent, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR override /input and /output (handy for local runs).
//
// Rendering is stateless: parse() keeps no state between calls, so no
// case can influence the next one and the output is deterministic.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];

  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    html[i] = parse(cases[i].markdown);
  }

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();

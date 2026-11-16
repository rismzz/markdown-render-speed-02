// main.ts — the program the harness runs (node /bot/main.ts, Node 22).
//
// It reads every case from cases.json in the input directory (a JSON array
// of {"id", "markdown"}), renders each case with parse() from ./parse.js,
// and writes html.json to the output directory: a JSON array of the HTML
// strings, one per case, in the cases' order. Outside the sandbox the
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR environment variables stand in
// for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html = new Array<string>(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));

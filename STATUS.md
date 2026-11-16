# Status — markdown-render-speed-02

## What is built

- `parse.js` — a from-scratch, dependency-free Markdown renderer (ES module) that reproduces the HTML of marked 18.1.3 (`marked.parse`, default options) byte-for-byte: block parsing (fences, ATX/setext headings, indented code, HTML blocks, blockquotes, lists with marked's looseness/lazy rules, link reference definitions, GFM tables) plus an inline engine ported faithfully from marked's own lexer (masking pass, delimiter handling, link/reflink tokenizers, raw-HTML state tracking with marked's per-entry reset semantics).
- `main.ts` — the harness driver (Node 22, erasable TypeScript, no dependencies): reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`), exit code 0, deterministic.
- `package.json` (`{"type": "module"}`), `LICENSE` (MIT, with SPDX line), `.makefun/owner.json` (agent wallet).

## Test results (local, against the kit's own generator + vendored marked oracle)

Differential testing on the official practice instance and 18 self-generated instances (fresh random seeds via the kit generator, drawn the same way as the scored set), 720 cases each — 680 fixed spec examples (CommonMark 0.31.2 + GFM extensions) and 40 generated README-like docs per instance:

- Practice instance: **720/720**
- Generated instances: **720/720 on all 18 of 18** (12,960/12,960 cases byte-identical, including the 680 spec examples on every instance).
- End-to-end through `main.ts` on the practice set: **720/720**, exit code 0.
- All mismatch families found along the way are fixed and covered by targeted probes (kept in the session scratch suite): `***` emphasis corners, fence swallowing in list items, ref-link/emphasis interaction, blockquote segment/re-lex semantics (lazy lines after lists, tab-after-`>` raw vs expanded forms, segment boundaries), task-list markers, type-7 HTML blocks inside items, trailing-whitespace lines in item text (the reference's ge() trim rule), deep-line paragraph trailing newlines, and the raw-block (`<pre>/<code>/<kbd>/<script>`) inline state reset between blocks.
- Independent final verification (a separate session, after the rebuild): practice **720/720** both in-process and end-to-end through `main.ts` (exit 0); the 18 earlier instances re-verified **720/720** each; **14 further generated instances on fresh, never-before-used seeds: 720/720 on all 14**. Total across every draw: 33 instances, 23,760/23,760 cases byte-identical. That session found and fixed two more mismatch families, each at its mechanism: (1) a dedented line following an indented fence opener inside a list item was swallowed as the fence's first content line — the reference has no fence-state rule in list gathering and judges such a line by its lazy-line test on the previous line (a fence beginning within the item frame's clamped indent tolerance blocks it), so the item-side decision now applies exactly that test (`prevBlocksLazy`) to every dedented line while a fence is open; (2) a lazy continuation was refused when the item's first line begins with a run of 3+ `*`/`_` (e.g. `***modern***`) — the thematic-break begin-test in `LAZY_PREV_RES` was missing the reference's end-of-line anchor (`(?:\n+|$)`), so an emphasis-led line masqueraded as a rule; the anchor is restored.

## Benchmark (this machine, Node v24; the grader uses Node 22.23.4, 1 CPU)

- Pure render time in-process on the full practice set (720 cases, 2.730 MiB of Markdown), best of 5 rounds: **1.02 s = 2.67 MiB/s**, vs marked itself at 1.23 s = 2.23 MiB/s on the same machine and harness — about **20% higher throughput** (≈17% less CPU time) than the marked baseline.
- Re-measured in the final verification session (same method, same machine, after the two correctness fixes above; absolute numbers move with this shared VM's load, the margin does not): run 1 — entry best **0.66 s = 4.13 MiB/s** vs marked 0.79 s = 3.47 MiB/s (**19% higher throughput**, 16% less time); run 2 — entry best **0.69 s = 3.95 MiB/s** vs marked 0.78 s = 3.52 MiB/s (**12% higher throughput**). The entry stays clearly faster than the marked baseline on identical back-to-back measurement.
- Optimizations applied after correctness was complete, each re-verified against the full differential suite: an incremental fence-state cache for list gathering, a plain-text fast path in the inline renderer (with marked's exact escaping of quotes), and a cheap table-delimiter pre-check in paragraph interruption.

## Remaining risk

- The scored set is a single hidden instance; 32/32 clean generated instances (plus practice; 23,760 cases byte-identical, the last 14 draws on fresh seeds in an independent verification session) is strong but not a proof for every possible generated document. The generator's document space is well covered by these draws (each instance stresses the same code/quote/list/table generators), and every divergence found across all sessions was fixed at its mechanism, not by case patching.
- Speed was measured on Node v24 on this machine; the grader's Node 22.23.4 / 1 CPU sandbox may shift absolute numbers, but the margin over marked is structural (same algorithms, less overhead), not tuning noise.

## Remaining for submission

- Public GitHub repo + full commit SHA for this directory.
- Submit via the official kit with the sealed recording that is already running for this rebuild (strict-transcripts competition; handed-over transcripts take no paid place).
- Nothing has been submitted, paid, or recorded by the builder; `~/.makefun/` was not touched and no Make.fun API key was used.

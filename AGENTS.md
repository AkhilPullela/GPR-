# AGENTS.md

Repository-specific guidance for the Zeus vs Hades Game Performance Reporter (GPR).

## What this is

A browser-only React + Vite app that imports Chrome DevTools Performance JSON traces,
analyzes them, and exports HTML/PDF/CSV reports. There is no backend, database, or
external service. `dist/` and `node_modules/` are gitignored.

## Commands

- `npm test` — Node built-in test runner (`node --test`). Both `test/*.test.js` files run.
- `npm run build` — Vite production build.
- `npm run dev` — Vite dev server (see `.replit`; default port 5000).

There is no lint or type-check script. `npm test` and `npm run build` are the only gates.

## Hard constraint

Do not add UI or chart dependencies. Use browser-native APIs only: SVG, File/Streams
APIs, Web Workers, and print CSS. `package.json` dependencies are intentionally just
react, react-dom, vite, and @vitejs/plugin-react.

## Architecture

- `gpr/jsonStream.js` — incremental JSON token reader. Preserves string/escape/nesting
  state across chunk boundaries. Never parse a chunk as standalone JSON.
- `gpr/parser.js` — trace normalization. `createTraceNormalizer` accumulates
  frames/heap/task candidates/busy intervals and finalizes in `finish()`.
- `gpr/analyze.js` — pure summary, round, finding, ranking, and chart-series helpers.
  `analyzeRun(run, config, hooks)` accepts `onStage` and `shouldAbort` hooks.
- `gpr/model.js` — `THRESHOLDS`, `SEVERITY_RANK`, `METRIC_STATUS`, `metricAvailability`.
- `gpr/importSession.js` — UI-independent import state machine (sequencing, throttled
  progress, cancellation, failure-preserves-previous-report).
- `gpr/trace.worker.js` + `gpr/traceWorkerClient.js` — all parsing and analysis run in a
  Web Worker so the UI thread never blocks. Keep expensive work out of React render.
- `gpr/reports.js` — HTML/PDF/CSV exports from one memoized snapshot.
- `gpr/instrumentation.js` — disabled-by-default React Profiler / Redux helpers.

## Domain rules that must not regress

- Never derive CPU utilization from task duration. CPU requires explicit samples;
  otherwise report it as unsupported.
- Never render an absent metric as `0`. Use `METRIC_STATUS` + a reason and how to capture it.
- Main-thread busy time is derived from merged task intervals (nested work counted once)
  and is labelled as such, separate from CPU.
- `thread_name` metadata can appear after tasks, so the main-thread filter runs at the
  end of normalization.
- Chrome heap counters arrive as `ph: "C"` `UpdateCounters` with `args.data.jsHeapSizeUsed`.
- Round/bonus correlation requires explicit imported markers. Never invent round ids,
  bonus names, or boundaries.
- Temporal overlap is a lead, not causation. Heap growth is not proof of a leak.
- Demo fixture output is always labelled DEMO DATA — NOT MEASURED, including in exports.

## Testing conventions

Tests drive real code paths; avoid mocks. `test/worker.test.js` loads the actual
`gpr/trace.worker.js` with a `self` shim so the whole stream → parse → analyze → post
chain is covered. File-like test doubles need both `text()` and a `stream()` returning a
`ReadableStream`. Large-file coverage uses synthetic traces generated in-process.

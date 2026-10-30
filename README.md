# Zeus vs Hades — Game Performance Reporter (GPR)

A browser-side engineering dashboard for investigating manually captured Zeus vs Hades performance runs. The current project extends the existing React/Vite application and uses browser-native SVG, File APIs, Web Workers, and print styles rather than adding UI/chart dependencies.

## What is implemented

- Overview, Performance Trends, Round Analysis, Bottlenecks, Traces, and Reports routes.
- An isolated 32-round synthetic fixture, always labelled **DEMO DATA — NOT MEASURED** in the application and its exports.
- Chrome trace JSON import with a drag-and-drop area and file browser fallback, a staged status machine (file selected → validating → reading → parsing → analyzing → completed / invalid / truncated / unsupported / cancelled / out of memory), measured byte-level progress only, elapsed time, and cancel/retry actions.
- A correct incremental JSON reader (`gpr/jsonStream.js`) that preserves parser state across chunk boundaries and rejects truncated traces with a truncation-specific message instead of a misleading comma/bracket error. There is no fixed file-size limit.
- An optional game-marker sidecar import and explicit round/event correlation.
- Shared analysis and report snapshot modules, trace evidence references, metric-coverage status, round summaries, and prioritized findings with explicit, overridable rules.
- Simple and Technical detail views backed by the same analysis data, plus accessible inline definitions for technical terms (`gpr/glossary.js`).
- Standalone HTML export with inline SVG charts and page numbers; print-ready HTML for the browser's **Save as PDF** workflow; four separate CSV exports (rounds, time-series samples, findings, and game events).
- Optional, bounded React Profiler callback and Redux-compatible timing middleware helpers in `gpr/instrumentation.js`. These are not connected to the Zeus vs Hades application.
- A Node built-in test suite in `test/gpr.test.js` (34 tests); its trace samples are clearly synthetic, not real Chrome recordings.

## Workspace usage

The project retains its existing Vite setup and package scripts. Run `npm run dev` to open the application, `npm test` for the Node test suite, and `npm run build` for the production bundle. No added package installation is required.

## Root causes fixed

1. **`Invalid JSON: Expected a comma or closing bracket.`** The previous parser decoded and split the file and then parsed each element, so a truncated or incomplete Chrome trace export produced a generic structural error. The reader now streams the JSON token by token, tracks string/escape/nesting state across chunk boundaries, and reports truncation explicitly. No chunk is ever parsed as standalone JSON, and no event is silently discarded.
2. **The 50 MB import limit.** The limit is gone. The file is read once as a stream, parsing runs in a Web Worker, and retained data is bounded per category (frames, heap samples, task candidates) with overflow counted and surfaced as a limitation rather than dropped silently.
3. **`Preview stopped: a loop ran longer than 400ms`.** The original design decoded the whole file and normalized every event on the UI thread, which starves the render loop. Parsing and analysis now run in a Web Worker, the UI only renders aggregated/downsampled series (≤1200 points per metric), and findings/round tables are capped with an explicit "showing N of M" note. The preview warning was a symptom of main-thread starvation, not a separate application bug.

### Imported results not appearing (fixed)

The dashboard previously updated only after a full reload. Two defects caused this and both are fixed:

- The file input kept its value after a selection, so choosing the same file again never fired a change event. File inputs now reset their value on every selection (`TraceFileInput`), so repeat imports and retries work.
- The result handoff was spread across several state updates with no ordering guarantee. A single import manager (`gpr/importSession.js`) now owns the lifecycle: it sequences each import, ignores results from a superseded import, and delivers the analyzed run through one callback that sets the run and resets dependent view state atomically. A failed import leaves the previous successful report in place and offers **Retry**.

### Metrics always showing empty (fixed)

CPU, heap, React, and Redux areas could render empty even for a valid trace. The causes and fixes:

- **Heap** was keyed only on some counter shapes. Chrome writes heap counters as `ph: "C"` `UpdateCounters` events with `args.data.jsHeapSizeUsed`. That key is now recognized, so heap samples are extracted instead of reported as missing.
- **Main-thread tasks** were filtered using `thread_name` metadata that Chrome sometimes writes *after* the tasks. The filter is now deferred to the end of normalization, so a trailing `thread_name` still classifies the thread. When no main-thread metadata exists at all, task metrics are reported as **Not captured** with an explanation rather than shown as zero.
- **Main-thread busy time** is now derived from merged task intervals (`mergeIntervals`), so nested or overlapping work is counted once. It is labelled as derived-from-tasks and kept strictly separate from CPU utilization, which is never invented.
- **React / Redux** data cannot exist in a Chrome trace, so that area now states it is **Not captured** and explains how to obtain it, instead of displaying zeros. The same availability status (`METRIC_STATUS`, `metricAvailability`) drives every KPI, the coverage grid, and a new **Trace diagnostics** panel that lists event counts, phases, categories, process/thread coverage, and every metric that could not be recovered.

### Import progress (fixed)

Progress is now a real state machine (`IMPORT_STAGES`) reported from the worker: validating → reading → parsing → normalizing → analyzing → findings → preparing → completed, with cancelled and error terminals. A measured percentage is shown only while reading, where bytes read is known; later stages show an indeterminate bar and a short explanation instead of a fake percentage. Elapsed time, file name/size, cancel, and retry are all surfaced, and progress notifications are throttled so React never re-renders once per trace event.

## Manual trace workflow

1. Capture a Performance recording in Chrome DevTools and export it as a JSON trace.
2. Open **Traces** and select or drop the exported JSON file. The file is streamed into a Web Worker; byte-level progress is shown while reading, trace analysis is calculated off the dashboard thread, and an in-progress import can be cancelled.
3. Inspect coverage, process/thread metadata, and recognized main-thread task events. Task durations are not CPU utilization.
4. If game markers are available, import the marker sidecar described below. Without explicit markers, round-level analysis remains unavailable.
5. Review overview/trends/findings and use the Reports actions to export data.

### Trace formats and known limits

Accepted JSON shapes are a top-level trace event array; `{ "traceEvents": [...] }`; and common `trace.traceEvents` / `data.traceEvents` wrappers. The parser handles complete-duration (`ph: "X"`) events, matched begin/end (`B`/`E`) pairs, metadata (`M`), and counter (`C`) events. Invalid timestamps, duplicate events, unmatched end markers, and incomplete begin/end pairs are safely skipped and reported in trace diagnostics and limitations. Unsupported formats are rejected, not converted to empty synthetic data.

Frame-rate samples are based on intervals between recognized frame marker events, not arbitrary task durations. Supported marker names currently include common names such as `DrawFrame`, `Frame`, `SubmitCompositorFrame`, `BeginFrame`, and `FramePresented`. Exact dropped-frame counts are not inferred. Heap samples are extracted only when recognized event arguments identify a heap byte value. Trace task durations never become a CPU percentage. Browser/process CPU utilization requires an explicit supported collector and is otherwise **Not captured**.

The parser reads JSON incrementally from the selected file in a Web Worker, avoiding a complete decoded-file string and keeping parsing off the dashboard thread. It retains parsed event data and normalized analysis structures in worker memory, so exceptionally large traces can still exceed available browser memory; such failures report a recommendation to reduce the recording window in DevTools. There is no arbitrary fixed file-size limit. No real Chrome trace fixture was present in the repository, so validation against real-world trace variants remains outstanding.

## Findings, views, and metric explanations

- Findings carry a title, severity, what happened, why it matters to gameplay, a timestamp or range, duration/recurrence, supporting evidence, investigation steps, and an evidence-quality statement. Measured facts are separated from interpretation, and the UI states that temporal overlap does not prove causation.
- Severity uses explicit, overridable rules in `gpr/model.js` (`THRESHOLDS`), including the long-task, frame-budget, CPU, React commit, and heap-growth thresholds. No universal performance score is produced.
- Findings are ranked by a transparent priority score (severity + duration + recurrence + evidence quality) and the contributing factors are shown on each finding.
- The **Simple** view presents plain-English findings, user impact, rounds, and next steps. The **Technical** view adds the trace timeline, distributions, raw event details, and provenance. Both views read the same analysis object.
- Missing metrics produce informational findings and **Not captured** placeholders; they are never shown as zero.

## Game marker contract

Import a JSON sidecar with an array of explicit markers. `timestampMs` is relative to the normalized trace start, or provide the original `traceTimestampUs` to align it to the trace's microsecond timestamp origin. Do not mix clock domains without an explicit conversion. Each marker needs an integer `roundId` and supported `type`:

```json
{
  "runId": "run-123",
  "clock": "monotonic-ms",
  "markers": [
    { "traceTimestampUs": 8123456, "roundId": 1, "type": "roundStart" },
    { "traceTimestampUs": 14423456, "roundId": 1, "type": "bonusStart", "name": "Free spins" },
    { "traceTimestampUs": 24023456, "roundId": 1, "type": "roundEnd" }
  ]
}
```

Supported types are `roundStart`, `roundEnd`, `bonusStart`, `bonusEnd`, `winAnimationStart`, and `winAnimationEnd`. The parser normalizes and sorts markers and removes exact duplicates. Round summaries require explicit start and end markers; incomplete rounds are marked incomplete rather than given invented boundaries. The current marker importer assumes the supplied clock alignment is valid; it does not estimate a clock offset or quantify alignment uncertainty. The marker `runId` is informational and is not yet checked against imported run metadata.

## Data, provenance, and analysis

- `gpr/model.js` contains shared source constants, explicit configurable thresholds, basic runtime validation, and coverage functions.
- `gpr/jsonStream.js` is the incremental JSON token reader used by the parser.
- `gpr/parser.js` owns trace and marker parsing; `gpr/trace.worker.js` and `gpr/traceWorkerClient.js` keep normalization, round correlation, summaries, findings, and display-series preparation off the main thread.
- `gpr/analyze.js` owns pure summary, round, finding, ranking, and baseline-compatibility helpers.
- `gpr/glossary.js` holds the plain-language definitions used by the in-UI term popovers.
- `gpr/demo.js` is kept separate from imported trace data.
- `gpr/reports.js` generates report snapshots and all export formats.

Normalized trace timestamps are milliseconds relative to the first valid trace timestamp; evidence references retain original trace microseconds. Trace charts and round rows show `+N ms` relative timestamps. Chrome trace wall-clock capture time is not assumed: the run reference timestamp is labelled as import time. Demo timestamps are relative to the fixture's `startedAt`. Missing measurements remain absent and are rendered as **Not captured**. Heap growth is only a potential-retention signal; GC timing, sampling interval, and workload variation matter. Correlation is not causation.

Baseline comparison compatibility checks currently exist as a domain helper, but the interface does not yet retain/select multiple runs or calculate deviations. No baseline deviation is shown without a compatible selected baseline.

## Exports

- **HTML:** portable report with an executive summary, prioritized findings, inline SVG trends, metric definitions, trace metadata and measurement coverage, technical evidence, page numbers, and limitations.
- **PDF:** opens the same print-styled report snapshot in a new browser window and invokes the browser print dialog. Choose **Save as PDF**. The layout uses `@page` sizing, avoids breaking cards and tables across pages, and prints page numbers. This is not a server-side PDF renderer; popup restrictions may require allowing the report window.
- **CSV:** downloads four separate files (rounds, samples, findings, game events) from one memoized report snapshot. CSV values are escaped for commas, quotes, and line breaks. Demo exports include the explicit demo label.

All exports are produced from a single snapshot of the currently analyzed run, so a report never reflects stale dashboard state. Browser settings may ask for confirmation when multiple CSV downloads are initiated. Temporary object URLs are revoked after download initiation.

## Optional instrumentation and capture status

`gpr/instrumentation.js` supplies disabled-by-default bounded recording helpers, a React Profiler callback factory, a Redux-compatible middleware, sampling, and basic recorder-overhead accounting. It avoids storing state or action payloads. Integrating it requires a development/test build of the game, Profiler boundaries around selected subtrees, and explicit run/round context. React Profiler does not identify every component or prove causation. Redux notification and selector timing require application-specific instrumentation. Compare representative profiling-disabled and profiling-enabled runs to understand overhead.

Automatic browser capture / CDP runner is **not implemented**. The dashboard does not execute shell commands. The working workflow is manual Chrome trace export and import. No Zeus vs Hades game code or shared Core was changed.

## Testing and remaining work

`npm test` runs 55 Node built-in tests across two files. `test/gpr.test.js` covers: successful small trace import; a valid trace above 50 MiB that is not size-rejected and still extracts real measurements; malformed, truncated, and empty inputs; unsupported wrapper shapes; parser chunk boundaries (including 1-byte chunks and escaped strings); repeated imports; cancellation; progress and completion signals; frame intervals and heap counters; missing metrics; round aggregation and incomplete boundaries; finding repeatability, ranking, rules, and evidence links; chart downsampling; and report/CSV consistency. `test/worker.test.js` drives the real worker entry point (`gpr/trace.worker.js`) with a `self` shim, covering the stream → parse → analyze → post chain, staged progress ordering, and truncation/empty/non-JSON error messages.

Additional coverage added for this round: heap extraction from `UpdateCounters`/`jsHeapSizeUsed`; busy-time merging that avoids double-counting nested tasks and stays distinct from CPU; main-thread filtering with trailing `thread_name` metadata; honest availability for absent CPU/heap/React/Redux; bounded category/phase/interval diagnostics; import state delivery without a reload; full stage progression; newest-import-wins ordering; failure preserving the previous report with retry; cancellation; validation-before-parse for unsupported and empty files; repeated imports of the same file; and progress throttling.

Verified in this environment (Node v24, vite 5.4.21, React 19.2.7):

- `npm test` — 55/55 passing.
- `npm run build` — production bundle built successfully.
- The application was rendered in a browser with the synthetic fixture loaded; the Overview four-KPI layout, availability statuses, diagnostics panel, and term popovers displayed without runtime errors.
- Large-file handling was verified with synthetic fixtures generated in-process (over 50 MiB, streamed in chunks). A real Chrome DevTools recording was not available in this repository, so validation against real-world trace variants remains outstanding. The browser tool used here cannot set a file on a `<input type=file>`, so the in-browser import path was exercised through the worker-level tests rather than a manual file pick.

Remaining integration work requires access to a real Zeus vs Hades build and recordings: validate actual trace event naming, provide trustworthy CPU/heap/frame sources where absent, instrument explicit game markers, connect and overhead-test the optional React/Redux helpers, implement multi-run baseline selection, and evaluate automatic CDP capture if the repository later adopts a suitable maintained integration.

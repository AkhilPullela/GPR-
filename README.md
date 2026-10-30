## Game Performance Reporter (GPR)

A browser-side engineering dashboard for investigating manually captured Zeus vs Hades performance runs. The current project extends the existing React/Vite application and uses browser-native SVG, File APIs, Web Workers, and print styles rather than adding UI/chart dependencies.

## What is implemented

- Overview, Performance Trends, Round Analysis, Bottlenecks, Traces, and Reports routes.
- An isolated 32-round synthetic fixture, always labelled **DEMO DATA — NOT MEASURED** in the application and its exports.
- Chrome trace JSON import with actionable format errors, streamed worker-based parsing without a fixed file-size cap, event/thread metadata, normalized relative timestamps, task inspection, supported frame intervals, and recognized heap counters.
- An optional game-marker sidecar import and explicit round/event correlation.
- Shared analysis and report snapshot modules, trace evidence references, metric-coverage status, round summaries, and findings.
- Standalone HTML export with inline SVG charts; print-ready HTML for the browser's **Save as PDF** workflow; four separate CSV exports (rounds, time-series samples, findings, and game events).
- Optional, bounded React Profiler callback and Redux-compatible timing middleware helpers in `gpr/instrumentation.js`. These are not connected to the Zeus vs Hades application.
- A Node built-in test suite in `test/gpr.test.js`; its trace sample is clearly synthetic, not a real Chrome recording.

## Workspace usage

The project retains its existing Vite setup and package scripts. Use the editor's Run action to open the application. The package also defines development, production-build, and Node test scripts using the repository's existing tools; no added package installation is required. No test or build result is claimed here because execution was not available during implementation.

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

- `gpr/model.js` contains shared source constants, basic runtime validation, and coverage functions.
- `gpr/parser.js` owns trace and marker parsing; `gpr/trace.worker.js` and `gpr/traceWorkerClient.js` keep normalization, round correlation, summaries, findings, and display-series preparation off the main thread.
- `gpr/analyze.js` owns pure summary, round, finding, and baseline-compatibility helpers.
- `gpr/demo.js` is kept separate from imported trace data.
- `gpr/reports.js` generates version-1 report snapshots and all export formats.

Normalized trace timestamps are milliseconds relative to the first valid trace timestamp; evidence references retain original trace microseconds. Trace charts and round rows show `+N ms` relative timestamps. Chrome trace wall-clock capture time is not assumed: the run reference timestamp is labelled as import time. Demo timestamps are relative to the fixture's `startedAt`. Missing measurements remain absent and are rendered as **Not captured**. Heap growth is only a potential-retention signal; GC timing, sampling interval, and workload variation matter. Correlation is not causation.

Baseline comparison compatibility checks currently exist as a domain helper, but the interface does not yet retain/select multiple runs or calculate deviations. No baseline deviation is shown without a compatible selected baseline.

## Exports

- **HTML:** portable report with inline SVG trends, metadata, coverage, findings, rounds, and limitations.
- **PDF:** opens the same print-styled report snapshot in a new browser window and invokes the browser print dialog. Choose **Save as PDF**. This is not a server-side PDF renderer; popup restrictions may require allowing the report window.
- **CSV:** downloads four separate files from one memoized report snapshot. CSV values are escaped for commas, quotes, and line breaks. Demo exports include the explicit demo label.

Browser settings may ask for confirmation when multiple CSV downloads are initiated. Temporary object URLs are revoked after download initiation.

## Optional instrumentation and capture status

`gpr/instrumentation.js` supplies disabled-by-default bounded recording helpers, a React Profiler callback factory, a Redux-compatible middleware, sampling, and basic recorder-overhead accounting. It avoids storing state or action payloads. Integrating it requires a development/test build of the game, Profiler boundaries around selected subtrees, and explicit run/round context. React Profiler does not identify every component or prove causation. Redux notification and selector timing require application-specific instrumentation. Compare representative profiling-disabled and profiling-enabled runs to understand overhead.

Automatic browser capture / CDP runner is **not implemented**. The dashboard does not execute shell commands. The working workflow is manual Chrome trace export and import. No Zeus vs Hades game code or shared Core was changed.

## Testing and remaining work

The test suite exercises streamed trace imports below and above 50 MiB, large event arrays, malformed/truncated/empty inputs, supported trace wrappers, chunk-boundary parsing, cancellation and repeated imports, nested duration pairing, timestamp normalization, frame intervals, markers, round aggregation, missing metrics, finding repeatability, CSV escaping, and demo export labelling. Browser UI end-to-end checks and real-trace validation remain outstanding; tests have not been executed in this environment.

Remaining integration work requires access to a real Zeus vs Hades build and recordings: validate actual trace event naming, provide trustworthy CPU/heap/frame sources where absent, instrument explicit game markers, connect and overhead-test the optional React/Redux helpers, implement multi-run baseline selection, and evaluate automatic CDP capture if the repository later adopts a suitable maintained integration.

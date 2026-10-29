import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChromeTraceFile, parseChromeTraceText, parseMarkerText } from '../gpr/parser.js';
import { summarizeRun, summarizeRounds, generateFindings, compareBaseline } from '../gpr/analyze.js';
import { toCsv, reportHtml, reportCsvFiles, createSnapshot } from '../gpr/reports.js';
import { createDemoRun } from '../gpr/demo.js';
import { SOURCE } from '../gpr/model.js';
import { parseChromeTraceInWorker } from '../gpr/traceWorkerClient.js';

const syntheticTrace = JSON.stringify({ traceEvents: [
  { pid: 1, tid: 2, ts: 1000000, ph: 'M', name: 'thread_name', args: { name: 'CrRendererMain' } },
  { pid: 1, tid: 2, ts: 1000001, ph: 'X', name: 'RunTask', cat: 'toplevel', dur: 60000 },
  { pid: 1, tid: 2, ts: 1060001, ph: 'B', name: 'EvaluateScript', cat: 'devtools.timeline' },
  { pid: 1, tid: 2, ts: 1065001, ph: 'E' },
  { pid: 1, tid: 2, ts: 1070000, ph: 'X', name: 'DrawFrame', cat: 'viz', dur: 16000 },
  { pid: 1, tid: 2, ts: 1086667, ph: 'X', name: 'DrawFrame', cat: 'viz', dur: 15000 },
  { pid: 1, tid: 2, ts: 1087000, ph: 'C', name: 'V8.Memory' , args: { usedHeapSize: 1048576 } }
] });

function chunkedFile(text, chunkSize) {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    stream() {
      return new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
          }
          controller.close();
        }
      });
    }
  };
}

test('parses a synthetic Chrome trace with duration, B/E, frame, heap, and thread data', () => {
  const run = parseChromeTraceText(syntheticTrace, 'synthetic-test.json');
  assert.equal(run.source, SOURCE.TRACE);
  assert.equal(run.tasks.length, 2);
  assert.equal(run.tasks.find(task => task.durationMs >= 50).durationMs, 60);
  assert.ok(run.samples.some(s => Number.isFinite(s.frameDurationMs)));
  assert.ok(run.samples.some(s => s.jsHeapUsedBytes === 1048576));
  assert.equal(run.samples.some(s => Number.isFinite(s.cpuPercent)), false);
  assert.equal(run.metadata.mainThreadDetected, true);
});

test('deduplicates repeated trace events without inventing extra frames', () => {
  const frame = { pid: 4, tid: 8, ts: 2000, ph: 'X', name: 'DrawFrame', dur: 1000 };
  const run = parseChromeTraceText(JSON.stringify([frame, frame, { ...frame, ts: 19000 }]), 'duplicates.synthetic.json');
  assert.equal(run.samples.length, 1);
  assert.equal(run.metadata.eventCount, 3);
  assert.equal(run.metadata.normalizedEventCount, 2);
  assert.equal(run.metadata.diagnostics.duplicateEventCount, 1);
});

test('reports malformed timestamps and incomplete duration pairs', () => {
  const run = parseChromeTraceText(JSON.stringify([
    { pid: 1, tid: 1, ts: 'bad', ph: 'X', name: 'InvalidTimestamp', dur: 10 },
    { pid: 1, tid: 1, ts: 1000, ph: 'B', name: 'UnfinishedTask' },
    { pid: 1, tid: 1, ts: 2000, ph: 'E', name: 'UnmatchedTask' },
    { pid: 1, tid: 1, ts: 3000, ph: 'X', name: 'ValidTask', dur: 1000 }
  ]));
  assert.equal(run.metadata.diagnostics.malformedTimestampCount, 1);
  assert.equal(run.metadata.diagnostics.unmatchedEndCount, 1);
  assert.equal(run.metadata.diagnostics.incompleteBeginCount, 1);
  assert.ok(run.metadata.limitations.some(note => note.includes('invalid timestamps')));
});

test('rejects malformed and unsupported trace files with actionable errors', () => {
  assert.throws(() => parseChromeTraceText(''), /Invalid JSON/);
  assert.throws(() => parseChromeTraceText('{}'), /Unsupported trace JSON/);
  assert.throws(() => parseChromeTraceText('{"traceEvents":[]}'), /no events/i);
});

test('streams files below 50 MiB and preserves supported wrapper metadata and event details', async () => {
  const file = new Blob([JSON.stringify({ metadata: { buildId: 'stream-build', environment: 'test' }, trace: { traceEvents: [
    { pid: 7, tid: 9, ts: 123000, ph: 'M', name: 'thread_name', args: { name: 'CrRendererMain' } },
    { pid: 7, tid: 9, ts: 124000, ph: 'X', name: 'RunTask', cat: 'toplevel', dur: 51000, args: { detail: 'kept' } }
  ] } })]);
  const progress = [];
  const run = await parseChromeTraceFile(file, 'small.json', value => progress.push(value));
  assert.equal(run.metadata.eventCount, 2);
  assert.equal(run.metadata.mainThreadDetected, true);
  assert.equal(run.buildId, 'stream-build');
  assert.equal(run.tasks[0].evidence.category, 'toplevel');
  assert.equal(run.tasks[0].evidence.processId, 7);
  assert.ok(progress.some(value => value.complete));
});

test('streams valid trace files larger than 50 MiB without a fixed size rejection', async () => {
  const padding = ' '.repeat(1024 * 1024);
  const trace = JSON.stringify({ traceEvents: [{ pid: 1, tid: 1, ts: 1, ph: 'X', name: 'LargeFileEvent', cat: 'test', dur: 10 }] });
  const file = new Blob([...Array(51).fill(padding), trace]);
  assert.ok(file.size > 50 * 1024 * 1024);
  const run = await parseChromeTraceFile(file, 'over-50MiB.json');
  assert.equal(run.metadata.eventCount, 1);
  assert.equal(run.metadata.normalizedEventCount, 1);
});

test('stream parser accepts top-level arrays and data.traceEvents wrapper shapes', async () => {
  for (const source of [
    [{ pid: 1, tid: 1, ts: 10, ph: 'X', name: 'ArrayEvent', dur: 1 }],
    { data: { traceEvents: [{ pid: 1, tid: 1, ts: 10, ph: 'X', name: 'DataEvent', dur: 1 }] } }
  ]) {
    const run = await parseChromeTraceFile(new Blob([JSON.stringify(source)]));
    assert.equal(run.metadata.eventCount, 1);
    assert.equal(run.metadata.normalizedEventCount, 1);
  }
});

test('stream JSON parser preserves state across chunk boundaries in strings and nested structures', async () => {
  const source = {
    metadata: { buildId: 'chunked-build', nested: [{ label: 'escaped \\\"quote\\\" and \\\\ slash — 帧' }] },
    traceEvents: [
      { pid: 21, tid: 34, ts: 987654, ph: 'M', name: 'thread_name', args: { name: 'CrRendererMain' } },
      {
        pid: 21, tid: 34, ts: 987654, ph: 'X', name: 'EvaluateScript', cat: 'toplevel.category', dur: 4321,
        args: { nested: [{ text: 'line\\nvalue \\\"quoted\\\"', values: [1, true, null, { deep: 'ok' }] }] }
      }
    ]
  };
  const text = JSON.stringify(source);
  for (const chunkSize of [1, 2, 3, 7, 13]) {
    const run = await parseChromeTraceFile(chunkedFile(text, chunkSize), `chunk-${chunkSize}.json`);
    assert.equal(run.metadata.eventCount, 2);
    assert.equal(run.buildId, 'chunked-build');
    assert.equal(run.tasks[0].timestampMs, 0);
    assert.equal(run.tasks[0].durationMs, 4.321);
    assert.equal(run.tasks[0].evidence.processId, 21);
    assert.equal(run.tasks[0].evidence.threadId, 34);
    assert.equal(run.tasks[0].evidence.category, 'toplevel.category');
    assert.equal(run.tasks[0].eventName, 'EvaluateScript');
  }
});

test('stream parser rejects truncated JSON without attempting to repair it', async () => {
  await assert.rejects(parseChromeTraceFile(chunkedFile('{"traceEvents":[{"pid":1,"ts":1,"ph":"X","dur":1}', 2)), /Invalid JSON/);
});

test('streams large event arrays without dropping events', async () => {
  const events = Array.from({ length: 5000 }, (_, i) => ({ pid: 2, tid: 3, ts: i + 1, ph: 'X', name: 'Task', cat: 'test', dur: 1 }));
  const run = await parseChromeTraceFile(new Blob([JSON.stringify({ traceEvents: events })]), 'many-events.json');
  assert.equal(run.metadata.eventCount, events.length);
  assert.equal(run.metadata.normalizedEventCount, events.length);
});

test('repeated parsing of an unchanged file yields stable normalized event data', async () => {
  const file = new Blob([syntheticTrace]);
  const first = await parseChromeTraceFile(file, 'repeat.json');
  const second = await parseChromeTraceFile(file, 'repeat.json');
  assert.equal(first.metadata.eventCount, second.metadata.eventCount);
  assert.equal(first.metadata.normalizedEventCount, second.metadata.normalizedEventCount);
  assert.deepEqual(first.samples.map(sample => [sample.timestampMs, sample.fps, sample.jsHeapUsedBytes]), second.samples.map(sample => [sample.timestampMs, sample.fps, sample.jsHeapUsedBytes]));
});

test('reuses completed worker normalization for the same immutable file object', async () => {
  const priorWorker = globalThis.Worker;
  let workerCount = 0;
  const result = { id: 'cached-run' };
  globalThis.Worker = class {
    constructor() { workerCount++; }
    postMessage() { queueMicrotask(() => this.onmessage({ data: { type: 'result', run: result } })); }
    terminate() {}
  };
  try {
    const file = new Blob(['trace']);
    const first = await parseChromeTraceInWorker(file, 'cache.json');
    const second = await parseChromeTraceInWorker(file, 'cache.json');
    assert.equal(first, result);
    assert.equal(second, result);
    assert.equal(workerCount, 1);
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = priorWorker;
  }
});

test('an active worker import can be cancelled and terminates its worker', async () => {
  const priorWorker = globalThis.Worker;
  let createdWorker;
  globalThis.Worker = class {
    constructor() { createdWorker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  const controller = new AbortController();
  try {
    const pending = parseChromeTraceInWorker(new Blob(['{}']), 'cancel.json', () => {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(createdWorker.terminated, true);
  } finally {
    if (priorWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = priorWorker;
  }
});

test('stream parser reports malformed JSON and empty trace files clearly', async () => {
  await assert.rejects(parseChromeTraceFile(new Blob(['{"traceEvents":[']), 'broken.json'), /Invalid JSON/);
  await assert.rejects(parseChromeTraceFile(new Blob(['{"traceEvents":[]}']), 'empty.json'), /no events/i);
});

test('normalizes timestamps and safely ignores incomplete begin/end pairs', () => {
  const run = parseChromeTraceText(JSON.stringify([{ pid: 1, tid: 1, ts: 500000, ph: 'B', name: 'orphan' }, { pid: 1, tid: 1, ts: 510000, ph: 'X', name: 'DrawFrame', dur: 17000 }, { pid: 1, tid: 1, ts: 527000, ph: 'X', name: 'DrawFrame', dur: 16000 }]));
  assert.equal(run.samples[0].timestampMs, 27);
  assert.equal(run.tasks.length, 0);
});

test('pairs named and unnamed duration ends without losing nested begins', () => {
  const run = parseChromeTraceText(JSON.stringify([
    { pid: 1, tid: 2, ts: 100, ph: 'B', name: 'outer' },
    { pid: 1, tid: 2, ts: 110, ph: 'B', name: 'inner' },
    { pid: 1, tid: 2, ts: 120, ph: 'E', name: 'outer' },
    { pid: 1, tid: 2, ts: 130, ph: 'E' }
  ]));
  assert.equal(run.metadata.normalizedEventCount, 2);
  assert.equal(run.metadata.diagnostics.incompleteBeginCount, 0);
});

test('parses aligned markers and rejects invalid marker definitions', () => {
  const markers = parseMarkerText(JSON.stringify({ markers: [{ traceTimestampUs: 1010000, roundId: 1, type: 'roundStart' }, { timestampMs: 35, roundId: 1, type: 'roundEnd' }] }), 1000000);
  assert.deepEqual(markers.map(m => m.timestampMs), [10, 35]);
  assert.throws(() => parseMarkerText('{"markers":[{"timestampMs":2,"roundId":"x","type":"roundStart"}]}'), /Marker 1 is invalid/);
});

test('summarizes metrics while preserving unavailable data', () => {
  const run = { samples: [{ timestampMs: 0, cpuPercent: 20, fps: 60, frameDurationMs: 16, jsHeapUsedBytes: 100, source: SOURCE.TRACE }, { timestampMs: 10, cpuPercent: 40, fps: 30, frameDurationMs: 34, jsHeapUsedBytes: 160, source: SOURCE.TRACE }], tasks: [{ timestampMs: 0, durationMs: 60 }], events: [], findings: [] };
  const summary = summarizeRun(run);
  assert.equal(summary.cpuAvg, 30);
  assert.equal(summary.fpsAvg, 45);
  assert.equal(summary.frameP95, 33.1);
  assert.equal(summary.heapDelta, 60);
  assert.equal(summary.longTasks, 1);
  assert.equal(summary.reactCommitP95, undefined);
});

test('aggregates explicit rounds and reports incomplete boundaries', () => {
  const run = { samples: [{ timestampMs: 4, fps: 60, source: SOURCE.TRACE }], tasks: [], findings: [], events: [{ timestampMs: 0, roundId: 1, type: 'roundStart' }, { timestampMs: 10, roundId: 1, type: 'roundEnd' }, { timestampMs: 20, roundId: 2, type: 'roundStart' }] };
  const rounds = summarizeRounds(run);
  assert.equal(rounds[0].fpsAvg, 60);
  assert.equal(rounds[1].incomplete, true);
});

test('findings are repeatable and baseline compatibility warns on mismatch', () => {
  const run = { id: 'a', buildId: 'b', environment: 'e', source: SOURCE.TRACE, samples: [], tasks: [{ timestampMs: 1, durationMs: 80 }], events: [], findings: [] };
  assert.deepEqual(generateFindings(run).map(f => f.id), generateFindings(run).map(f => f.id));
  assert.equal(compareBaseline(run, { ...run, buildId: 'other' }).compatible, false);
});

test('CSV escaping and all report exports preserve demo labelling and missing metrics', () => {
  assert.equal(toCsv([{ value: 'a,"b"\nc' }], [{ label: 'value', value: 'value' }]), 'value\r\n"a,""b""\nc"');
  const snapshot = createSnapshot(createDemoRun());
  const html = reportHtml(snapshot), files = reportCsvFiles(snapshot);
  assert.match(html, /DEMO DATA — NOT MEASURED/);
  assert.match(files.samples, /cpu_percent/);
  assert.equal(Object.keys(files).length, 4);
  assert.match(html, /Not captured/);
});

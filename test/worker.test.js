import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Exercises the real worker entry point (gpr/trace.worker.js) by providing the
// `self` global it posts through, so the whole parse -> analyze -> post chain is
// covered rather than a re-implementation of it.
const workerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'gpr', 'trace.worker.js');
const messages = [];
globalThis.self = { postMessage: message => messages.push(message) };
await import(workerPath);

function fakeFile(text, name) {
  const bytes = new TextEncoder().encode(text);
  return {
    name, size: bytes.length, type: 'application/json',
    text: async () => text,
    stream: () => new ReadableStream({
      start(controller) { const chunk = 65536; for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.subarray(i, i + chunk)); controller.close(); }
    })
  };
}

function makeTrace(frames, { heap = true } = {}) {
  const events = [
    { pid: 100, tid: 0, ts: 1000000, ph: 'M', name: 'process_name', args: { name: 'Renderer' } },
    { pid: 100, tid: 259, ts: 1000000, ph: 'M', name: 'thread_name', args: { name: 'CrRendererMain' } }
  ];
  let ts = 1001000;
  for (let i = 0; i < frames; i++) {
    events.push({ pid: 100, tid: 259, ts, ph: 'X', name: 'FireAnimationFrame', cat: 'devtools.timeline', dur: 12000 });
    events.push({ pid: 100, tid: 259, ts: ts + 100, ph: 'B', name: 'RunTask', cat: 'toplevel' });
    events.push({ pid: 100, tid: 259, ts: ts + 100 + (i % 25 === 0 ? 80000 : 4000), ph: 'E', name: 'RunTask' });
    if (heap) events.push({ pid: 100, tid: 259, ts: ts + 3000, ph: 'C', name: 'UpdateCounters', args: { data: { jsHeapSizeUsed: 300000000 + i * 500000 } } });
    ts += 16667;
  }
  return JSON.stringify({ traceEvents: events, metadata: { buildId: 'worker-test' } });
}

const run = data => self.onmessage({ data });
const last = type => [...messages].reverse().find(message => message.type === type);

test('the worker streams, parses, and analyzes a trace, posting staged progress then a result', async () => {
  messages.length = 0;
  const text = makeTrace(200);
  await run({ type: 'parse', fileName: 'worker.json', file: fakeFile(text, 'worker.json') });
  const stages = [...new Set(messages.filter(m => m.type === 'progress').map(m => m.stage))];
  assert.deepEqual(stages, ['validating', 'reading', 'parsing', 'normalizing', 'analyzing', 'findings', 'preparing']);
  const result = last('result');
  assert.ok(result, 'worker must post a result');
  assert.equal(result.run.analysis.summary.availability.mainThreadBusy.status, 'captured');
  assert.ok(result.run.analysis.summary.busyAvg > 0);
  assert.equal(result.run.analysis.summary.availability.cpuPercent.available, false);
  assert.ok(result.run.samples.some(sample => sample.jsHeapUsedBytes === 300000000));
});

test('the worker reports truncated JSON with a truncation message, never a comma/bracket error', async () => {
  messages.length = 0;
  await run({ type: 'parse', fileName: 'broken.json', file: fakeFile('{"traceEvents":[{"pid":1,"ts":1,', 'broken.json') });
  const error = last('error');
  assert.ok(error);
  assert.match(error.message, /truncat|incomplete|Invalid JSON/i);
  assert.doesNotMatch(error.message, /Expected a comma or closing bracket/);
  assert.match(error.message, /original file was not modified/i);
});

test('the worker reports an empty file as incomplete instead of crashing', async () => {
  messages.length = 0;
  await run({ type: 'parse', fileName: 'empty.json', file: fakeFile('', 'empty.json') });
  assert.match(last('error').message, /empty|incomplete/i);
});

test('the worker rejects a non-JSON wrapper with an actionable message', async () => {
  messages.length = 0;
  await run({ type: 'parse', fileName: 'weird.json', file: fakeFile('"just a string"', 'weird.json') });
  assert.ok(last('error').message.length > 20);
});

test('the worker forwards parsed event counts so the UI can show real parsing progress', async () => {
  messages.length = 0;
  await run({ type: 'parse', fileName: 'big.json', file: fakeFile(makeTrace(600), 'big.json') });
  const parsing = messages.filter(m => m.type === 'progress' && m.stage === 'parsing' && Number.isFinite(m.eventCount));
  assert.ok(parsing.length > 0, 'worker must forward parsing event counts');
  for (let i = 1; i < parsing.length; i++) assert.ok(parsing[i].eventCount >= parsing[i - 1].eventCount);
  assert.ok(parsing.every(m => /events parsed/.test(m.message)));
  assert.ok(last('result'), 'a result must still be delivered');
});

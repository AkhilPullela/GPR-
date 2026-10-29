import { SOURCE, validateRun } from './model.js';
import { JsonTokenReader, MalformedJsonError, TruncatedJsonError } from './jsonStream.js';

const num = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : undefined;

const FRAME_NAMES = /^(DrawFrame|Frame|SubmitCompositorFrame|FireAnimationFrame|BeginFrame|PipelineReporter|Graphics\.Pipeline|FramePresented)$/i;
const TASK_NAMES = /^(RunTask|ThreadControllerImpl::RunTask|TaskQueueManager::ProcessTask|EvaluateScript|FunctionCall|v8\.compile|UpdateLayoutTree|Layout|Paint|CompositeLayers)$/i;
const HEAP_NAMES = /heap|memory|v8\.gc|jsHeap/i;
const MAIN_THREAD_NAMES = /CrRendererMain|RendererMain|Main Thread/i;

// Bounds keep peak memory predictable on very large recordings. Anything that
// exceeds a bound is counted and surfaced in trace diagnostics rather than
// silently discarded.
const LIMITS = Object.freeze({ frames: 750000, heapSamples: 750000, tasks: 400000 });

const hash32 = (text, seed) => {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};

/**
 * A streaming trace normalizer.
 *
 * `accept(event)` is called once per JSON array element, in file order.
 * `finish()` produces the normalized run. Nothing but compact per-category
 * records is retained, so memory stays proportional to the interesting
 * measurements rather than to the whole event list.
 */
export function createTraceNormalizer(fileName = 'trace.json', options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };
  const processes = new Map();
  const threadNames = new Map();
  const pendingByThread = new Map();
  const namedIndex = new Map();
  const seenSignatures = new Set();
  const processIds = new Set();
  const frames = [];
  const heap = [];
  const taskCandidates = [];
  const dropped = { frames: 0, heapSamples: 0, tasks: 0 };

  let eventCount = 0, normalizedEventCount = 0, malformedTimestampCount = 0, duplicateEventCount = 0;
  let unmatchedEndCount = 0, incompleteBeginCount = 0, mainThreadDurationCount = 0;
  let minTs = Infinity, maxTs = -Infinity, hasAnyTimestamp = false;
  let mainThreadKey;

  const signatureFor = event => {
    const argsText = event.args === undefined ? '' : JSON.stringify(event.args);
    const core = `${event.pid ?? ''}\u0001${event.tid ?? ''}\u0001${event.ts ?? ''}\u0001${event.ph ?? ''}\u0001${event.name ?? ''}\u0001${event.cat ?? ''}\u0001${event.dur ?? ''}\u0001${argsText}`;
    const high = hash32(core, 2166136261) & 0x1fffff;
    const low = hash32(core, 2166136261 ^ 0x9e3779b9);
    return high * 0x100000000 + low;
  };

  function emitDuration(event, timestampUs, durationUs) {
    normalizedEventCount++;
    const threadKey = `${event.pid ?? ''}:${event.tid ?? ''}`;
    const name = event.name || '';
    const onMain = threadKey === mainThreadKey;
    if (onMain) mainThreadDurationCount++;
    if (FRAME_NAMES.test(name)) {
      if (frames.length < limits.frames) frames.push({ ts: timestampUs, pid: event.pid, tid: event.tid, name, cat: event.cat });
      else dropped.frames++;
    }
    if (event.ph === 'C' || HEAP_NAMES.test(name)) {
      const args = { ...(event.args || {}), ...(event.args?.data || {}) };
      const heapBytes = num(args.usedHeapSize ?? args.jsHeapUsedSize ?? args.jsHeapUsedBytes ?? args.used_bytes);
      if (heapBytes !== undefined && heapBytes >= 0) {
        if (heap.length < limits.heapSamples) heap.push({ ts: timestampUs, bytes: heapBytes, pid: event.pid, tid: event.tid, name, cat: event.cat, durationUs });
        else dropped.heapSamples++;
      }
    }
    if (durationUs / 1000 >= 50 || TASK_NAMES.test(name)) {
      if (taskCandidates.length < limits.tasks) taskCandidates.push({ ts: timestampUs, durationUs, name, pid: event.pid, tid: event.tid, cat: event.cat, threadKey });
      else dropped.tasks++;
    }
  }

  function accept(rawEvent) {
    eventCount++;
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) { malformedTimestampCount++; return; }
    const ts = num(rawEvent.ts);
    if (ts === undefined) { malformedTimestampCount++; return; }
    const signature = signatureFor(rawEvent);
    if (seenSignatures.has(signature)) { duplicateEventCount++; return; }
    seenSignatures.add(signature);
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
    hasAnyTimestamp = true;
    if (rawEvent.pid !== undefined) processIds.add(rawEvent.pid);
    const threadKey = `${rawEvent.pid ?? ''}:${rawEvent.tid ?? ''}`;

    if (rawEvent.ph === 'M') {
      if (rawEvent.name === 'process_name') processes.set(rawEvent.pid, rawEvent.args?.name ?? rawEvent.args?.data?.name ?? '');
      if (rawEvent.name === 'thread_name') {
        const threadName = rawEvent.args?.name ?? rawEvent.args?.data?.name ?? '';
        threadNames.set(threadKey, threadName);
        if (mainThreadKey === undefined && MAIN_THREAD_NAMES.test(threadName)) mainThreadKey = threadKey;
      }
      return;
    }
    if (rawEvent.ph === 'B') {
      const stack = pendingByThread.get(threadKey) || [];
      const entry = { ts, name: rawEvent.name || '', pid: rawEvent.pid, tid: rawEvent.tid, cat: rawEvent.cat, active: true };
      stack.push(entry);
      pendingByThread.set(threadKey, stack);
      if (entry.name) {
        const key = `${threadKey}\u0001${entry.name}`;
        const named = namedIndex.get(key) || [];
        named.push(entry);
        namedIndex.set(key, named);
      }
      return;
    }
    if (rawEvent.ph === 'E') {
      const stack = pendingByThread.get(threadKey) || [];
      let entry;
      if (rawEvent.name) {
        const named = namedIndex.get(`${threadKey}\u0001${rawEvent.name}`) || [];
        while (named.length && !named.at(-1).active) named.pop();
        entry = named.pop();
      } else {
        while (stack.length && !stack.at(-1).active) stack.pop();
        entry = stack.pop();
      }
      if (entry) {
        entry.active = false;
        const durationUs = ts - entry.ts;
        if (durationUs >= 0) emitDuration({ ph: 'X', name: entry.name, pid: entry.pid, tid: entry.tid, cat: entry.cat }, entry.ts, durationUs);
      } else unmatchedEndCount++;
      return;
    }
    if (rawEvent.ph === 'X') {
      const durationUs = num(rawEvent.dur);
      if (durationUs !== undefined && durationUs >= 0) emitDuration(rawEvent, ts, durationUs);
      return;
    }
    if (rawEvent.ph === 'C') emitDuration(rawEvent, ts, 0);
  }

  function finish(meta = {}) {
    const buildId = meta.buildId || options.metadata?.buildId || 'unknown-build';
    const environment = meta.environment || options.metadata?.environment || 'Browser environment not provided';
    for (const stack of pendingByThread.values()) for (const entry of stack) if (entry.active) incompleteBeginCount++;
    if (!eventCount) throw new Error('The trace contains no events. Export a non-empty Chrome DevTools Performance trace.');
    if (!hasAnyTimestamp) throw new Error('No events have valid microsecond timestamps (ts). This file is not a supported Chrome trace.');
    if (!normalizedEventCount) throw new Error('No complete-duration, counter, or matched begin/end events were found. Try exporting a full Chrome Performance trace.');
    const timeOrigin = minTs;

    const evidenceFor = (record, durationUs) => ({ traceFile: fileName, startUs: record.ts, durationUs, processId: record.pid, threadId: record.tid, eventName: record.name, category: record.cat });
    const samples = [];
    for (const record of heap) {
      samples.push({ timestampMs: (record.ts - timeOrigin) / 1000, jsHeapUsedBytes: record.bytes, source: SOURCE.TRACE, evidence: evidenceFor(record, record.durationUs) });
    }
    const frameGroups = new Map();
    for (const record of frames) {
      const key = `${record.pid ?? ''}:${record.tid ?? ''}:${record.name}`;
      const group = frameGroups.get(key) || [];
      group.push(record);
      frameGroups.set(key, group);
    }
    for (const group of frameGroups.values()) {
      group.sort((a, b) => a.ts - b.ts);
      for (let i = 1; i < group.length; i++) {
        const previous = group[i - 1], current = group[i];
        const intervalMs = (current.ts - previous.ts) / 1000;
        if (intervalMs > 0 && intervalMs <= 1000) {
          samples.push({
            timestampMs: (current.ts - timeOrigin) / 1000, frameDurationMs: intervalMs, fps: 1000 / intervalMs, source: SOURCE.TRACE,
            evidence: { traceFile: fileName, startUs: previous.ts, durationUs: current.ts - previous.ts, processId: current.pid, threadId: current.tid, eventName: current.name, category: current.cat }
          });
        }
      }
    }
    samples.sort((a, b) => a.timestampMs - b.timestampMs);

    if (mainThreadKey === undefined) {
      const candidate = [...threadNames.entries()].find(([, name]) => MAIN_THREAD_NAMES.test(name));
      if (candidate) mainThreadKey = candidate[0];
    }
    const tasks = [];
    for (const candidate of taskCandidates) {
      const inMain = mainThreadKey !== undefined
        ? candidate.threadKey === mainThreadKey
        : /RunTask|EvaluateScript|FunctionCall/i.test(candidate.name) && /main/i.test(threadNames.get(candidate.threadKey) || '');
      if (!inMain) continue;
      tasks.push({
        timestampMs: (candidate.ts - timeOrigin) / 1000, durationMs: candidate.durationUs / 1000, eventName: candidate.name, roundId: undefined,
        evidence: evidenceFor(candidate, candidate.durationUs)
      });
    }
    tasks.sort((a, b) => a.timestampMs - b.timestampMs);

    const threadInfoSet = new Set();
    for (const [key, name] of threadNames) {
      if (threadInfoSet.size >= 80) break;
      const [pid] = key.split(':');
      threadInfoSet.add(`${key} ${processes.get(Number(pid)) || processes.get(pid) || 'process'} / ${name || 'unnamed thread'}`);
    }
    if (!threadInfoSet.size) for (const pid of processIds) { if (threadInfoSet.size >= 80) break; threadInfoSet.add(`${pid}:? ${processes.get(pid) || 'process'} / unnamed thread`); }

    const limitations = ['Chrome traces generally do not provide whole-system or browser CPU utilization.', 'Game rounds require separately imported, clock-aligned markers.', 'Frame and heap events are extracted only for recognized event shapes.'];
    if (malformedTimestampCount) limitations.push(`${malformedTimestampCount} event(s) with invalid timestamps were skipped.`);
    if (duplicateEventCount) limitations.push(`${duplicateEventCount} duplicate event(s) were discarded.`);
    if (unmatchedEndCount) limitations.push(`${unmatchedEndCount} unmatched duration end marker(s) were ignored.`);
    if (incompleteBeginCount) limitations.push(`${incompleteBeginCount} duration begin marker(s) had no matching end marker.`);
    if (!mainThreadDurationCount) limitations.push('Renderer main-thread metadata was not identified; long-task coverage may be incomplete.');
    const droppedTotal = dropped.frames + dropped.heapSamples + dropped.tasks;
    if (droppedTotal) limitations.push(`${droppedTotal} measurement(s) exceeded the bounded retention limit and were summarized only by counts: ${dropped.frames} frame event(s), ${dropped.heapSamples} heap sample(s), ${dropped.tasks} task candidate(s).`);

    const run = {
      id: `trace-${Date.now()}`, game: 'Zeus vs Hades',
      buildId,
      environment,
      startedAt: new Date().toISOString(), source: SOURCE.TRACE,
      samples, events: [], findings: [], tasks,
      metadata: {
        fileName, fileSize: options.fileSize, sourceFormat: options.sourceFormat,
        eventCount, normalizedEventCount,
        processCount: processIds.size,
        threadInfo: [...threadInfoSet], traceOriginUs: timeOrigin, mainThreadDetected: Boolean(mainThreadKey),
        traceDurationMs: Number.isFinite(maxTs) && Number.isFinite(minTs) ? (maxTs - minTs) / 1000 : undefined,
        diagnostics: { malformedTimestampCount, duplicateEventCount, unmatchedEndCount, incompleteBeginCount, dropped },
        limitations
      }
    };
    return validateRun(run);
  }

  return { accept, finish };
}

export function parseChromeTraceText(text, fileName = 'trace.json') {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON: ${error.message}. The original file was not modified.`); }
  const events = Array.isArray(raw) ? raw
    : Array.isArray(raw?.traceEvents) ? raw.traceEvents
    : Array.isArray(raw?.trace?.traceEvents) ? raw.trace.traceEvents
    : Array.isArray(raw?.data?.traceEvents) ? raw.data.traceEvents
    : null;
  if (!events) throw new Error('Unsupported trace JSON. Expected an array of trace events or an object containing "traceEvents".');
  if (!events.length) throw new Error('The trace contains no events. Export a non-empty Chrome DevTools Performance trace.');
  const normalizer = createTraceNormalizer(fileName, {
    sourceFormat: Array.isArray(raw) ? 'array' : 'object',
    metadata: { buildId: raw?.metadata?.buildId, environment: raw?.metadata?.environment }
  });
  for (const event of events) normalizer.accept(event);
  return normalizer.finish();
}

function describeReadError(error) {
  if (error instanceof TruncatedJsonError) return `Invalid JSON: ${error.message} The original file was not modified; re-export the full recording from Chrome DevTools and try again.`;
  if (error instanceof MalformedJsonError) return `Invalid JSON: ${error.message} The original file was not modified; confirm it is a Chrome DevTools Performance JSON export.`;
  if (error instanceof SyntaxError) return `Invalid JSON: ${error.message}. The original file was not modified.`;
  if (error?.name === 'AbortError') return 'Trace import was cancelled. The original file was not modified; select it again to retry.';
  if (['NotReadableError', 'NotFoundError'].includes(error?.name)) return 'The selected trace could not be read. Reselect the file and retry; if it remains unavailable, export the trace again from DevTools.';
  return error?.message || 'Trace import failed.';
}

export async function parseChromeTraceFile(file, fileName = file?.name || 'trace.json', onProgress = () => {}, options = {}) {
  if (!file || typeof file.stream !== 'function') throw new Error('This browser cannot stream the selected file. Try a supported modern browser.');
  const { signal } = options;
  if (signal?.aborted) throw new DOMException('Trace import was cancelled.', 'AbortError');
  const reader = new JsonTokenReader(file.stream(), bytesRead => onProgress({ bytesRead, totalBytes: file.size }));
  const normalizer = createTraceNormalizer(fileName, { ...options, fileSize: file.size });
  let sourceFormat;
  let rootMetadata;
  try {
    if (signal?.aborted) throw new DOMException('Trace import was cancelled.', 'AbortError');
    const root = await reader.readRoot(event => {
      if (signal?.aborted) throw new DOMException('Trace import was cancelled.', 'AbortError');
      normalizer.accept(event);
    });
    sourceFormat = root.kind;
    rootMetadata = root.metadata;
  } catch (error) {
    await reader.release();
    if (error?.name === 'AbortError') throw error;
    throw new Error(describeReadError(error));
  }
  await reader.release();
  if (signal?.aborted) throw new DOMException('Trace import was cancelled.', 'AbortError');
  const run = normalizer.finish({ buildId: rootMetadata?.metadata?.buildId, environment: rootMetadata?.metadata?.environment });
  run.metadata.sourceFormat = sourceFormat;
  onProgress({ bytesRead: file.size, totalBytes: file.size, complete: true });
  return run;
}

/** Marker sidecar: {runId, clock: "monotonic-ms", markers:[{timestampMs,roundId,type,name?}]}.
 * timestampMs is relative to the normalized trace origin; traceTimestampUs may carry original trace time for normalization.
 */
export function parseMarkerText(text, traceOriginUs = 0) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`Invalid marker JSON: ${error.message}`); }
  if (!data || !Array.isArray(data.markers)) throw new Error('Marker file must contain a markers array.');
  const seen = new Set(), markers = [];
  let duplicateCount = 0, outOfOrderCount = 0, previousTimestamp = -Infinity;
  for (const [i, marker] of data.markers.entries()) {
    const type = marker?.type;
    const traceUs = marker?.traceTimestampUs;
    const roundId = marker?.roundId;
    const ts = Number.isFinite(traceUs) ? (traceUs - traceOriginUs) / 1000 : Number(marker?.timestampMs);
    if (!Number.isFinite(ts) || roundId === null || roundId === undefined || roundId === '' || !Number.isInteger(Number(roundId)) || !['roundStart','roundEnd','bonusStart','bonusEnd','winAnimationStart','winAnimationEnd'].includes(type)) throw new Error(`Marker ${i + 1} is invalid. Include timestampMs (or traceTimestampUs), integer roundId, and a supported type.`);
    if (ts < previousTimestamp) outOfOrderCount++;
    previousTimestamp = ts;
    const markerKey = `${ts}:${marker.roundId}:${type}`;
    if (seen.has(markerKey)) { duplicateCount++; continue; }
    seen.add(markerKey);
    markers.push({ timestampMs: ts, roundId: Number(roundId), type, ...(typeof marker.name === 'string' ? { name: marker.name } : {}) });
  }
  markers.sort((a, b) => a.timestampMs - b.timestampMs);
  markers.diagnostics = { duplicateCount, outOfOrderCount };
  return markers;
}

import { SOURCE, validateRun } from './model.js';

const num = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : undefined;
const eventId = (e, i) => `${e.pid ?? 'p'}-${e.tid ?? 't'}-${e.ts ?? 'x'}-${e.name ?? 'event'}-${i}`;

function unwrap(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.traceEvents)) return input.traceEvents;
  if (input?.trace?.traceEvents && Array.isArray(input.trace.traceEvents)) return input.trace.traceEvents;
  if (input?.data?.traceEvents && Array.isArray(input.data.traceEvents)) return input.data.traceEvents;
  throw new Error('Unsupported trace JSON. Expected a Chrome trace event array or an object containing "traceEvents". Export a Performance trace from Chrome DevTools and try again.');
}

export function parseChromeTraceText(text, fileName = 'trace.json') {
  let raw;
  try { raw = JSON.parse(text); } catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
  return normalizeChromeTrace(raw, fileName);
}

export async function parseChromeTraceFile(file, fileName = file?.name || 'trace.json', onProgress = () => {}) {
  if (!file || typeof file.stream !== 'function') throw new Error('This browser cannot stream the selected file. Try a supported modern browser.');
  let raw;
  const reader = file.stream().getReader();
  try {
    raw = await parseJsonStream(reader, file.size, onProgress);
  } catch (error) {
    try { await reader.cancel(error); } catch { /* The stream may already be closed. */ }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON: ${error.message}`);
    if (error?.name === 'AbortError') throw new Error('Trace import was interrupted. Select the file again to retry.');
    if (['NotReadableError', 'NotFoundError'].includes(error?.name)) throw new Error('The selected trace could not be read. Reselect the file and retry; if it remains unavailable, export the trace again from DevTools.');
    throw error;
  } finally {
    reader.releaseLock();
  }
  return normalizeChromeTrace(raw, fileName);
}

function normalizeChromeTrace(raw, fileName) {
  const events = unwrap(raw);
  if (!events.length) throw new Error('The trace contains no events. Export a non-empty Chrome DevTools Performance trace.');
  const valid = events.filter(e => e && typeof e === 'object' && num(e.ts) !== undefined);
  const malformedTimestampCount = events.length - valid.length;
  if (!valid.length) throw new Error('No events have valid microsecond timestamps (ts). This file is not a supported Chrome trace.');
  valid.sort((a, b) => Number(a.ts) - Number(b.ts));
  const originUs = Number(valid[0].ts);
  const processes = new Map(), threadNames = new Map(), normalized = [];
  const pending = new Map(), pendingByName = new Map(), seenEvents = new Map();
  let duplicateEventCount = 0, unmatchedEndCount = 0;
  valid.forEach((event, i) => {
    const argsJson = JSON.stringify(event.args ?? null);
    let argsHash = 2166136261;
    for (let charIndex = 0; charIndex < argsJson.length; charIndex++) {
      argsHash ^= argsJson.charCodeAt(charIndex);
      argsHash = Math.imul(argsHash, 16777619);
    }
    const core = JSON.stringify([event.pid ?? '', event.tid ?? '', event.ts, event.ph ?? '', event.name ?? '', event.cat ?? '', event.dur ?? '']);
    const signature = `${core}:${argsHash >>> 0}`;
    const duplicates = seenEvents.get(signature) || [];
    if (duplicates.some(previous => JSON.stringify(previous.args ?? null) === argsJson)) { duplicateEventCount++; return; }
    duplicates.push(event);
    seenEvents.set(signature, duplicates);
    const ts = Number(event.ts);
    if (!Number.isFinite(ts)) return;
    const threadKey = `${event.pid ?? ''}:${event.tid ?? ''}`;
    if (event.ph === 'M') {
      if (event.name === 'process_name') processes.set(event.pid, event.args?.name ?? event.args?.data?.name ?? '');
      if (event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? event.args?.data?.name ?? '');
      return;
    }
    if (event.ph === 'B') {
      const stack = pending.get(threadKey) || [];
      const entry = { event, active: true };
      stack.push(entry);
      pending.set(threadKey, stack);
      if (event.name) {
        const key = `${threadKey}:${event.name}`;
        const named = pendingByName.get(key) || [];
        named.push(entry);
        pendingByName.set(key, named);
      }
      return;
    }
    if (event.ph === 'E') {
      const stack = pending.get(threadKey) || [];
      let entry;
      if (event.name) {
        const named = pendingByName.get(`${threadKey}:${event.name}`) || [];
        while (named.length && !named.at(-1).active) named.pop();
        entry = named.pop();
      } else {
        while (stack.length && !stack.at(-1).active) stack.pop();
        entry = stack.pop();
      }
      const begin = entry?.active ? entry.event : undefined;
      if (entry) entry.active = false;
      if (begin) {
        const duration = ts - Number(begin.ts);
        if (duration >= 0) normalized.push({ ...begin, ph: 'X', dur: duration, _id: eventId(begin, i), _pair: true });
      } else unmatchedEndCount++;
      return;
    }
    if (event.ph === 'X') {
      const duration = num(event.dur);
      if (duration !== undefined && duration >= 0) normalized.push({ ...event, _id: eventId(event, i) });
      return;
    }
    if (event.ph === 'C') normalized.push({ ...event, _id: eventId(event, i) });
  });
  const incompleteBeginCount = [...pending.values()].reduce((count, stack) => count + stack.reduce((active, entry) => active + Number(entry.active), 0), 0);
  if (!normalized.length) throw new Error('No complete-duration, counter, or matched begin/end events were found. Try exporting a full Chrome Performance trace.');

  const mainCandidates = [...threadNames.entries()].filter(([, name]) => /CrRendererMain|RendererMain|Main Thread/i.test(name));
  const mainThread = mainCandidates[0]?.[0];
  const tasks = [];
  const samples = [];
  const frameNames = /^(DrawFrame|Frame|SubmitCompositorFrame|FireAnimationFrame|BeginFrame|PipelineReporter|Graphics.Pipeline|FramePresented)$/i;
  const taskNames = /^(RunTask|ThreadControllerImpl::RunTask|TaskQueueManager::ProcessTask|EvaluateScript|FunctionCall|v8\.compile|UpdateLayoutTree|Layout|Paint|CompositeLayers)$/i;
  const heapNames = /heap|memory|v8\.gc|jsHeap/i;
  let mainThreadDurationCount = 0;

  for (const event of normalized) {
    const startMs = (Number(event.ts) - originUs) / 1000;
    const durationMs = Number(event.dur) / 1000;
    const evidence = { traceFile: fileName, startUs: Number(event.ts), durationUs: Number(event.dur) || 0, processId: event.pid, threadId: event.tid, eventName: event.name, category: event.cat };
    const matchesMainThread = mainThread === `${event.pid}:${event.tid}`;
    if (event.ph === 'X' && matchesMainThread) mainThreadDurationCount++;
    const inMain = mainThread ? matchesMainThread : /RunTask|EvaluateScript|FunctionCall/i.test(event.name || '') && !!threadNames.get(`${event.pid}:${event.tid}`)?.match(/main/i);
    if (event.ph === 'X' && inMain && (taskNames.test(event.name || '') || durationMs >= 50)) tasks.push({ timestampMs: startMs, durationMs, eventName: event.name, roundId: undefined, evidence });

    if (event.ph === 'C' || heapNames.test(event.name || '')) {
      const args = { ...(event.args || {}), ...(event.args?.data || {}) };
      const heap = num(args.usedHeapSize ?? args.jsHeapUsedSize ?? args.jsHeapUsedBytes ?? args.used_bytes ?? args['jsHeapUsedSize']);
      if (heap !== undefined && heap >= 0) samples.push({ timestampMs: startMs, jsHeapUsedBytes: heap, source: SOURCE.TRACE, evidence });
    }
  }
  // Use intervals between recognized frame markers, not arbitrary event duration as FPS.
  const frameGroups = new Map();
  for (const event of normalized) {
    if (event.ph !== 'X' || !frameNames.test(event.name || '')) continue;
    const groupKey = `${event.pid ?? ''}:${event.tid ?? ''}:${event.name}`;
    const group = frameGroups.get(groupKey) || [];
    group.push(event);
    frameGroups.set(groupKey, group);
  }
  for (const frameEvents of frameGroups.values()) {
    frameEvents.sort((a, b) => Number(a.ts) - Number(b.ts));
    for (let i = 1; i < frameEvents.length; i++) {
      const previous = frameEvents[i - 1], current = frameEvents[i];
      const intervalMs = (Number(current.ts) - Number(previous.ts)) / 1000;
      if (intervalMs > 0 && intervalMs <= 1000) {
        samples.push({ timestampMs: (Number(current.ts) - originUs) / 1000, frameDurationMs: intervalMs, fps: 1000 / intervalMs, source: SOURCE.TRACE, evidence: { traceFile: fileName, startUs: Number(previous.ts), durationUs: Number(current.ts) - Number(previous.ts), processId: current.pid, threadId: current.tid, eventName: current.name, category: current.cat } });
      }
    }
  }
  // Keep output bounded and avoid treating task durations as CPU utilization.
  const threadInfoSet = new Set(), processIds = new Set();
  for (const event of normalized) {
    if (event.pid !== undefined) processIds.add(event.pid);
    if (threadInfoSet.size < 80) threadInfoSet.add(`${event.pid ?? '?'}:${event.tid ?? '?'} ${processes.get(event.pid) || 'process'} / ${threadNames.get(`${event.pid}:${event.tid}`) || 'unnamed thread'}`);
  }
  const threadInfo = [...threadInfoSet];
  samples.sort((a, b) => a.timestampMs - b.timestampMs);
  tasks.sort((a, b) => a.timestampMs - b.timestampMs);
  const timeOrigin = valid[0].ts;
  const run = {
    id: `trace-${Date.now()}`, game: 'Zeus vs Hades', buildId: raw?.metadata?.buildId || 'unknown-build', environment: raw?.metadata?.environment || 'Browser environment not provided', startedAt: new Date().toISOString(), source: SOURCE.TRACE,
    samples, events: [], findings: [], tasks,
    metadata: {
      fileName, eventCount: events.length, normalizedEventCount: normalized.length,
      processCount: processIds.size,
      threadInfo, traceOriginUs: timeOrigin, mainThreadDetected: Boolean(mainThread),
      diagnostics: { malformedTimestampCount, duplicateEventCount, unmatchedEndCount, incompleteBeginCount },
      limitations: ['Chrome traces generally do not provide whole-system or browser CPU utilization.', 'Game rounds require separately imported, clock-aligned markers.', 'Frame and heap events are extracted only for recognized event shapes.']
    }
  };
  if (malformedTimestampCount) run.metadata.limitations.push(`${malformedTimestampCount} event(s) with invalid timestamps were skipped.`);
  if (duplicateEventCount) run.metadata.limitations.push(`${duplicateEventCount} duplicate event(s) were discarded.`);
  if (unmatchedEndCount) run.metadata.limitations.push(`${unmatchedEndCount} unmatched duration end marker(s) were ignored.`);
  if (incompleteBeginCount) run.metadata.limitations.push(`${incompleteBeginCount} duration begin marker(s) had no matching end marker.`);
  if (!mainThreadDurationCount) run.metadata.limitations.push('Renderer main-thread metadata was not identified; long-task coverage may be incomplete.');
  return validateRun(run);
}

async function parseJsonStream(reader, totalBytes, onProgress) {
  const decoder = new TextDecoder();
  let buffer = '', offset = 0, finished = false, bytesRead = 0;
  async function fill() {
    while (offset >= buffer.length && !finished) {
      if (offset) { buffer = buffer.slice(offset); offset = 0; }
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        finished = true;
      } else {
        bytesRead += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        onProgress({ bytesRead, totalBytes });
      }
    }
  }
  async function peek() { await fill(); return buffer[offset]; }
  async function take() { const char = await peek(); if (char !== undefined) offset++; return char; }
  async function token() {
    while (true) {
      if (await peek() === undefined) return { type: 'eof' };
      if (offset < buffer.length) offset += /^[ \t\n\r]*/.exec(buffer.slice(offset))[0].length;
      if (offset < buffer.length) break;
    }
    const first = buffer[offset++];
    if ('{}[]:,'.includes(first)) return { type: first };
    if (first === '"') {
      const parts = [];
      let segmentStart = offset, escaped = false;
      while (true) {
        if (offset >= buffer.length) {
          parts.push(buffer.slice(segmentStart));
          await fill();
          segmentStart = offset;
          if (offset >= buffer.length && finished) throw new SyntaxError('Unexpected end of JSON string.');
          continue;
        }
        const char = buffer[offset++];
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          parts.push(buffer.slice(segmentStart, offset));
          break;
        }
      }
      return { type: 'string', value: JSON.parse(`"${parts.join('')}`) };
    }
    const parts = [];
    let segmentStart = offset - 1;
    while (true) {
      if (offset >= buffer.length) {
        parts.push(buffer.slice(segmentStart));
        await fill();
        segmentStart = offset;
        if (offset >= buffer.length && finished) break;
        continue;
      }
      if (/[ \t\n\r\[\]{}:,]/.test(buffer[offset])) {
        parts.push(buffer.slice(segmentStart, offset));
        break;
      }
      offset++;
    }
    const value = JSON.parse(parts.join(''));
    return { type: 'value', value };
  }

  let lookahead;
  const next = async () => { const current = lookahead ?? await token(); lookahead = undefined; return current; };
  const expect = async type => {
    const current = await next();
    if (current.type !== type) throw new SyntaxError(`Expected ${type} in JSON.`);
    return current;
  };
  async function value() {
    const current = await next();
    if (current.type === '{') {
      const result = {};
      let entry = await token();
      if (entry.type === '}') return result;
      while (true) {
        if (entry.type !== 'string') throw new SyntaxError('Expected an object property name.');
        const key = entry.value;
        await expect(':');
        const propertyValue = await value();
        if (key === '__proto__') Object.defineProperty(result, key, { value: propertyValue, enumerable: true, configurable: true, writable: true });
        else result[key] = propertyValue;
        entry = await token();
        if (entry.type === '}') return result;
        if (entry.type !== ',') throw new SyntaxError('Expected a comma or closing brace.');
        entry = await token();
      }
    }
    if (current.type === '[') {
      const result = [];
      let entry = await next();
      if (entry.type === ']') return result;
      while (true) {
        // Keep the lookahead token: value() must consume the complete next item,
        // including the opening token for nested arrays and objects.
        lookahead = entry;
        result.push(await value());
        entry = await next();
        if (entry.type === ']') return result;
        if (entry.type !== ',') throw new SyntaxError('Expected a comma or closing bracket.');
        entry = await next();
      }
    }
    if (current.type === 'string' || current.type === 'value') return current.value;
    throw new SyntaxError('Expected a JSON value.');
  }

  const result = await value();
  if ((await next()).type !== 'eof') throw new SyntaxError('Unexpected content after the JSON value.');
  onProgress({ bytesRead: totalBytes || bytesRead, totalBytes, complete: true });
  return result;
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

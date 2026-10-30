import { parseChromeTraceFile, parseMarkerText } from './parser.js';
import { analyzeRun } from './analyze.js';

const post = (stage, message, extra = {}) => self.postMessage({ type: 'progress', stage, message, ...extra });

function attachAnalysis(run, onStage) {
  run.metadata = { ...run.metadata, markedRoundCount: new Set(run.events.map(marker => marker.roundId)).size };
  return analyzeRun(run, {}, onStage ? { onStage } : {});
}

function correlateMarkers(run, fileName, markers) {
  const sorted = [...markers].sort((a, b) => a.timestampMs - b.timestampMs);
  const endTimesByRound = new Map();
  for (const marker of sorted) {
    if (marker.type !== 'roundEnd') continue;
    const ends = endTimesByRound.get(marker.roundId) || [];
    ends.push(marker.timestampMs);
    endTimesByRound.set(marker.roundId, ends);
  }
  const lowerBound = (values, target) => {
    let low = 0, high = values.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const intervals = [];
  for (const start of sorted) {
    if (start.type !== 'roundStart') continue;
    const ends = endTimesByRound.get(start.roundId) || [];
    const endMs = ends[lowerBound(ends, start.timestampMs)];
    if (endMs !== undefined) intervals.push({ startMs: start.timestampMs, endMs, roundId: start.roundId });
  }
  intervals.sort((a, b) => a.startMs - b.startMs);
  const byEnd = [...intervals].sort((a, b) => a.endMs - b.endMs);
  const assign = rows => {
    rows.sort((a, b) => a.timestampMs - b.timestampMs);
    let nextStart = 0, nextEnd = 0, activeCount = 0;
    const activeRounds = new Map();
    for (const row of rows) {
      while (nextStart < intervals.length && intervals[nextStart].startMs <= row.timestampMs) {
        const interval = intervals[nextStart++];
        activeCount++;
        activeRounds.set(interval.roundId, (activeRounds.get(interval.roundId) || 0) + 1);
      }
      while (nextEnd < byEnd.length && byEnd[nextEnd].endMs < row.timestampMs) {
        const interval = byEnd[nextEnd++];
        if (interval.startMs <= row.timestampMs) {
          activeCount--;
          const count = activeRounds.get(interval.roundId) - 1;
          if (count) activeRounds.set(interval.roundId, count);
          else activeRounds.delete(interval.roundId);
        }
      }
      const roundId = activeCount === 1 ? activeRounds.keys().next().value : undefined;
      if (roundId === undefined) delete row.roundId;
      else row.roundId = roundId;
    }
  };
  const events = sorted.map(marker => ({ ...marker }));
  assign(run.samples);
  assign(run.tasks || []);
  run.events = events;
  run.metadata = {
    ...run.metadata,
    markerFile: fileName,
    markerDiagnostics: markers.diagnostics,
    limitations: (run.metadata?.limitations || []).filter(note => !note.includes('Game rounds require'))
  };
  return attachAnalysis(run);
}

self.onmessage = async event => {
  const { file, fileName, type = 'parse', run } = event.data || {};
  try {
    if (type === 'markers') {
      post('parsing', 'Reading game markers…');
      const markers = parseMarkerText(await file.text(), run.metadata?.traceOriginUs || 0);
      post('analyzing', 'Correlating markers with rounds…');
      const updated = correlateMarkers(run, file.name || fileName, markers);
      post('preparing', 'Preparing dashboard data…');
      self.postMessage({ type: 'result', run: updated });
      return;
    }
    post('validating', 'Validating trace file…');
    post('reading', 'Reading and validating trace JSON…');
    let lastPercent = -1;
    const parsed = await parseChromeTraceFile(file, fileName, ({ bytesRead, totalBytes, complete, eventCount, stage }) => {
      if (stage === 'parsing') { post('parsing', `${eventCount.toLocaleString()} events parsed…`, { eventCount }); return; }
      if (complete) { post('parsing', 'Trace read; parsing events…', { percent: 100 }); return; }
      const percent = totalBytes ? Math.min(100, Math.floor(bytesRead / totalBytes * 100)) : 0;
      if (percent > lastPercent) { lastPercent = percent; post('reading', `Reading trace file… ${percent}%`, { percent, bytesRead, totalBytes }); }
    });
    // Analysis runs inside this worker, so the UI thread never blocks. Stage
    // callbacks and the abort check keep progress honest and cancellation real.
    const analyzed = attachAnalysis(parsed, (stage, message) => post(stage, message));
    self.postMessage({ type: 'result', run: analyzed });
  } catch (error) {
    if (error?.name === 'AbortError') { self.postMessage({ type: 'error', cancelled: true, message: 'Trace processing was cancelled.' }); return; }
    const message = error?.name === 'QuotaExceededError' || error?.name === 'RangeError'
      ? 'The browser ran out of memory while processing this trace. The original file was not modified. Reduce the recording time range in DevTools and export again.'
      : error?.message || 'Trace parsing failed.';
    self.postMessage({ type: 'error', message });
  }
};

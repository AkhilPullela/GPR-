import { parseChromeTraceFile, parseMarkerText } from './parser.js';
import { generateFindings, summarizeRounds, summarizeRun } from './analyze.js';

function attachAnalysis(run) {
  run.metadata = { ...run.metadata, markedRoundCount: new Set(run.events.map(marker => marker.roundId)).size };
  const findings = generateFindings(run);
  const analyzedRun = { ...run, findings };
  run.analysis = {
    summary: summarizeRun(analyzedRun),
    findings,
    rankedFindings: findings.slice().sort((a, b) => ({ critical: 0, warning: 1, info: 2 }[a.severity] - { critical: 0, warning: 1, info: 2 }[b.severity])).slice(0, 100),
    rounds: summarizeRounds(analyzedRun)
  };
  const chartMetrics = ['cpuPercent', 'fps', 'jsHeapUsedBytes', 'reactCommitMs'];
  run.longTasks = run.tasks.filter(task => task.durationMs >= 50);
  run.chartSamples = Object.fromEntries(chartMetrics.map(metric => {
    const values = run.samples.filter(sample => Number.isFinite(sample[metric]));
    const stride = Math.max(1, Math.ceil(values.length / 1200));
    return [metric, stride > 1 ? values.filter((_, index) => index % stride === 0 || index === values.length - 1) : values];
  }));
  run.chartTimeRange = run.samples.length ? [run.samples[0].timestampMs, run.samples.at(-1).timestampMs] : [0, 0];
  return run;
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
      const markers = parseMarkerText(await file.text(), run.metadata?.traceOriginUs || 0);
      self.postMessage({ type: 'result', run: correlateMarkers(run, file.name || fileName, markers) });
      return;
    }
    self.postMessage({ type: 'progress', message: 'Starting streamed trace import…' });
    let lastPercent = -1;
    const parsed = await parseChromeTraceFile(file, fileName, ({ bytesRead, totalBytes, complete }) => {
      const percent = totalBytes ? Math.min(100, Math.floor(bytesRead / totalBytes * 100)) : 0;
      if (complete || percent > lastPercent) {
        lastPercent = percent;
        self.postMessage({ type: 'progress', message: complete ? 'Trace read; normalizing events…' : `Reading trace file… ${percent}%` });
      }
    });
    self.postMessage({ type: 'progress', message: 'Trace parsed; calculating summaries and findings…' });
    const analyzed = attachAnalysis(parsed);
    self.postMessage({ type: 'result', run: analyzed });
  } catch (error) {
    const message = error?.name === 'QuotaExceededError' || error?.name === 'RangeError'
      ? 'The browser ran out of memory while processing this trace. Reduce the recording time range in DevTools and export again.'
      : error?.message || 'Trace parsing failed.';
    self.postMessage({ type: 'error', message });
  }
};

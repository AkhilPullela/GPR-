import { metricCoverage } from './model.js';

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
const max = xs => xs.length ? xs.reduce((a, b) => Math.max(a, b), -Infinity) : undefined;
const min = xs => xs.length ? xs.reduce((a, b) => Math.min(a, b), Infinity) : undefined;
const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
const byTime = (a, b) => a.timestampMs - b.timestampMs;
function lowerBound(rows, timestampMs) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}
function upperBound(rows, timestampMs) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].timestampMs <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}
function inRange(rows, start, end) {
  return rows.slice(lowerBound(rows, start), upperBound(rows, end));
}
function nearestHeapSample(samples, timestampMs, before) {
  const index = lowerBound(samples, timestampMs);
  if (before) {
    for (let i = Math.min(index, samples.length - 1); i >= 0; i--) {
      if (samples[i].timestampMs <= timestampMs && Number.isFinite(samples[i].jsHeapUsedBytes)) return samples[i];
    }
  } else {
    for (let i = index; i < samples.length; i++) {
      if (samples[i].timestampMs >= timestampMs && Number.isFinite(samples[i].jsHeapUsedBytes)) return samples[i];
    }
  }
  return undefined;
}

export function summarizeRun(run, targetFps = 60) {
  const samples = [...run.samples].sort(byTime);
  const cpu = samples.map(s => s.cpuPercent).filter(Number.isFinite);
  const fps = samples.map(s => s.fps).filter(Number.isFinite);
  const frames = samples.map(s => s.frameDurationMs).filter(Number.isFinite);
  const heap = samples.map(s => s.jsHeapUsedBytes).filter(Number.isFinite);
  const react = samples.map(s => s.reactCommitMs).filter(Number.isFinite);
  const tasks = run.tasks || [];
  const taskMax = tasks.reduce((value, task) => Number.isFinite(task.durationMs) ? Math.max(value, task.durationMs) : value, -Infinity);
  return {
    sampleCount: samples.length,
    cpuAvg: round(mean(cpu)), cpuPeak: round(max(cpu)),
    fpsAvg: round(mean(fps)), frameCount: frames.length, frameP50: round(percentile(frames, .5)), frameP95: round(percentile(frames, .95)), frameP99: round(percentile(frames, .99)),
    slowFrames: frames.filter(v => v > 1000 / targetFps).length,
    heapMin: min(heap), heapMax: max(heap),
    heapDelta: heap.length > 1 ? heap[heap.length - 1] - heap[0] : undefined,
    longTasks: tasks.filter(t => t.durationMs >= 50).length,
    maxTaskMs: Number.isFinite(taskMax) ? taskMax : undefined,
    reactCommitP95: percentile(react, .95), coverage: metricCoverage(run)
  };
}

export function summarizeRounds(run, targetFps = 60) {
  const starts = run.events.filter(e => e.type === 'roundStart').sort(byTime);
  const endsByRound = new Map();
  for (const event of run.events) {
    if (event.type !== 'roundEnd') continue;
    const rows = endsByRound.get(event.roundId) || [];
    rows.push(event);
    endsByRound.set(event.roundId, rows);
  }
  for (const rows of endsByRound.values()) rows.sort(byTime);
  const samples = [...run.samples].sort(byTime), tasks = [...(run.tasks || [])].sort(byTime);
  const heapSamples = samples.filter(sample => Number.isFinite(sample.jsHeapUsedBytes));
  const eventsByRound = new Map(), findingsByRound = new Map();
  for (const event of run.events) {
    const rows = eventsByRound.get(event.roundId) || [];
    rows.push(event);
    eventsByRound.set(event.roundId, rows);
  }
  for (const rows of eventsByRound.values()) rows.sort(byTime);
  for (const finding of run.findings || []) {
    const rows = findingsByRound.get(finding.roundId) || [];
    rows.push(finding);
    findingsByRound.set(finding.roundId, rows);
  }
  return starts.map(start => {
    const matchingEnds = endsByRound.get(start.roundId) || [];
    const endIndex = lowerBound(matchingEnds, start.timestampMs);
    const end = matchingEnds[endIndex];
    if (!end) return { roundId: start.roundId, startMs: start.timestampMs, incomplete: true, findings: findingsByRound.get(start.roundId)?.length || 0 };
    const roundSamples = inRange(samples, start.timestampMs, end.timestampMs);
    const cpu = roundSamples.map(s => s.cpuPercent).filter(Number.isFinite), fps = roundSamples.map(s => s.fps).filter(Number.isFinite), frame = roundSamples.map(s => s.frameDurationMs).filter(Number.isFinite);
    const heapBefore = nearestHeapSample(heapSamples, start.timestampMs, true)?.jsHeapUsedBytes;
    const heapAfter = nearestHeapSample(heapSamples, end.timestampMs, false)?.jsHeapUsedBytes;
    const roundTasks = inRange(tasks, start.timestampMs, end.timestampMs);
    const matchingEvents = eventsByRound.get(start.roundId) || [];
    const events = inRange(matchingEvents, start.timestampMs, end.timestampMs);
    return { roundId: start.roundId, startMs: start.timestampMs, endMs: end.timestampMs, durationMs: end.timestampMs - start.timestampMs, cpuAvg: round(mean(cpu)), cpuPeak: round(max(cpu)), fpsAvg: round(mean(fps)), frameCount: frame.length, frameP50: round(percentile(frame, .5)), frameP95: round(percentile(frame, .95)), frameP99: round(percentile(frame, .99)), slowFrames: frame.filter(v => v > 1000 / targetFps).length, heapBefore, heapAfter, heapDelta: Number.isFinite(heapBefore) && Number.isFinite(heapAfter) ? heapAfter - heapBefore : undefined, longTaskCount: roundTasks.filter(t => t.durationMs >= 50).length, longTaskDurationMs: roundTasks.reduce((sum, t) => sum + (t.durationMs >= 50 ? t.durationMs : 0), 0), events, findingCount: findingsByRound.get(start.roundId)?.length || 0, incomplete: false };
  });
}

export function generateFindings(run, config = {}) {
  const threshold = config.longTaskThresholdMs ?? 50;
  const findings = [...(run.findings || [])];
  for (const task of (run.tasks || [])) {
    if (task.durationMs < threshold) continue;
    findings.push({ id: `task-${task.timestampMs}-${task.durationMs}`, category: 'cpu', severity: task.durationMs >= 100 ? 'critical' : 'warning', title: 'Long main-thread task', description: `Observed main-thread task lasted ${task.durationMs.toFixed(1)} ms (threshold ${threshold} ms). Task duration is not CPU utilization.`, roundId: task.roundId, startMs: task.timestampMs, endMs: task.timestampMs + task.durationMs, value: task.durationMs, unit: 'ms', evidence: task.evidence ? [task.evidence] : [] });
  }
  const targetFps = Number.isFinite(config.targetFps) && config.targetFps > 0 ? config.targetFps : 60;
  const frameBudgetMs = 1000 / targetFps;
  let frameFindingCount = 0, cpuFindingCount = 0, reactFindingCount = 0;
  for (const sample of run.samples) {
    if (Number.isFinite(sample.frameDurationMs) && sample.frameDurationMs > frameBudgetMs && frameFindingCount < 100) {
      findings.push({ id: `slow-frame-${sample.timestampMs}-${sample.frameDurationMs}`, category: 'frames', severity: sample.frameDurationMs > frameBudgetMs * 2 ? 'critical' : 'warning', title: 'Frame exceeded budget', description: `Observed frame interval ${sample.frameDurationMs.toFixed(1)} ms exceeded the ${(frameBudgetMs).toFixed(2)} ms budget (${targetFps} FPS target).`, roundId: sample.roundId, startMs: sample.timestampMs, endMs: sample.timestampMs, value: sample.frameDurationMs, unit: 'ms', evidence: sample.evidence ? [sample.evidence] : [] });
      frameFindingCount++;
    }
    const cpuLimit = config.cpuSpikePercent ?? 85;
    if (Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= cpuLimit && cpuFindingCount < 100) {
      findings.push({ id: `cpu-spike-${sample.timestampMs}-${sample.cpuPercent}`, category: 'cpu', severity: sample.cpuPercent >= 95 ? 'critical' : 'warning', title: 'CPU utilization spike', description: `Explicitly measured utilization reached ${sample.cpuPercent.toFixed(1)}% (configured threshold ${cpuLimit}%).`, roundId: sample.roundId, startMs: sample.timestampMs, endMs: sample.timestampMs, value: sample.cpuPercent, unit: '%', evidence: sample.evidence ? [sample.evidence] : [] });
      cpuFindingCount++;
    }
    const reactDuration = sample.reactCommitMs ?? sample.dispatchDurationMs;
    if (Number.isFinite(reactDuration) && reactDuration >= (config.reactCommitThresholdMs ?? 16.67) && reactFindingCount < 100) {
      findings.push({ id: `react-duration-${sample.timestampMs}-${reactDuration}`, category: 'react-redux', severity: reactDuration >= 50 ? 'critical' : 'warning', title: sample.reactCommitMs !== undefined ? 'Slow React commit' : 'Slow instrumented dispatch', description: `Instrumented duration was ${reactDuration.toFixed(1)} ms. This identifies measured work, not proof it caused a slow frame.`, roundId: sample.roundId, startMs: sample.timestampMs, endMs: sample.timestampMs, value: reactDuration, unit: 'ms', evidence: sample.evidence ? [sample.evidence] : [] });
      reactFindingCount++;
    }
  }
  const heaps = run.samples.filter(s => Number.isFinite(s.jsHeapUsedBytes)).sort(byTime);
  const heapThreshold = config.memoryGrowthThresholdBytes ?? 32 * 1024 * 1024;
  if (heaps.length > 2 && heaps.at(-1).jsHeapUsedBytes - heaps[0].jsHeapUsedBytes > heapThreshold && !findings.some(f => f.category === 'memory')) {
    const delta = heaps.at(-1).jsHeapUsedBytes - heaps[0].jsHeapUsedBytes;
    findings.push({ id: 'heap-growth-observed', category: 'memory', severity: 'warning', title: 'Potential heap retention', description: 'Heap usage increased across the observed samples. GC timing, sampling interval, and workload can affect this result; growth alone does not establish a leak.', startMs: heaps[0].timestampMs, endMs: heaps.at(-1).timestampMs, value: delta / 1048576, unit: 'MiB', evidence: [] });
  }
  if (!run.samples.some(s => Number.isFinite(s.reactCommitMs) || Number.isFinite(s.dispatchDurationMs)) && !findings.some(f => f.id === 'react-instrumentation-missing')) findings.push({ id: 'react-instrumentation-missing', category: 'react-redux', severity: 'info', title: 'React / Redux instrumentation unavailable', description: 'Component commit, dispatch, middleware, and selector costs cannot be assessed without optional application instrumentation.', evidence: [] });
  if (!run.events?.some(e => e.type === 'roundStart') && !findings.some(f => f.id === 'round-markers-missing')) findings.push({ id: 'round-markers-missing', category: 'cpu', severity: 'info', title: 'Game round markers unavailable', description: 'Trace-only analysis is available, but round-level correlation requires aligned game markers.', evidence: [] });
  return findings;
}

export function compareBaseline(current, baseline) {
  if (!baseline) return { compatible: false, reason: 'No baseline selected.' };
  const mismatches = [];
  for (const key of ['buildId', 'environment', 'source']) if (current[key] !== baseline[key]) mismatches.push(key);
  return { compatible: mismatches.length === 0, reason: mismatches.length ? `Comparison warning: different ${mismatches.join(', ')}. Treat changes as non-comparable.` : 'Metadata matches; this is a descriptive comparison, not a statistical significance test.', mismatches };
}

export function buildReportSnapshot(run) {
  const findings = generateFindings(run);
  const enriched = { ...run, findings };
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), run: enriched, summary: summarizeRun(enriched), rounds: summarizeRounds(enriched), findings, coverage: metricCoverage(enriched) };
}

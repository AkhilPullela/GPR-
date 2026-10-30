import { THRESHOLDS, SEVERITY_RANK, metricCoverage, metricAvailability } from './model.js';

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

function metricStats(samples, key) {
  const values = [];
  for (const sample of samples) if (Number.isFinite(sample[key])) values.push(sample[key]);
  return { count: values.length, mean: mean(values), min: min(values), max: max(values) };
}

export function summarizeRun(run, config = {}) {
  const thresholds = { ...THRESHOLDS, ...config };
  const samples = run.samples;
  const fps = metricStats(samples, 'fps');
  const frames = metricStats(samples, 'frameDurationMs');
  const heap = metricStats(samples, 'jsHeapUsedBytes');
  const react = metricStats(samples, 'reactCommitMs');
  const busy = metricStats(samples, 'mainThreadBusyPercent');
  const cpu = metricStats(samples, 'cpuPercent');
  const tasks = run.tasks || [];
  const taskMax = tasks.reduce((value, task) => Number.isFinite(task.durationMs) ? Math.max(value, task.durationMs) : value, -Infinity);
  const longTasks = tasks.filter(t => t.durationMs >= thresholds.longTaskMs);
  const first = samples.length ? samples[0].timestampMs : undefined;
  const last = samples.length ? samples[samples.length - 1].timestampMs : undefined;
  const availability = run.metadata?.availability || metricAvailability(run);
  return {
    sampleCount: samples.length,
    coverageDurationMs: Number.isFinite(first) && Number.isFinite(last) ? last - first : undefined,
    // cpuAvg/cpuPeak stay undefined unless the trace carried explicit
    // utilization samples. Main-thread busy time is reported separately so the
    // two are never conflated.
    cpuAvg: cpu.mean !== undefined ? round(cpu.mean) : undefined,
    cpuPeak: round(cpu.max),
    cpuSampleCount: cpu.count,
    busyAvg: round(busy.mean), busyPeak: round(busy.max), busySampleCount: busy.count,
    busyTotalMs: round(run.metadata?.mainThreadBusyMs),
    fpsAvg: round(fps.mean), fpsMin: round(fps.min), fpsSampleCount: fps.count,
    frameCount: frames.count, frameP50: round(percentile(samples.map(s => s.frameDurationMs), .5)), frameP95: round(percentile(samples.map(s => s.frameDurationMs), .95)), frameP99: round(percentile(samples.map(s => s.frameDurationMs), .99)),
    slowFrames: samples.filter(s => Number.isFinite(s.frameDurationMs) && s.frameDurationMs > thresholds.frameBudgetMs).length,
    heapMin: heap.min, heapMax: heap.max, heapSampleCount: heap.count,
    heapDelta: heap.count > 1 ? lastHeap(samples) - firstHeap(samples) : undefined,
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((sum, t) => sum + t.durationMs, 0)),
    longTasks: longTasks.length,
    maxTaskMs: Number.isFinite(taskMax) ? taskMax : undefined,
    taskCount: tasks.length,
    // Task duration distribution comes from the parser's single-pass histogram
    // so the dashboard never re-scans the task list during render.
    taskDistribution: run.metadata?.taskDistribution || [],
    taskBucketBoundsMs: run.metadata?.taskBucketBoundsMs || [],
    reactCommitP95: percentile(samples.map(s => s.reactCommitMs), .95),
    reactSampleCount: react.count,
    availability,
    coverage: metricCoverage({ ...run, metadata: { ...run.metadata, availability } })
  };
}
function firstHeap(samples) { for (const s of samples) if (Number.isFinite(s.jsHeapUsedBytes)) return s.jsHeapUsedBytes; return undefined; }
function lastHeap(samples) { for (let i = samples.length - 1; i >= 0; i--) if (Number.isFinite(samples[i].jsHeapUsedBytes)) return samples[i].jsHeapUsedBytes; return undefined; }

export function summarizeRounds(run, config = {}) {
  const thresholds = { ...THRESHOLDS, ...config };
  const starts = run.events.filter(e => e.type === 'roundStart').sort(byTime);
  const endsByRound = new Map();
  for (const event of run.events) {
    if (event.type !== 'roundEnd') continue;
    const rows = endsByRound.get(event.roundId) || [];
    rows.push(event);
    endsByRound.set(event.roundId, rows);
  }
  for (const rows of endsByRound.values()) rows.sort(byTime);
  const samples = run.samples, tasks = [...(run.tasks || [])].sort(byTime);
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
    const roundFindings = findingsByRound.get(start.roundId) || [];
    if (!end) return { roundId: start.roundId, startMs: start.timestampMs, incomplete: true, findings: roundFindings.length, findingCount: roundFindings.length, events: eventsByRound.get(start.roundId) || [] };
    const roundSamples = inRange(samples, start.timestampMs, end.timestampMs);
    const cpu = roundSamples.map(s => s.cpuPercent).filter(Number.isFinite), fps = roundSamples.map(s => s.fps).filter(Number.isFinite), frame = roundSamples.map(s => s.frameDurationMs).filter(Number.isFinite);
    const busy = roundSamples.map(s => s.mainThreadBusyPercent).filter(Number.isFinite);
    const heapBefore = nearestHeapSample(heapSamples, start.timestampMs, true)?.jsHeapUsedBytes;
    const heapAfter = nearestHeapSample(heapSamples, end.timestampMs, false)?.jsHeapUsedBytes;
    const roundTasks = inRange(tasks, start.timestampMs, end.timestampMs);
    const matchingEvents = eventsByRound.get(start.roundId) || [];
    const events = inRange(matchingEvents, start.timestampMs, end.timestampMs);
    return {
      roundId: start.roundId, startMs: start.timestampMs, endMs: end.timestampMs, durationMs: end.timestampMs - start.timestampMs,
      cpuAvg: round(mean(cpu)), cpuPeak: round(max(cpu)), busyAvg: round(mean(busy)), busyPeak: round(max(busy)), fpsAvg: round(mean(fps)), frameCount: frame.length,
      frameP50: round(percentile(frame, .5)), frameP95: round(percentile(frame, .95)), frameP99: round(percentile(frame, .99)),
      slowFrames: frame.filter(v => v > thresholds.frameBudgetMs).length,
      heapBefore, heapAfter, heapDelta: Number.isFinite(heapBefore) && Number.isFinite(heapAfter) ? heapAfter - heapBefore : undefined,
      longTaskCount: roundTasks.filter(t => t.durationMs >= thresholds.longTaskMs).length,
      longTaskDurationMs: round(roundTasks.reduce((sum, t) => sum + (t.durationMs >= thresholds.longTaskMs ? t.durationMs : 0), 0)),
      events, findingCount: roundFindings.length, findings: roundFindings.length, incomplete: false
    };
  });
}

const evidenceSummary = evidence => (evidence || []).slice(0, 1).map(e => e.eventName ? `${e.eventName} at ${Math.round(e.startUs / 1000)} ms (thread ${e.threadId ?? '?'})` : e.traceFile).join('');

/**
 * Build prioritized findings from measured evidence.
 *
 * Every finding distinguishes the observed fact from the interpretation, names
 * a threshold or rule, lists investigation steps, and carries an evidence
 * quality statement. Nothing is generated when the underlying measurement is
 * absent, so unavailable metrics never appear as zero.
 */
export function generateFindings(run, config = {}) {
  const thresholds = { ...THRESHOLDS, ...config };
  const findings = [...(run.findings || [])];
  const targetFps = thresholds.targetFps;

  // Long tasks are grouped by event name so one recurring pattern becomes one
  // finding with a recurrence count and a worst-case value, instead of one
  // finding per occurrence. Every group keeps its strongest evidence links.
  const taskGroups = new Map();
  for (const task of (run.tasks || [])) {
    if (task.durationMs < thresholds.longTaskMs) continue;
    const key = task.eventName || 'main-thread task';
    const group = taskGroups.get(key) || { name: key, tasks: [] };
    group.tasks.push(task);
    taskGroups.set(key, group);
  }
  for (const group of taskGroups.values()) {
    const worst = group.tasks.reduce((best, task) => task.durationMs > best.durationMs ? task : best, group.tasks[0]);
    const critical = worst.durationMs >= thresholds.longTaskCriticalMs;
    const totalMs = group.tasks.reduce((sum, task) => sum + task.durationMs, 0);
    findings.push({
      id: `task-${group.name}-${group.tasks.length}`, category: 'cpu', severity: critical ? 'critical' : 'warning',
      title: group.tasks.length > 1 ? 'Recurring main-thread stalls' : 'Potential main-thread stall',
      observed: group.tasks.length > 1
        ? `“${group.name}” ran ${group.tasks.length} times with a duration of ${thresholds.longTaskMs} ms or more; the longest was ${worst.durationMs.toFixed(1)} ms.`
        : `A main-thread task (“${group.name}”) ran for ${worst.durationMs.toFixed(1)} ms.`,
      interpretation: 'Tasks this long block rendering and input handling, which can make animations and taps feel stuck.',
      impact: 'During each stall the game cannot paint a new frame, so input may feel delayed.',
      description: `“${group.name}” produced ${group.tasks.length} task(s) at or above the ${thresholds.longTaskMs} ms long-task threshold (${totalMs.toFixed(0)} ms total; worst ${worst.durationMs.toFixed(1)} ms).`,
      roundId: worst.roundId, startMs: group.tasks[0].timestampMs, endMs: group.tasks[group.tasks.length - 1].timestampMs + worst.durationMs,
      value: Number(worst.durationMs.toFixed(1)), unit: 'ms', threshold: thresholds.longTaskMs, rule: `durationMs >= ${thresholds.longTaskMs}`,
      recurrence: group.tasks.length,
      evidenceQuality: worst.evidence?.threadId !== undefined ? 'measured' : 'partial',
      evidenceNote: worst.evidence?.threadId !== undefined ? 'Measured durations with process/thread provenance.' : 'Measured durations; thread metadata was not identified.',
      investigation: ['Open the trace interval at the longest occurrence and inspect its call stack.', 'Check whether the same task name recurs in other rounds.', 'Compare with an equivalent run without the suspected change.'],
      evidence: group.tasks.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map(task => task.evidence).filter(Boolean)
    });
  }

  const frameSamples = [], cpuSamples = [], reactSamples = [], busySamples = [];
  for (const sample of run.samples) {
    if (Number.isFinite(sample.frameDurationMs) && sample.frameDurationMs > thresholds.frameBudgetMs) frameSamples.push(sample);
    if (Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= thresholds.cpuSpikePercent) cpuSamples.push(sample);
    if (Number.isFinite(sample.mainThreadBusyPercent) && sample.mainThreadBusyPercent >= thresholds.cpuSpikePercent) busySamples.push(sample);
    const reactDuration = sample.reactCommitMs ?? sample.dispatchDurationMs;
    if (Number.isFinite(reactDuration) && reactDuration >= thresholds.reactCommitMs) reactSamples.push({ sample, reactDuration });
  }

  const pushAggregate = (samples, { category, severity, title, observed, interpretation, impact, rule, threshold, unit, pick, evidenceQuality, evidenceNote, investigation }) => {
    if (!samples.length) return;
    const worst = samples.reduce((best, s) => (pick(s) > pick(best) ? s : best), samples[0]);
    findings.push({
      id: `${category}-${samples.length}-${Math.round(pick(worst))}`, category, severity, title, observed, interpretation, impact,
      description: `${observed} This pattern appeared ${samples.length} time(s) in the analyzed range; worst observed value ${pick(worst).toFixed(1)} ${unit}.`,
      roundId: worst.roundId, startMs: samples[0].timestampMs, endMs: samples[samples.length - 1].timestampMs,
      value: Number(pick(worst).toFixed(1)), unit, threshold, rule, recurrence: samples.length,
      evidenceQuality, evidenceNote, investigation, evidence: samples.slice(0, 5).map(s => s.evidence).filter(Boolean)
    });
  };

  pushAggregate(frameSamples, {
    category: 'frames', severity: frameSamples.some(s => s.frameDurationMs >= thresholds.frameCriticalMs) ? 'critical' : 'warning',
    title: 'Frames exceeded the frame budget',
    observed: `Observed frame intervals exceeded the ${thresholds.frameBudgetMs.toFixed(1)} ms budget (${targetFps} FPS target).`,
    interpretation: 'Frames that take longer than the budget are shown late, which reads as stutter or a dropped frame.',
    impact: 'The player sees uneven motion and less responsive input on affected frames.',
    rule: `frameDurationMs > ${thresholds.frameBudgetMs.toFixed(2)}`, threshold: Number(thresholds.frameBudgetMs.toFixed(2)), unit: 'ms', pick: s => s.frameDurationMs,
    evidenceQuality: 'measured', evidenceNote: 'Frame intervals are derived from recognized frame marker events, not from arbitrary task durations.',
    investigation: ['Open the slowest frame interval and inspect what ran before it.', 'Check whether the slow frames cluster in a bonus or win animation.', 'Compare the frame-time distribution with a stable run.']
  });
  pushAggregate(busySamples, {
    category: 'cpu', severity: busySamples.some(s => s.mainThreadBusyPercent >= thresholds.cpuCriticalPercent) ? 'critical' : 'warning',
    title: 'Sustained main-thread busy time',
    observed: `Main-thread busy time reached ${Math.max(...busySamples.map(s => s.mainThreadBusyPercent)).toFixed(1)}% in a one-second window.`,
    interpretation: 'Busy time is the share of a window the main thread spent inside trace tasks. High values leave little room to paint frames or handle input.',
    impact: 'Frame pacing and input responsiveness degrade while the main thread stays busy.',
    rule: `mainThreadBusyPercent >= ${thresholds.cpuSpikePercent}`, threshold: thresholds.cpuSpikePercent, unit: '%', pick: s => s.mainThreadBusyPercent,
    evidenceQuality: 'measured', evidenceNote: 'Derived from overlapping main-thread task intervals, merged so nested work is counted once. This is not CPU utilization.',
    investigation: ['Open the busy window and inspect the longest task inside it.', 'Check whether busy windows recur in the same part of a round.', 'Compare with a run that does not show the pattern.']
  });

  pushAggregate(cpuSamples, {
    category: 'cpu', severity: cpuSamples.some(s => s.cpuPercent >= thresholds.cpuCriticalPercent) ? 'critical' : 'warning',
    title: 'CPU utilization spike',
    observed: `Explicitly measured utilization reached ${Math.max(...cpuSamples.map(s => s.cpuPercent)).toFixed(1)}%.`,
    interpretation: 'Sustained high utilization leaves little headroom for rendering and input on the main thread.',
    impact: 'Frame pacing can degrade while utilization stays high.',
    rule: `cpuPercent >= ${thresholds.cpuSpikePercent}`, threshold: thresholds.cpuSpikePercent, unit: '%', pick: s => s.cpuPercent,
    evidenceQuality: 'measured', evidenceNote: 'Only generated from explicit utilization samples; trace task duration is never converted to CPU percent.',
    investigation: ['Confirm which process/thread produced the utilization sample.', 'Correlate the spike with long tasks in the same interval.', 'Check whether the spike recurs each round.']
  });
  pushAggregate(reactSamples.map(r => ({ ...r.sample, reactCommitMs: r.reactDuration })), {
    category: 'react-redux', severity: reactSamples.some(r => r.reactDuration >= thresholds.reactCriticalMs) ? 'critical' : 'warning',
    title: 'Slow instrumented render or dispatch',
    observed: `Instrumented work reached ${Math.max(...reactSamples.map(r => r.reactDuration)).toFixed(1)} ms.`,
    interpretation: 'This is measured work inside the instrumented path. It identifies cost, not proof that it caused a slow frame.',
    impact: 'If it runs inside a frame, it competes with rendering for the same frame budget.',
    rule: `reactCommitMs >= ${thresholds.reactCommitMs.toFixed(2)}`, threshold: Number(thresholds.reactCommitMs.toFixed(2)), unit: 'ms', pick: s => s.reactCommitMs,
    evidenceQuality: 'measured', evidenceNote: 'Requires the optional React/Redux instrumentation; component identity is not asserted.',
    investigation: ['Identify the committing subtree in the Profiler session.', 'Check whether the commit overlaps a slow frame interval.', 'Measure the same interaction with instrumentation disabled.']
  });

  const heaps = run.samples.filter(s => Number.isFinite(s.jsHeapUsedBytes));
  if (heaps.length > 2) {
    const delta = heaps[heaps.length - 1].jsHeapUsedBytes - heaps[0].jsHeapUsedBytes;
    if (delta > thresholds.heapGrowthBytes) {
      findings.push({
        id: 'heap-growth-observed', category: 'memory', severity: 'warning', title: 'Potential heap retention',
        observed: `Heap usage increased by ${(delta / 1048576).toFixed(1)} MiB across the observed samples.`,
        interpretation: 'A rising heap can indicate objects retained longer than expected. Garbage-collection timing, sampling interval, and workload all affect this.',
        impact: 'If retention is real it can raise memory pressure and pause times over a long session.',
        description: 'Heap usage increased across the observed samples. Growth alone does not establish a leak.',
        startMs: heaps[0].timestampMs, endMs: heaps[heaps.length - 1].timestampMs, value: Number((delta / 1048576).toFixed(1)), unit: 'MiB',
        threshold: Number((thresholds.heapGrowthBytes / 1048576).toFixed(0)), rule: `heapDelta > ${(thresholds.heapGrowthBytes / 1048576).toFixed(0)} MiB`,
        recurrence: 1, evidenceQuality: 'partial', evidenceNote: 'Based on sampled heap counters; GC timing is not directly observed.',
        investigation: ['Check whether the heap returns to baseline after the run.', 'Force garbage collection in DevTools and re-check.', 'Capture a heap snapshot at the start and end of the run.'],
        evidence: heaps.slice(0, 2).map(s => s.evidence).filter(Boolean)
      });
    }
  }

  if (!run.samples.some(s => Number.isFinite(s.reactCommitMs) || Number.isFinite(s.dispatchDurationMs)) && !findings.some(f => f.id === 'react-instrumentation-missing')) {
    findings.push({
      id: 'react-instrumentation-missing', category: 'react-redux', severity: 'info', title: 'React / Redux instrumentation unavailable',
      observed: 'No React commit or Redux dispatch timings are present in this trace.',
      interpretation: 'Component commit and store notification costs cannot be assessed from browser trace events alone.',
      impact: 'Framework-level cost stays unmeasured until the optional instrumentation is enabled.',
      description: 'Component commit, dispatch, middleware, and selector costs cannot be assessed without optional application instrumentation.',
      evidenceQuality: 'unavailable', evidenceNote: 'No measurement exists for this metric in the imported trace.',
      investigation: ['Enable the optional instrumentation helpers for a development run.', 'Re-capture and re-import the trace.'], evidence: []
    });
  }
  if (!run.events?.some(e => e.type === 'roundStart') && !findings.some(f => f.id === 'round-markers-missing')) {
    findings.push({
      id: 'round-markers-missing', category: 'rounds', severity: 'info', title: 'Game round markers unavailable',
      observed: 'No round start markers were found in this run.',
      interpretation: 'Round-level grouping needs explicit, clock-aligned markers; they cannot be inferred reliably from trace timing.',
      impact: 'Trace-level analysis stays valid, but findings cannot be grouped by round yet.',
      description: 'Trace-only analysis is available, but round-level correlation requires aligned game markers.',
      evidenceQuality: 'unavailable', evidenceNote: 'No marker sidecar was imported for this run.',
      investigation: ['Import a marker sidecar aligned to the trace clock on the Traces page.'], evidence: []
    });
  }
  return rankFindings(findings, thresholds);
}

/** Transparent priority score. Higher scores are listed first. */
export function priorityScore(finding, thresholds = THRESHOLDS) {
  const weights = thresholds.priority;
  const severity = weights.severity[finding.severity] ?? weights.severity.info;
  const duration = Number.isFinite(finding.value) ? Math.min(finding.value, 500) * weights.duration : 0;
  const recurrence = Math.min(finding.recurrence ?? 1, 200) * weights.recurrence;
  const evidence = finding.evidenceQuality === 'measured' ? weights.evidence : finding.evidenceQuality === 'partial' ? weights.evidence / 2 : 0;
  return Math.round(severity + duration + recurrence + evidence);
}

export function priorityReason(finding) {
  const parts = [`${finding.severity} severity`];
  if (Number.isFinite(finding.value)) parts.push(`${finding.value} ${finding.unit || ''}`.trim());
  if ((finding.recurrence ?? 1) > 1) parts.push(`recurred ${finding.recurrence}×`);
  parts.push(`${finding.evidenceQuality ?? 'partial'} evidence`);
  return parts.join(' · ');
}

export function rankFindings(findings, thresholds = THRESHOLDS) {
  return findings
    .map(finding => ({ ...finding, priority: priorityScore(finding, thresholds) }))
    .sort((a, b) => b.priority - a.priority || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Ordered processing stages reported to the import UI. */
export const IMPORT_STAGES = Object.freeze([
  'selected', 'validating', 'reading', 'parsing', 'normalizing', 'analyzing', 'findings', 'preparing', 'completed'
]);

export function stageIndex(stage) {
  const index = IMPORT_STAGES.indexOf(stage);
  return index === -1 ? -1 : index;
}

/** Runs every analysis step once so the UI never recomputes it during render. */
export function analyzeRun(run, config = {}, hooks = {}) {
  const { onStage = () => {}, shouldAbort = () => false } = hooks;
  const check = () => { if (shouldAbort()) throw new DOMException('Trace analysis was cancelled.', 'AbortError'); };
  onStage('normalizing', 'Normalizing trace events…');
  check();
  const availability = metricAvailability(run);
  const withAvailability = { ...run, metadata: { ...run.metadata, availability } };
  onStage('analyzing', 'Analyzing performance metrics…');
  check();
  const summary = summarizeRun(withAvailability, config);
  const rounds = summarizeRounds(withAvailability, config);
  onStage('findings', 'Generating findings…');
  check();
  const findings = generateFindings(withAvailability, config);
  const analyzed = { ...withAvailability, findings };
  onStage('preparing', 'Preparing dashboard data…');
  check();
  const chartMetrics = ['mainThreadBusyPercent', 'cpuPercent', 'fps', 'jsHeapUsedBytes', 'reactCommitMs'];
  const chartSamples = {};
  for (const metric of chartMetrics) {
    const values = [];
    for (const sample of run.samples) if (Number.isFinite(sample[metric])) values.push(sample);
    const stride = Math.max(1, Math.ceil(values.length / 1200));
    chartSamples[metric] = stride > 1 ? values.filter((_, index) => index % stride === 0 || index === values.length - 1) : values;
  }
  const longTasks = run.tasks.filter(task => task.durationMs >= (config.longTaskMs ?? THRESHOLDS.longTaskMs));
  analyzed.analysis = {
    summary,
    findings,
    rankedFindings: findings.slice(0, 100),
    rounds,
    longTasks,
    chartSamples,
    chartTimeRange: run.samples.length ? [run.samples[0].timestampMs, run.samples[run.samples.length - 1].timestampMs] : [0, 0]
  };
  return analyzed;
}

export function compareBaseline(current, baseline) {
  if (!baseline) return { compatible: false, reason: 'No baseline selected.' };
  const mismatches = [];
  for (const key of ['buildId', 'environment', 'source']) if (current[key] !== baseline[key]) mismatches.push(key);
  return { compatible: mismatches.length === 0, reason: mismatches.length ? `Comparison warning: different ${mismatches.join(', ')}. Treat changes as non-comparable.` : 'Metadata matches; this is a descriptive comparison, not a statistical significance test.', mismatches };
}

export function buildReportSnapshot(run, config = {}) {
  const findings = generateFindings(run, config);
  const enriched = { ...run, findings };
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), run: enriched, summary: summarizeRun(enriched, config), rounds: summarizeRounds(enriched, config), findings, coverage: metricCoverage(enriched) };
}

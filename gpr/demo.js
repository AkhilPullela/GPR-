import { SOURCE } from './model.js';

// Deliberately synthetic UI-evaluation data. Never combined with imported runs.
export function createDemoRun() {
  const started = Date.now() - 32 * 42000;
  const samples = [];
  const events = [];
  const rounds = 32;
  for (let round = 1; round <= rounds; round++) {
    const start = (round - 1) * 42000;
    events.push({ timestampMs: start, roundId: round, type: 'roundStart' });
    if ([4, 9, 17, 26].includes(round)) events.push({ timestampMs: start + 12000, roundId: round, type: 'bonusStart', name: 'Bonus sequence' });
    for (let point = 0; point < 4; point++) {
      const spike = [8, 17, 26].includes(round) && point === 2;
      const dropped = [9, 17, 26].includes(round) && point === 2;
      const sample = {
        timestampMs: start + point * 9000 + 3000,
        roundId: round,
        cpuPercent: round === 13 && point === 2 ? undefined : Math.min(94, 34 + Math.sin(round * 1.3 + point) * 10 + (spike ? 42 : 0)),
        fps: round === 5 && point === 1 ? undefined : dropped ? 39 + point : 58 + Math.sin(round + point) * 2,
        frameDurationMs: dropped ? 25 + point : 16 + Math.sin(round + point) * 1.4,
        jsHeapUsedBytes: 228 * 1024 * 1024 + round * 2.7 * 1024 * 1024 + point * 1.1 * 1024 * 1024,
        source: SOURCE.DEMO
      };
      if (round === 13 && point === 2) delete sample.cpuPercent;
      if (round === 5 && point === 1) delete sample.fps;
      samples.push(sample);
    }
    if ([4, 9, 17, 26].includes(round)) events.push({ timestampMs: start + 23000, roundId: round, type: 'bonusEnd', name: 'Bonus sequence' });
    events.push({ timestampMs: start + 36000, roundId: round, type: 'roundEnd' });
  }
  const findings = [
    { id: 'demo-task-17', category: 'cpu', severity: 'critical', title: 'Potential main-thread stall', observed: 'A synthetic 128 ms main-thread task overlaps a bonus sequence.', interpretation: 'Tasks this long block rendering and input handling.', impact: 'Frames can be delayed during the bonus sequence.', description: 'A synthetic 128 ms task overlaps a bonus sequence.', roundId: 17, startMs: events.find(e => e.roundId === 17).timestampMs + 18000, endMs: events.find(e => e.roundId === 17).timestampMs + 18128, value: 128, unit: 'ms', threshold: 50, rule: 'durationMs >= 50', recurrence: 1, evidenceQuality: 'measured', evidenceNote: 'Synthetic fixture value; no real trace evidence.', investigation: ['Inspect the call stack of the overlapping task.'], evidence: [] },
    { id: 'demo-frames-26', category: 'frames', severity: 'warning', title: 'Frames exceeded the frame budget', observed: 'Synthetic frame duration exceeded the 16.67 ms budget during a bonus.', interpretation: 'Frames shown late read as stutter.', impact: 'Uneven motion during the bonus.', description: 'Frame duration exceeded the 16.67 ms budget in this synthetic sample.', roundId: 26, value: 27, unit: 'ms', threshold: 16.67, rule: 'frameDurationMs > 16.67', recurrence: 3, evidenceQuality: 'measured', evidenceNote: 'Synthetic fixture value.', investigation: ['Compare with a stable round.'], evidence: [] },
    { id: 'demo-memory', category: 'memory', severity: 'warning', title: 'Potential heap retention', observed: 'Synthetic heap usage trends upward by 84 MiB.', interpretation: 'Growth alone is not proof of a leak.', impact: 'Memory pressure could build over a long session.', description: 'Synthetic heap usage trends upward. This is a potential retention signal, not proof of a leak.', value: 84, unit: 'MiB', threshold: 32, rule: 'heapDelta > 32 MiB', recurrence: 1, evidenceQuality: 'partial', evidenceNote: 'Synthetic fixture value.', investigation: ['Capture start and end heap snapshots.'], evidence: [] },
    { id: 'demo-react', category: 'react-redux', severity: 'info', title: 'Repeated instrumented renders', observed: 'Illustrative instrumentation finding of 38 ms.', interpretation: 'Measured work, not proof of causation.', impact: 'Competes with rendering for the frame budget.', description: 'Illustrative instrumentation finding; component identity is intentionally not asserted.', roundId: 9, value: 38, unit: 'ms', threshold: 16.67, rule: 'reactCommitMs >= 16.67', recurrence: 2, evidenceQuality: 'measured', evidenceNote: 'Synthetic fixture value.', investigation: ['Identify the committing subtree.'], evidence: [] }
  ];
  return {
    id: 'demo-zeus-32-rounds', game: 'Zeus vs Hades', buildId: 'demo-build-2025.04', environment: 'Synthetic desktop / 60 Hz target', startedAt: new Date(started).toISOString(), source: SOURCE.DEMO,
    samples, events, findings, tasks: [], metadata: {
      browser: 'Synthetic fixture',
      roundCount: rounds,
      eventCount: events.length,
      normalizedEventCount: samples.length,
      processCount: 1,
      threadInfo: ['Synthetic fixture · no real process/thread data'],
      mainThreadDetected: false,
      traceDurationMs: samples.length ? samples[samples.length - 1].timestampMs - samples[0].timestampMs : undefined,
      diagnostics: {
        phases: [{ name: 'Synthetic', count: samples.length }],
        categories: [{ name: 'fixture', count: samples.length }],
        mainThreadIntervalCount: 0,
        mergedIntervalCount: 0
      },
      limitations: ['All values are synthetic and are not measurements from the game.']
    }
  };
}

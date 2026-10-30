/**
 * Import state machine and runner.
 *
 * Kept UI-independent so the same logic is exercised by unit tests and by the
 * React app. The manager owns:
 * - the ordered stage lifecycle,
 * - monotonic sequencing so an older import can never overwrite a newer one,
 * - throttled progress notifications so React never re-renders per trace event,
 * - cancellation and cleanup for the background worker,
 * - a "previous report survives a failed import" guarantee.
 */

export const IMPORT_STAGES = Object.freeze([
  'idle', 'selected', 'validating', 'reading', 'parsing', 'normalizing', 'analyzing', 'findings', 'preparing', 'completed', 'cancelled', 'error'
]);

/** Stages that count as actively processing. */
export const BUSY_STAGES = Object.freeze(['validating', 'reading', 'parsing', 'normalizing', 'analyzing', 'findings', 'preparing']);

export const STAGE_LABEL = Object.freeze({
  idle: 'Idle',
  selected: 'File selected',
  validating: 'Validating file',
  reading: 'Reading file',
  parsing: 'Parsing trace events',
  normalizing: 'Normalizing events',
  analyzing: 'Analyzing metrics',
  findings: 'Generating findings',
  preparing: 'Preparing dashboard',
  completed: 'Import completed',
  cancelled: 'Cancelled',
  error: 'Failed'
});

/** Stage descriptions explain what the tool is doing in plain language. */
export const STAGE_DETAIL = Object.freeze({
  validating: 'Checking the file type and size before reading anything.',
  reading: 'Streaming bytes from disk. Progress is measured from bytes read.',
  parsing: 'Decoding Chrome trace events with an incremental JSON parser.',
  normalizing: 'Turning raw events into measurements with source evidence.',
  analyzing: 'Calculating main-thread, frame, and memory statistics.',
  findings: 'Applying the documented severity rules to the measurements.',
  preparing: 'Building the charts and tables the dashboard renders.'
});

export function isBusyStage(stage) { return BUSY_STAGES.includes(stage); }

/**
 * Single source of truth for what the import control should render.
 *
 * The control is intentionally always `visible` and always `enabled`: a new
 * file selection supersedes an in-flight import instead of being blocked, and a
 * completed or failed import must never hide or permanently disable it. Keeping
 * this as a pure function lets the UI stay a thin renderer and lets tests assert
 * the invariant across every terminal state.
 */
export function describeImportControl(state = initialImportState()) {
  const busy = isBusyStage(state.stage);
  const percent = Number.isFinite(state.percent) ? state.percent : undefined;
  const failed = state.status === 'error';
  const cancelled = state.status === 'cancelled';
  const terminal = state.status === 'completed' || failed || cancelled;
  return {
    visible: true,
    enabled: true,
    busy,
    terminal,
    status: state.status,
    stage: state.stage,
    label: busy ? 'Importing…' : 'Import trace',
    stageLabel: STAGE_LABEL[state.stage] || STAGE_LABEL[state.status] || 'Idle',
    detail: busy ? (STAGE_DETAIL[state.stage] || '') : '',
    message: state.message || '',
    error: failed ? (state.error || state.message || '') : '',
    fileName: state.fileName || '',
    fileSize: state.fileSize,
    percent,
    // An indeterminate bar is shown only while processing without a measurable
    // percentage. A percentage is never invented for stages that cannot measure it.
    indeterminate: busy && percent === undefined,
    eventCount: Number.isFinite(state.eventCount) ? state.eventCount : undefined,
    elapsedMs: busy ? state.elapsedMs : undefined,
    canCancel: busy && state.canCancel !== false,
    canRetry: failed && state.canRetry !== false,
    canClear: terminal
  };
}

export function initialImportState() {
  return {
    status: 'idle',
    stage: 'idle',
    message: '',
    detail: '',
    percent: undefined,
    fileName: '',
    fileSize: undefined,
    bytesRead: undefined,
    eventCount: undefined,
    startedAt: undefined,
    elapsedMs: undefined,
    error: '',
    canRetry: false,
    canCancel: false,
    sequence: 0
  };
}

/**
 * Import manager.
 *
 * `parse(file, fileName, onProgress, signal)` must return the analyzed run.
 * `onState(state)` receives every state transition. `onResult(run, file)` is
 * called only for the newest import and only on success, so the dashboard is
 * updated atomically and never shows a stale run.
 */
export function createImportManager({ parse, onState = () => {}, onResult = () => {}, onError = () => {}, now = () => Date.now(), throttleMs = 100 } = {}) {
  let state = initialImportState();
  let controller = null;
  let sequence = 0;
  let lastEmit = 0;
  let pendingProgress = null;
  let flushTimer = null;

  const emit = (patch, { force = false } = {}) => {
    state = { ...state, ...patch };
    const at = now();
    if (force || at - lastEmit >= throttleMs) {
      lastEmit = at;
      pendingProgress = null;
      onState(state);
      return;
    }
    // Coalesce high-frequency updates so React renders at a bounded rate while
    // still receiving the newest values.
    pendingProgress = patch;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pendingProgress) { const next = pendingProgress; pendingProgress = null; lastEmit = now(); onState({ ...state, ...next }); }
      }, Math.max(0, throttleMs - (at - lastEmit)));
    }
  };

  const clearTimers = () => { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } pendingProgress = null; };

  function cancel() {
    if (!controller) { emit({ status: 'cancelled', stage: 'cancelled', message: 'Import cancelled. The original file was not modified.', percent: undefined, canCancel: false, canRetry: false }, { force: true }); return; }
    controller.abort();
    controller = null;
    clearTimers();
    emit({ status: 'cancelled', stage: 'cancelled', message: 'Import cancelled. The original file on disk was not modified.', percent: undefined, canCancel: false, canRetry: false }, { force: true });
  }

  function reset() { clearTimers(); controller = null; emit(initialImportState(), { force: true }); }

  async function start(file) {
    if (!file) return;
    // A new import always supersedes any in-flight one.
    if (controller) { controller.abort(); controller = null; }
    clearTimers();
    const current = ++sequence;
    const local = new AbortController();
    controller = local;
    const startedAt = now();
    const base = { fileName: file.name, fileSize: file.size, startedAt, elapsedMs: 0, error: '', canRetry: false, canCancel: true, percent: undefined, sequence: current };
    emit({ ...base, status: 'selected', stage: 'selected', message: `Selected ${file.name}.`, detail: STAGE_DETAIL.validating }, { force: true });

    try {
      emit({ ...base, status: 'validating', stage: 'validating', message: 'Validating file type and size…', detail: STAGE_DETAIL.validating }, { force: true });
      const isJson = /\.json$/i.test(file.name) || (file.type || '').includes('json');
      if (!isJson) throw Object.assign(new Error(`“${file.name}” is not a JSON file. GPR accepts Chrome DevTools Performance JSON exports (.json).`), { userFacing: true, canRetry: false });
      if (!file.size) throw Object.assign(new Error('The selected file is empty (0 bytes). Export a non-empty trace from Chrome DevTools.'), { userFacing: true, canRetry: false });

      const run = await parse(file, file.name, progress => {
        if (current !== sequence || local.signal.aborted) return;
        const stage = progress.stage || 'reading';
        emit({
          ...base,
          status: stage === 'parsing' ? 'parsing' : 'reading',
          stage,
          message: progress.message || STAGE_LABEL[stage] || 'Processing…',
          detail: STAGE_DETAIL[stage] || '',
          percent: Number.isFinite(progress.percent) ? progress.percent : undefined,
          bytesRead: progress.bytesRead,
          eventCount: Number.isFinite(progress.eventCount) ? progress.eventCount : state.eventCount,
          elapsedMs: now() - startedAt
        });
      }, local.signal);

      if (current !== sequence) return; // superseded by a newer import
      if (local.signal.aborted) return;
      clearTimers();
      controller = null;
      const eventCount = run.metadata?.eventCount ?? run.metadata?.normalizedEventCount;
      emit({
        ...base,
        status: 'completed',
        stage: 'completed',
        message: `Analyzed ${(run.metadata?.normalizedEventCount ?? 0).toLocaleString()} recognized events.`,
        detail: '',
        percent: 100,
        eventCount,
        elapsedMs: now() - startedAt,
        canCancel: false,
        canRetry: false
      }, { force: true });
      onResult(run, file);
    } catch (error) {
      if (current !== sequence) return;
      clearTimers();
      if (controller === local) controller = null;
      if (error?.name === 'AbortError' || local.signal.aborted) {
        emit({ ...base, status: 'cancelled', stage: 'cancelled', message: 'Import cancelled. The original file on disk was not modified.', percent: undefined, canCancel: false }, { force: true });
        return;
      }
      const message = error?.message || 'Trace import failed.';
      emit({ ...base, status: 'error', stage: 'error', message, detail: '', error: message, percent: undefined, canCancel: false, canRetry: error?.canRetry !== false, elapsedMs: now() - startedAt }, { force: true });
      onError(error);
    }
  }

  return {
    start,
    cancel,
    reset,
    getState: () => state,
    get isBusy() { return isBusyStage(state.stage); },
    dispose() { clearTimers(); if (controller) { controller.abort(); controller = null; } }
  };
}

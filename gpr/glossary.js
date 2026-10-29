/**
 * Short, plain-language definitions for the technical terms shown in the UI.
 * Kept UI-independent so reports and tooltips share one source of truth.
 */
export const GLOSSARY = Object.freeze({
  longTask: { term: 'Long task', definition: 'A single main-thread task that runs longer than 50 ms. While it runs, the browser cannot paint or respond to input, so animations and taps can stutter.' },
  mainThreadBlocking: { term: 'Main-thread blocking', definition: 'Time the browser main thread spends on one piece of work without yielding. Long blocks delay rendering and input handling for their whole duration.' },
  frameTime: { term: 'Frame time', definition: 'The wall-clock gap between two rendered frames. A 60 FPS target needs roughly 16.7 ms per frame; longer gaps mean dropped frames.' },
  fps: { term: 'FPS', definition: 'Frames per second, computed here from measured frame intervals. 60 FPS means one frame about every 16.7 ms.' },
  frameP95: { term: 'p95 frame time', definition: 'The frame time that 95% of frames were faster than. It shows the slower end of the distribution, which an average would hide.' },
  jsHeap: { term: 'JavaScript heap', definition: 'Memory currently allocated to JavaScript objects in the page. It rises and falls as objects are created and garbage collected.' },
  heapGrowth: { term: 'Heap growth', definition: 'The change in heap size between the first and last sample. Growth alone is not a leak; garbage-collection timing and workload matter.' },
  reactRender: { term: 'React render duration', definition: 'Time React spent committing a render, measured by the React Profiler. It is measured work, not proof that it caused a slow frame.' },
  reduxTiming: { term: 'Redux action timing', definition: 'Time between dispatching a Redux action and the store finishing notification. Requires optional middleware instrumentation.' },
  traceEvent: { term: 'Trace event', definition: 'One entry in a Chrome trace: a timestamped record with a process/thread id, a phase, and a name. It is the raw evidence behind every measurement.' },
  correlationCausation: { term: 'Correlation vs causation', definition: 'Two things happening at the same time is a correlation. It becomes causation only when the mechanism is confirmed, so overlap is a lead to investigate, not a proven cause.' },
  coverage: { term: 'Measurement coverage', definition: 'Which metrics were actually present in this trace. Missing metrics are shown as "Not captured" rather than zero.' }
});

export function glossaryEntry(key) {
  return GLOSSARY[key];
}

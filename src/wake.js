// In-process wakeups so the next stage starts the moment the previous one finishes. The database stays the source of truth:
// a lost wakeup (or another process) costs at most one short fallback poll, never a job.
const waiters = new Set();
export function wake() { for (const w of [...waiters]) w(); }
export const sleepOrWake = ms => new Promise(resolve => { let t; const done = () => { clearTimeout(t); waiters.delete(done); resolve(); }; t = setTimeout(done, ms); waiters.add(done); });

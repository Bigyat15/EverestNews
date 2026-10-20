// Transaction-based undo/redo for a design document (pure; shared with the browser editor).
// A drag or resize is ONE history entry: begin() -> update() many times -> end().
export function createHistory(initial, { limit = 100 } = {}) {
  let present = initial, past = [], future = [], tx = null, saved = JSON.stringify(initial);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const push = (doc) => { past.push(doc); if (past.length > limit) past.shift(); future = []; };
  return {
    get doc() { return present; },
    commit(doc) { if (tx) { present = doc; return; } if (same(doc, present)) return; push(present); present = doc; }, // a discrete change: one entry
    begin() { if (!tx) tx = { start: present }; },
    update(doc) { present = doc; }, // live change inside a transaction (pointer movement): not recorded
    end() { if (!tx) return; const t = tx; tx = null; if (!same(t.start, present)) push(t.start); },
    cancel() { if (!tx) return; present = tx.start; tx = null; }, // Escape during a drag
    undo() { if (tx) { this.cancel(); return present; } if (!past.length) return present; future.push(present); present = past.pop(); return present; },
    redo() { if (tx || !future.length) return present; past.push(present); present = future.pop(); return present; },
    get canUndo() { return !!past.length || !!tx; }, get canRedo() { return !!future.length && !tx; }, get active() { return !!tx; },
    reset(doc) { present = doc; past = []; future = []; tx = null; saved = JSON.stringify(doc); },
    markSaved() { saved = JSON.stringify(present); }, get dirty() { return JSON.stringify(present) !== saved; },
  };
}

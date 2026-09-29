const STATE_KEY = 'collector-state-v1';

export function createD1PhaseStateStore(db) {
  return {
    async read() {
      const row = await db.prepare('SELECT state_json FROM phase_state WHERE state_key = ?')
        .bind(STATE_KEY).first();
      if (!row) return { data: null, etag: null };
      return { data: JSON.parse(row.state_json), etag: row.state_json };
    },

    async update(mutator, attempts = 4) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await this.read();
        const next = await mutator(current.data);
        const serialized = JSON.stringify(next);
        if (current.etag == null) {
          const result = await db.prepare(
            'INSERT OR IGNORE INTO phase_state (state_key, state_json, updated_at_ms) VALUES (?, ?, ?)',
          ).bind(STATE_KEY, serialized, Date.now()).run();
          if (result.meta?.changes) return next;
        } else {
          const result = await db.prepare(
            'UPDATE phase_state SET state_json = ?, updated_at_ms = ? WHERE state_key = ? AND state_json = ?',
          ).bind(serialized, Date.now(), STATE_KEY, current.etag).run();
          if (result.meta?.changes) return next;
        }
      }
      throw new Error('Phase history write conflict; retry on the next collection cycle');
    },
  };
}

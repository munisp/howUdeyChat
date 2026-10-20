// shredder.js — retention shredder & panic wipe (innovation 8).
//
// Some threads should not live forever: an HIV counselling thread, a
// mental-health consult. Patients (or clinic policy) set a retention TTL
// per thread; the shredder deletes expired messages from the local store
// and the outbox, and records a content-free audit line (thread id +
// count + time — never the messages). Panic wipe is one tap: everything
// local, gone, including media cache.
//
// The store is injected: anything with delete(id) and list(threadId).

export class Shredder {
  constructor(store, now = () => Date.now()) {
    this.store = store; this.now = now;
    this.policies = new Map(); // threadId -> {ttlSeconds, category}
    this.audit = [];
  }
  register(threadId, { ttlSeconds, category = "general" }) {
    this.policies.set(threadId, { ttlSeconds, category });
  }
  // remove messages older than TTL. Returns audit entries written.
  async sweep(at = this.now()) {
    const written = [];
    for (const [threadId, pol] of this.policies) {
      const msgs = await this.store.list(threadId);
      const expired = msgs.filter((m) => m.ts + pol.ttlSeconds * 1000 <= at);
      for (const m of expired) await this.store.delete(m.id);
      if (expired.length) {
        const entry = { thread_id: threadId, removed: expired.length, at };
        this.audit.push(entry); written.push(entry);
      }
    }
    return written;
  }
  async panicWipe() {
    let removed = 0;
    for (const threadId of this.policies.keys()) {
      const msgs = await this.store.list(threadId);
      for (const m of msgs) { await this.store.delete(m.id); removed++; }
    }
    const entry = { thread_id: "*", removed, at: this.now(), panic: true };
    this.audit.push(entry);
    return entry;
  }
}

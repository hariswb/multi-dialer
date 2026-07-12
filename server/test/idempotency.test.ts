import { beforeEach, describe, expect, it } from 'vitest';
import { createServices, type Services } from '../src/app.js';

/**
 * Idempotency tests (NOTES §5.2): duplicate and concurrent-duplicate
 * `callTerminal` events must produce exactly one activity; same-lead syncs
 * must produce exactly one contact.
 */

/** A latency gate the test opens explicitly, to hold CRM writes in flight. */
function makeGate() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { latency: () => gate, open };
}

let s: Services;

beforeEach(() => {
  s = createServices({ crmLatency: () => Promise.resolve() });
});

/** Drive a call to a terminal state and return its id. */
function terminalCall(leadIds: string[] = ['lead-1']): string {
  const session = s.dialer.createSession(leadIds);
  s.dialer.start(session.id);
  const callId = session.activeCallIds[0]!;
  s.dialer.forceOutcome(callId, 'NO_ANSWER');
  return callId;
}

async function settled() {
  // Each macrotask tick drains the whole pending microtask chain first.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('CRM sync idempotency', () => {
  it('duplicate callTerminal events create exactly one activity', async () => {
    const callId = terminalCall();
    await settled();
    // Redeliver the same terminal event.
    s.emitter.emit('callTerminal', callId);
    await settled();

    expect(s.crm.listActivities().filter((a) => a.idempotencyKey === callId)).toHaveLength(1);
    expect([...s.store.activities.values()].filter((a) => a.callId === callId)).toHaveLength(1);
    expect(s.crmSync.statusFor(callId)).toBe('SYNCED');
  });

  it('concurrent duplicate (second event while first CRM write is in flight) creates one activity', async () => {
    const gate = makeGate();
    s = createServices({ crmLatency: gate.latency });
    const callId = terminalCall();

    // First sync is now parked inside the mock CRM's in-flight write.
    expect(s.crmSync.statusFor(callId)).toBe('PENDING');
    // Duplicate arrives mid-flight; the synchronous reservation must drop it.
    s.emitter.emit('callTerminal', callId);

    gate.open();
    await settled();

    expect(s.crmSync.statusFor(callId)).toBe('SYNCED');
    expect(s.crm.listActivities().filter((a) => a.idempotencyKey === callId)).toHaveLength(1);
    expect([...s.store.activities.values()].filter((a) => a.callId === callId)).toHaveLength(1);
  });

  it('two terminal calls for the same lead create exactly one contact (per-lead serialization)', async () => {
    const gate = makeGate();
    s = createServices({ crmLatency: gate.latency });

    // Two sessions, both dialing lead-1 → two distinct calls, same lead.
    const c1 = terminalCall(['lead-1']);
    const c2 = terminalCall(['lead-1']);
    expect(c1).not.toBe(c2);

    // Both syncs are pending before any CRM write completes; without
    // serialization both would see "no crmExternalId" and create 2 contacts.
    gate.open();
    await settled();

    expect(s.crmSync.statusFor(c1)).toBe('SYNCED');
    expect(s.crmSync.statusFor(c2)).toBe('SYNCED');
    const lead = s.store.leads.get('lead-1')!;
    expect(s.crm.listContacts().filter((c) => c.email === lead.email)).toHaveLength(1);
    expect(s.crm.listActivities()).toHaveLength(2); // one activity per call, still
  });
});

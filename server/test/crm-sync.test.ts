import { beforeEach, describe, expect, it } from 'vitest';
import { createServices, type Services } from '../src/app.js';

/**
 * CRM sync behavior tests (NOTES §5.3): contact upsert rules, dual-store
 * activity writes, and failure independence.
 */

let s: Services;

beforeEach(() => {
  s = createServices({ crmLatency: () => Promise.resolve() });
});

function terminalCall(leadId: string): string {
  const session = s.dialer.createSession([leadId]);
  s.dialer.start(session.id);
  const callId = session.activeCallIds[0]!;
  s.dialer.forceOutcome(callId, 'VOICEMAIL');
  return callId;
}

async function settled() {
  // Each macrotask tick drains the whole pending microtask chain first.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('CRM sync', () => {
  it('creates a contact when the lead has no crmExternalId and persists the id to the lead', async () => {
    const lead = s.store.leads.get('lead-1')!;
    expect(lead.crmExternalId).toBeUndefined();

    const callId = terminalCall('lead-1');
    await settled();

    expect(lead.crmExternalId).toBeDefined();
    const contact = s.crm.listContacts().find((c) => c.id === lead.crmExternalId);
    expect(contact).toMatchObject({ name: lead.name, phone: lead.phone, email: lead.email });
    expect(s.crmSync.statusFor(callId)).toBe('SYNCED');
  });

  it('skips contact creation when the lead already has a crmExternalId', async () => {
    // lead-6 is seeded with an existing CRM contact.
    const before = s.crm.listContacts().length;
    terminalCall('lead-6');
    await settled();

    expect(s.crm.listContacts()).toHaveLength(before);
    expect(s.store.leads.get('lead-6')!.crmExternalId).toBe('crm-contact-1000');
  });

  it('writes the activity to both the app DB and the mock CRM, with disposition = call status', async () => {
    const callId = terminalCall('lead-2');
    await settled();

    const appActivity = s.store.activityByCallId.get(callId)!;
    expect(appActivity).toMatchObject({
      leadId: 'lead-2',
      callId,
      type: 'CALL',
      disposition: 'VOICEMAIL',
      crmExternalId: s.store.leads.get('lead-2')!.crmExternalId,
    });
    expect(s.store.activities.get(appActivity.id)).toBe(appActivity);

    const crmActivity = s.crm.listActivities().find((a) => a.idempotencyKey === callId)!;
    expect(crmActivity).toMatchObject({ disposition: 'VOICEMAIL', contactId: appActivity.crmExternalId });
  });

  it('syncs CANCELED_BY_DIALER calls too (terminal outcome, no exclusions)', async () => {
    const session = s.dialer.createSession(['lead-3', 'lead-4']);
    s.dialer.start(session.id);
    const [c1, c2] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'CONNECTED'); // c2 → CANCELED_BY_DIALER
    await settled();

    expect(s.crmSync.statusFor(c2!)).toBe('SYNCED');
    expect(s.store.activityByCallId.get(c2!)!.disposition).toBe('CANCELED_BY_DIALER');
  });

  it('a connected call syncs when it ends, not when it connects, with disposition CONNECTED', async () => {
    const session = s.dialer.createSession(['lead-5']);
    s.dialer.start(session.id);
    const callId = session.activeCallIds[0]!;
    s.dialer.forceOutcome(callId, 'CONNECTED');
    await settled();
    expect(s.crmSync.statusFor(callId)).toBeNull(); // not terminal yet

    s.dialer.hangup(session.id, callId);
    await settled();
    expect(s.crmSync.statusFor(callId)).toBe('SYNCED');
    expect(s.store.activityByCallId.get(callId)!.disposition).toBe('CONNECTED');
  });

  it('a CRM failure marks the sync FAILED without corrupting session or call state', async () => {
    s.crm.failNext = 1;
    const session = s.dialer.createSession(['lead-1', 'lead-2']);
    s.dialer.start(session.id);
    const [c1] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'BUSY');
    await settled();

    expect(s.crmSync.statusFor(c1!)).toBe('FAILED');
    expect(s.store.activityByCallId.has(c1!)).toBe(false);
    // Dialer state untouched: session kept running and refilled normally.
    expect(session.status).toBe('RUNNING');
    expect(s.store.calls.get(c1!)!.status).toBe('BUSY');

    // A later terminal call for the same lead still syncs (record retryable).
    s.crm.failNext = 0;
    const c2 = session.activeCallIds.find((id) => id !== c1)!;
    s.dialer.forceOutcome(c2, 'NO_ANSWER');
    await settled();
    expect(s.crmSync.statusFor(c2)).toBe('SYNCED');
  });
});

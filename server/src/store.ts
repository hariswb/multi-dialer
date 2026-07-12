import type { Call, CRMActivity, DialerSession, Lead } from '@dialer/shared';

export interface Store {
  leads: Map<string, Lead>;
  calls: Map<string, Call>;
  sessions: Map<string, DialerSession>;
  /** App's own CRMActivity "DB", keyed by activity id. */
  activities: Map<string, CRMActivity>;
  /** Idempotency index: one activity per terminal call. */
  activityByCallId: Map<string, CRMActivity>;
}

export function createStore(): Store {
  return {
    leads: new Map(),
    calls: new Map(),
    sessions: new Map(),
    activities: new Map(),
    activityByCallId: new Map(),
  };
}

/** Monotonic, prefix-scoped ids — readable in the UI and stable in tests. */
export class IdGen {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

export const SEED_LEADS: Lead[] = [
  { id: 'lead-1', name: 'Ava Chen', company: 'Northwind Analytics', phone: '+1-415-555-0101', email: 'ava.chen@northwind.io' },
  { id: 'lead-2', name: 'Ben Ortiz', company: 'Cascade Robotics', phone: '+1-415-555-0102', email: 'ben.ortiz@cascaderobotics.com' },
  { id: 'lead-3', name: 'Chloe Park', company: 'Helios Energy', phone: '+1-415-555-0103', email: 'chloe.park@heliosenergy.co' },
  { id: 'lead-4', name: 'Daniel Reyes', company: 'Bluefin Logistics', phone: '+1-415-555-0104', email: 'daniel.reyes@bluefin.io' },
  { id: 'lead-5', name: 'Emma Silva', company: 'Quartz Health', phone: '+1-415-555-0105', email: 'emma.silva@quartzhealth.com' },
  // Seeded with an existing CRM link so the "skip contact creation" path is
  // visible in the demo (matching contact is seeded into the mock CRM).
  { id: 'lead-6', name: 'Farid Khan', company: 'Alpine Software', phone: '+1-415-555-0106', email: 'farid.khan@alpinesw.dev', crmExternalId: 'crm-contact-1000' },
];

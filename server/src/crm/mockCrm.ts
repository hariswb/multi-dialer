/**
 * Mock of the *external* CRM system (spec Part 2). In-memory, async to mimic
 * network I/O, with injectable failure (`failNext`) so FAILED sync paths are
 * demoable and testable. Lives behind the same shape a real CRM client would.
 */

export interface MockCrmContact {
  id: string;
  name: string;
  phone: string;
  email: string;
  company: string;
  createdAt: string;
  updatedAt: string;
}

export interface MockCrmActivity {
  id: string;
  contactId: string;
  type: 'CALL';
  disposition: string;
  notes: string;
  /** Idempotency key supplied by the caller (the dialer's callId). */
  idempotencyKey: string;
  createdAt: string;
}

export type ContactFields = Omit<MockCrmContact, 'id' | 'createdAt' | 'updatedAt'>;
export type ActivityFields = Omit<MockCrmActivity, 'id' | 'createdAt'>;

const defaultLatency = () => new Promise<void>((resolve) => setTimeout(resolve, 50 + Math.random() * 150));

export class MockCrm {
  private contacts = new Map<string, MockCrmContact>();
  private activitiesByKey = new Map<string, MockCrmActivity>();
  private idCounter = 1000;
  /** Number of upcoming requests that should fail (set via POST /sim/crm/failures). */
  failNext = 0;

  constructor(
    private latency: () => Promise<void> = defaultLatency,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private async request(): Promise<void> {
    await this.latency();
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mock CRM unavailable (simulated failure)');
    }
  }

  /** Pre-load a contact (used by seeding for a lead that already has a crmExternalId). */
  seedContact(contact: MockCrmContact): void {
    this.contacts.set(contact.id, contact);
  }

  /** Upsert by email: update the existing contact or create a new one; returns its id. */
  async upsertContact(fields: ContactFields): Promise<{ id: string }> {
    await this.request();
    const existing = [...this.contacts.values()].find((c) => c.email === fields.email);
    if (existing) {
      Object.assign(existing, fields, { updatedAt: this.now() });
      return { id: existing.id };
    }
    const contact: MockCrmContact = {
      id: `crm-contact-${++this.idCounter}`,
      ...fields,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.contacts.set(contact.id, contact);
    return { id: contact.id };
  }

  /** Idempotent by key: replaying the same terminal call never duplicates the activity. */
  async createActivity(fields: ActivityFields): Promise<MockCrmActivity> {
    await this.request();
    const existing = this.activitiesByKey.get(fields.idempotencyKey);
    if (existing) return existing;
    const activity: MockCrmActivity = {
      id: `crm-act-${++this.idCounter}`,
      ...fields,
      createdAt: this.now(),
    };
    this.activitiesByKey.set(fields.idempotencyKey, activity);
    return activity;
  }

  listContacts(): MockCrmContact[] {
    return [...this.contacts.values()];
  }

  listActivities(): MockCrmActivity[] {
    return [...this.activitiesByKey.values()];
  }
}

import type { EventEmitter } from 'node:events';
import type { CRMActivity, CrmSyncStatus } from '@dialer/shared';
import type { IdGen, Store } from '../store.js';
import type { MockCrm } from './mockCrm.js';

/**
 * CRM sync module (NOTES §3). Consumes `callTerminal` events independently of
 * dialer state.
 *
 * - Exactly-once effect: the callId is reserved *synchronously, before any
 *   await*, so a duplicate event (even one arriving while the first sync's
 *   CRM write is in flight) is a no-op. Activity writes are keyed by callId
 *   in both the app store and the mock CRM.
 * - Per-lead serialization: syncs for the same lead are chained, so two
 *   terminal calls for one lead cannot both see "no crmExternalId" and create
 *   two contacts.
 * - Failure independence: a CRM failure only marks this call's sync FAILED
 *   (and releases the reservation so a redelivered event could retry);
 *   session/call state is never touched.
 */
export class CrmSyncService {
  private statuses = new Map<string, CrmSyncStatus>();
  private reserved = new Set<string>();
  private leadChains = new Map<string, Promise<void>>();

  constructor(
    private store: Store,
    private crm: MockCrm,
    private ids: IdGen,
    emitter: EventEmitter,
    private now: () => string = () => new Date().toISOString(),
  ) {
    emitter.on('callTerminal', (callId: string) => this.handleTerminal(callId));
  }

  statusFor(callId: string): CrmSyncStatus | null {
    return this.statuses.get(callId) ?? null;
  }

  /** Synchronous entry point: reservation happens before any await. */
  handleTerminal(callId: string): Promise<void> {
    if (this.reserved.has(callId)) return Promise.resolve();
    this.reserved.add(callId);
    this.statuses.set(callId, 'PENDING');

    const call = this.store.calls.get(callId);
    if (!call || call.endedAt === null) {
      // Defensive: the emitter contract (one EMIT_TERMINAL per terminal call)
      // makes this unreachable; fail loudly in the status rather than throw.
      this.statuses.set(callId, 'FAILED');
      return Promise.resolve();
    }

    const previous = this.leadChains.get(call.leadId) ?? Promise.resolve();
    const chained = previous.then(() => this.sync(callId, call.leadId));
    // The stored chain must never reject, or one failure would poison every
    // later sync for the lead.
    this.leadChains.set(call.leadId, chained.catch(() => {}));
    return chained;
  }

  private async sync(callId: string, leadId: string): Promise<void> {
    const call = this.store.calls.get(callId)!;
    const lead = this.store.leads.get(leadId)!;
    try {
      if (!lead.crmExternalId) {
        const { id } = await this.crm.upsertContact({
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          company: lead.company,
        });
        lead.crmExternalId = id;
      }
      if (!this.store.activityByCallId.has(callId)) {
        const activity: CRMActivity = {
          id: this.ids.next('act'),
          leadId: lead.id,
          crmExternalId: lead.crmExternalId,
          type: 'CALL',
          callId,
          disposition: call.status,
          notes: `Call ${callId} to ${lead.name} (${lead.phone}) ended ${call.status}; started ${call.startedAt}, ended ${call.endedAt}.`,
          createdAt: this.now(),
        };
        await this.crm.createActivity({
          contactId: lead.crmExternalId,
          type: 'CALL',
          disposition: activity.disposition,
          notes: activity.notes,
          idempotencyKey: callId,
        });
        // App-DB write only after the external write succeeded, so the two
        // stores never diverge; both writes are idempotent by callId.
        this.store.activities.set(activity.id, activity);
        this.store.activityByCallId.set(callId, activity);
      }
      this.statuses.set(callId, 'SYNCED');
    } catch {
      this.statuses.set(callId, 'FAILED');
      this.reserved.delete(callId); // stays retryable on redelivery
    }
  }
}

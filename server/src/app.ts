import { EventEmitter } from 'node:events';
import { CrmSyncService } from './crm/sync.js';
import { MockCrm } from './crm/mockCrm.js';
import { DialerService } from './domain/dialer.js';
import { SimProvider } from './sim/provider.js';
import { createStore, IdGen, SEED_LEADS, type Store } from './store.js';

export interface Services {
  store: Store;
  ids: IdGen;
  emitter: EventEmitter;
  dialer: DialerService;
  provider: SimProvider;
  crm: MockCrm;
  crmSync: CrmSyncService;
}

export interface ServiceOptions {
  seed?: boolean;
  crmLatency?: () => Promise<void>;
  now?: () => string;
  random?: () => number;
}

/** Composition root — also used directly by tests (no HTTP needed). */
export function createServices(opts: ServiceOptions = {}): Services {
  const { seed = true, crmLatency, now = () => new Date().toISOString(), random = Math.random } = opts;

  const store = createStore();
  const ids = new IdGen();
  const emitter = new EventEmitter();
  const crm = new MockCrm(crmLatency, now);
  const dialer = new DialerService(store, ids, emitter, now);
  const provider = new SimProvider((sessionId, event) => dialer.dispatch(sessionId, event), random);
  dialer.provider = provider;
  const crmSync = new CrmSyncService(store, crm, ids, emitter, now);

  if (seed) {
    for (const lead of SEED_LEADS) {
      store.leads.set(lead.id, { ...lead });
      if (lead.crmExternalId) {
        crm.seedContact({
          id: lead.crmExternalId,
          name: lead.name,
          phone: lead.phone,
          email: lead.email,
          company: lead.company,
          createdAt: now(),
          updatedAt: now(),
        });
      }
    }
  }

  return { store, ids, emitter, dialer, provider, crm, crmSync };
}

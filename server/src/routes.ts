import type { FastifyError, FastifyInstance } from 'fastify';
import type { CallView, DialerSession, DialOutcome, SessionView } from '@dialer/shared';
import { DIAL_OUTCOMES } from '@dialer/shared';
import { DomainError } from './domain/dialer.js';
import type { Services } from './app.js';

export function registerRoutes(app: FastifyInstance, services: Services): void {
  const { store, dialer, crm, crmSync } = services;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    const fastifyErr = err as FastifyError;
    if (fastifyErr.validation) {
      return reply.status(400).send({ error: fastifyErr.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error' });
  });

  /* ------------------------------- leads ------------------------------- */

  app.get('/leads', async () => [...store.leads.values()]);

  // Spec endpoint: the app's own view of CRM activities for a lead.
  app.get<{ Params: { id: string } }>('/leads/:id/crm-activities', async (req) => {
    if (!store.leads.has(req.params.id)) throw new DomainError(404, `unknown lead: ${req.params.id}`);
    return [...store.activities.values()].filter((a) => a.leadId === req.params.id);
  });

  /* ------------------------------ sessions ------------------------------ */

  app.post<{ Body: { leadIds: string[]; agentId?: string } }>(
    '/sessions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['leadIds'],
          properties: {
            leadIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
            agentId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const session = dialer.createSession(req.body.leadIds, req.body.agentId);
      return reply.status(201).send(session);
    },
  );

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req): Promise<SessionView> => {
    return sessionView(services, dialer.getSession(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/start', async (req) => {
    dialer.start(req.params.id);
    return sessionView(services, dialer.getSession(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/stop', async (req) => {
    dialer.stop(req.params.id);
    return sessionView(services, dialer.getSession(req.params.id));
  });

  app.post<{ Params: { id: string; callId: string } }>('/sessions/:id/calls/:callId/hangup', async (req) => {
    dialer.hangup(req.params.id, req.params.callId);
    return sessionView(services, dialer.getSession(req.params.id));
  });

  /* ------------------------------ mock CRM ------------------------------ */

  app.get('/mock-crm/contacts', async () => crm.listContacts());
  app.get('/mock-crm/activities', async () => crm.listActivities());

  /* ----------------------------- simulation ----------------------------- */

  // Deterministic override: force a DIALING call's outcome immediately.
  app.post<{ Params: { id: string }; Body: { status: DialOutcome } }>(
    '/sim/calls/:id/outcome',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: [...DIAL_OUTCOMES] } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      dialer.forceOutcome(req.params.id, req.body.status);
      return store.calls.get(req.params.id);
    },
  );

  // Make the next N mock-CRM requests fail (demo/test the FAILED sync path).
  app.post<{ Body: { count: number } }>(
    '/sim/crm/failures',
    {
      schema: {
        body: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'integer', minimum: 0, maximum: 100 } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      crm.failNext = req.body.count;
      return { failNext: crm.failNext };
    },
  );

  app.get('/health', async () => ({ ok: true }));
}

function sessionView(services: Services, session: DialerSession): SessionView {
  const { store, crmSync } = services;
  const calls: CallView[] = [...store.calls.values()]
    .filter((c) => c.sessionId === session.id)
    .map((c) => {
      const lead = store.leads.get(c.leadId)!;
      return { ...c, leadName: lead.name, leadPhone: lead.phone, crmSync: crmSync.statusFor(c.id) };
    });
  const activities = calls.flatMap((c) => store.activityByCallId.get(c.id) ?? []);
  const queue = session.leadQueue.map((id) => ({ id, name: store.leads.get(id)!.name }));
  return { session, calls, activities, queue };
}

import { EventEmitter } from 'node:events';
import type { Call, DialerSession, DialOutcome } from '@dialer/shared';
import { transition, type Effect, type SessionEvent, type TransitionCtx } from './session.js';
import type { IdGen, Store } from '../store.js';

export class DomainError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/** The seam a real telephony provider would sit behind (NOTES §4). */
export interface CallProvider {
  place(call: Call): void;
  scheduleDuration(call: Call): void;
  cancel(callId: string): void;
}

/**
 * Owns dispatching: runs the synchronous state-machine transition, then
 * executes the returned effects (provider timers, `callTerminal` emission).
 */
export class DialerService {
  provider!: CallProvider; // bound once at composition time (mutual reference with the provider)

  constructor(
    private store: Store,
    private ids: IdGen,
    public emitter: EventEmitter,
    private now: () => string = () => new Date().toISOString(),
  ) {}

  private ctx(): TransitionCtx {
    return {
      calls: this.store.calls,
      now: this.now,
      createCall: (session, leadId) => {
        const call: Call = {
          id: this.ids.next('call'),
          leadId,
          sessionId: session.id,
          status: 'DIALING',
          startedAt: this.now(),
          endedAt: null,
          providerCallId: this.ids.next('pvc'),
        };
        this.store.calls.set(call.id, call);
        return call;
      },
    };
  }

  createSession(leadIds: string[], agentId = 'agent-1'): DialerSession {
    const unique = [...new Set(leadIds)];
    if (unique.length === 0) throw new DomainError(400, 'leadIds must contain at least one lead');
    for (const id of unique) {
      if (!this.store.leads.has(id)) throw new DomainError(404, `unknown lead: ${id}`);
    }
    const session: DialerSession = {
      id: this.ids.next('sess'),
      agentId,
      leadQueue: unique,
      concurrency: 2,
      activeCallIds: [],
      winnerCallId: null,
      status: 'CREATED',
      metrics: { attempted: 0, connected: 0, failed: 0, canceled: 0 },
    };
    this.store.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): DialerSession {
    const session = this.store.sessions.get(sessionId);
    if (!session) throw new DomainError(404, `unknown session: ${sessionId}`);
    return session;
  }

  dispatch(sessionId: string, event: SessionEvent): void {
    const session = this.getSession(sessionId);
    const effects = transition(this.ctx(), session, event);
    this.runEffects(effects);
  }

  private runEffects(effects: Effect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'PLACE_CALL':
          this.provider.place(this.store.calls.get(effect.callId)!);
          break;
        case 'CANCEL_PROVIDER':
          this.provider.cancel(effect.callId);
          break;
        case 'EMIT_TERMINAL':
          this.emitter.emit('callTerminal', effect.callId);
          break;
      }
    }
  }

  start(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.status !== 'CREATED') throw new DomainError(409, `session is ${session.status}, cannot start`);
    this.dispatch(sessionId, { type: 'START' });
  }

  stop(sessionId: string): void {
    this.dispatch(sessionId, { type: 'STOP' });
  }

  /** Agent hangs up the live CONNECTED call from the UI. */
  hangup(sessionId: string, callId: string): void {
    const call = this.store.calls.get(callId);
    if (!call || call.sessionId !== sessionId) throw new DomainError(404, `unknown call: ${callId}`);
    if (call.status !== 'CONNECTED' || call.endedAt !== null) {
      throw new DomainError(409, `call is ${call.status}${call.endedAt ? ' (ended)' : ''}, cannot hang up`);
    }
    this.dispatch(sessionId, { type: 'CALL_ENDED', callId });
  }

  /** Deterministic override (NOTES §4): force a DIALING call's outcome now. */
  forceOutcome(callId: string, status: DialOutcome): void {
    const call = this.store.calls.get(callId);
    if (!call) throw new DomainError(404, `unknown call: ${callId}`);
    if (call.status !== 'DIALING') throw new DomainError(409, `call is ${call.status}, outcome can only be forced while DIALING`);
    this.provider.cancel(callId);
    if (status === 'CONNECTED') {
      this.dispatch(call.sessionId, { type: 'CALL_CONNECTED', callId });
      // Lost a concurrent-connect race inside the transition? Then it was
      // canceled and gets no duration timer.
      const after = this.store.calls.get(callId)!;
      if (after.status === 'CONNECTED') this.provider.scheduleDuration(after);
    } else {
      this.dispatch(call.sessionId, { type: 'CALL_OUTCOME', callId, status });
    }
  }
}

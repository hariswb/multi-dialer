import type { Call, DialerSession, FailureOutcome } from '@dialer/shared';

/**
 * Session state machine (NOTES.md §2).
 *
 * Every state change flows through `transition(ctx, session, event)`. The
 * function is fully synchronous — NO `await` anywhere — so each event runs
 * start-to-finish against consistent state on the event loop; interleaved
 * read-modify-write races are impossible by construction. Side effects
 * (provider timers, terminal-event emission) are *returned* as data and
 * dispatched by the caller after the mutation completes.
 */

export type SessionEvent =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'CALL_CONNECTED'; callId: string }
  | { type: 'CALL_OUTCOME'; callId: string; status: FailureOutcome }
  /** A CONNECTED call ended: agent hangup or simulated duration elapsed. */
  | { type: 'CALL_ENDED'; callId: string };

export type Effect =
  | { type: 'PLACE_CALL'; callId: string }
  | { type: 'CANCEL_PROVIDER'; callId: string }
  /** Exactly one per call, from its single terminal transition. CRM sync consumes this. */
  | { type: 'EMIT_TERMINAL'; callId: string };

export interface TransitionCtx {
  calls: Map<string, Call>;
  /** Creates and stores a DIALING call for the lead; id/providerCallId assigned by the store layer. */
  createCall(session: DialerSession, leadId: string): Call;
  now(): string;
}

export class InvariantViolation extends Error {}

export function transition(ctx: TransitionCtx, session: DialerSession, event: SessionEvent): Effect[] {
  const effects: Effect[] = [];

  // Invariant 5: STOPPED sessions accept no further transitions.
  if (session.status === 'STOPPED') return effects;

  switch (event.type) {
    case 'START': {
      if (session.status !== 'CREATED') break;
      session.status = 'RUNNING';
      refill(ctx, session, effects);
      break;
    }

    case 'STOP': {
      for (const callId of [...session.activeCallIds]) {
        cancelCall(ctx, session, callId, effects);
      }
      session.status = 'STOPPED';
      break;
    }

    case 'CALL_CONNECTED': {
      const call = activeCall(ctx, session, event.callId);
      if (!call || call.status !== 'DIALING') break;
      if (liveConnectedCall(ctx, session)) {
        // Concurrent-connect race: the first CONNECTED event processed won;
        // this line loses and is canceled — exactly one winner (invariant 2).
        cancelCall(ctx, session, call.id, effects);
        break;
      }
      call.status = 'CONNECTED';
      session.winnerCallId = call.id; // reflects the most recent connected call
      session.metrics.connected += 1;
      // Power-dialer semantics (NOTES §1): the agent is now on the phone, so
      // the other in-flight line is terminated and no new dialing starts.
      for (const otherId of [...session.activeCallIds]) {
        if (otherId !== call.id) cancelCall(ctx, session, otherId, effects);
      }
      break;
    }

    case 'CALL_OUTCOME': {
      const call = activeCall(ctx, session, event.callId);
      if (!call || call.status !== 'DIALING') break;
      call.status = event.status;
      call.endedAt = ctx.now();
      removeActive(session, call.id);
      session.metrics.failed += 1;
      effects.push({ type: 'CANCEL_PROVIDER', callId: call.id }, { type: 'EMIT_TERMINAL', callId: call.id });
      // Invariant 3: refill only on a terminal transition, never while a
      // CONNECTED call is live (the concurrency budget is held for the agent).
      if (!liveConnectedCall(ctx, session)) refill(ctx, session, effects);
      stopIfDrained(session);
      break;
    }

    case 'CALL_ENDED': {
      const call = activeCall(ctx, session, event.callId);
      if (!call || call.status !== 'CONNECTED') break;
      call.endedAt = ctx.now(); // terminal; status stays CONNECTED per spec's status list
      removeActive(session, call.id);
      effects.push({ type: 'CANCEL_PROVIDER', callId: call.id }, { type: 'EMIT_TERMINAL', callId: call.id });
      refill(ctx, session, effects); // dialing resumes, up to 2 lines
      stopIfDrained(session);
      break;
    }
  }

  assertInvariants(ctx, session);
  return effects;
}

/* ------------------------------- helpers ------------------------------- */

function activeCall(ctx: TransitionCtx, session: DialerSession, callId: string): Call | undefined {
  if (!session.activeCallIds.includes(callId)) return undefined;
  return ctx.calls.get(callId);
}

function liveConnectedCall(ctx: TransitionCtx, session: DialerSession): Call | undefined {
  return session.activeCallIds
    .map((id) => ctx.calls.get(id))
    .find((c) => c !== undefined && c.status === 'CONNECTED');
}

function removeActive(session: DialerSession, callId: string): void {
  session.activeCallIds = session.activeCallIds.filter((id) => id !== callId);
}

/** Terminal transition to CANCELED_BY_DIALER (lost race, held budget, or agent Stop). */
function cancelCall(ctx: TransitionCtx, session: DialerSession, callId: string, effects: Effect[]): void {
  const call = ctx.calls.get(callId);
  if (!call || call.endedAt !== null) return;
  call.status = 'CANCELED_BY_DIALER';
  call.endedAt = ctx.now();
  removeActive(session, callId);
  session.metrics.canceled += 1;
  effects.push({ type: 'CANCEL_PROVIDER', callId }, { type: 'EMIT_TERMINAL', callId });
}

function refill(ctx: TransitionCtx, session: DialerSession, effects: Effect[]): void {
  while (session.activeCallIds.length < session.concurrency && session.leadQueue.length > 0) {
    const leadId = session.leadQueue.shift()!;
    const call = ctx.createCall(session, leadId);
    session.activeCallIds.push(call.id);
    session.metrics.attempted += 1;
    effects.push({ type: 'PLACE_CALL', callId: call.id });
  }
}

function stopIfDrained(session: DialerSession): void {
  if (session.status === 'RUNNING' && session.activeCallIds.length === 0 && session.leadQueue.length === 0) {
    session.status = 'STOPPED';
  }
}

/** NOTES §2 invariants, asserted after every transition. */
function assertInvariants(ctx: TransitionCtx, session: DialerSession): void {
  if (session.activeCallIds.length > session.concurrency) {
    throw new InvariantViolation(`session ${session.id}: ${session.activeCallIds.length} active lines (max ${session.concurrency})`);
  }
  const active = session.activeCallIds.map((id) => {
    const call = ctx.calls.get(id);
    if (!call) throw new InvariantViolation(`session ${session.id}: active call ${id} does not exist`);
    return call;
  });
  if (active.some((c) => c.endedAt !== null)) {
    throw new InvariantViolation(`session ${session.id}: terminal call still listed as active`);
  }
  if (active.filter((c) => c.status === 'CONNECTED').length > 1) {
    throw new InvariantViolation(`session ${session.id}: more than one CONNECTED call`);
  }
  if (session.status === 'STOPPED' && session.activeCallIds.length > 0) {
    throw new InvariantViolation(`session ${session.id}: STOPPED with active calls`);
  }
}

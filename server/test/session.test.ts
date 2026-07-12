import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { createServices, type Services } from '../src/app.js';

/**
 * State-machine tests (NOTES §5.1). Driven through the real DialerService +
 * SimProvider with fake timers: random provider timers are frozen, outcomes
 * are forced deterministically via forceOutcome / direct dispatch.
 */

let s: Services;

beforeEach(() => {
  vi.useFakeTimers();
  s = createServices({ crmLatency: () => Promise.resolve() });
});

afterEach(() => {
  vi.useRealTimers();
});

function startSession(leadIds: string[]) {
  const session = s.dialer.createSession(leadIds);
  s.dialer.start(session.id);
  return session;
}

describe('dialing and concurrency', () => {
  it('start dials up to 2 lines from the queue', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3']);
    expect(session.status).toBe('RUNNING');
    expect(session.activeCallIds).toHaveLength(2);
    expect(session.leadQueue).toEqual(['lead-3']);
    expect(session.metrics.attempted).toBe(2);
  });

  it('a failed line is refilled from the queue, keeping <= 2 active', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3']);
    const [first] = session.activeCallIds;
    s.dialer.forceOutcome(first!, 'NO_ANSWER');
    expect(session.activeCallIds).toHaveLength(2);
    expect(session.leadQueue).toEqual([]);
    expect(session.metrics.attempted).toBe(3);
    expect(session.metrics.failed).toBe(1);
  });
});

describe('winner semantics (power dialer)', () => {
  it('first CONNECTED becomes winner and the other line is canceled', () => {
    const session = startSession(['lead-1', 'lead-2']);
    const [c1, c2] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'CONNECTED');

    expect(session.winnerCallId).toBe(c1);
    expect(s.store.calls.get(c1!)!.status).toBe('CONNECTED');
    expect(s.store.calls.get(c2!)!.status).toBe('CANCELED_BY_DIALER');
    expect(s.store.calls.get(c2!)!.endedAt).not.toBeNull();
    expect(session.activeCallIds).toEqual([c1]);
    expect(session.metrics).toMatchObject({ connected: 1, canceled: 1 });
  });

  it('simultaneous connects resolve to exactly one winner', () => {
    const session = startSession(['lead-1', 'lead-2']);
    const [c1, c2] = session.activeCallIds;
    // Two CONNECTED events already queued for the same instant: the first
    // processed wins; the second finds its call no longer DIALING.
    s.dialer.dispatch(session.id, { type: 'CALL_CONNECTED', callId: c1! });
    s.dialer.dispatch(session.id, { type: 'CALL_CONNECTED', callId: c2! });

    expect(session.winnerCallId).toBe(c1);
    expect(s.store.calls.get(c2!)!.status).toBe('CANCELED_BY_DIALER');
    expect(session.metrics.connected).toBe(1);
  });

  it('no new dialing while a call is connected; refill resumes after hangup', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3', 'lead-4']);
    const [c1] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'CONNECTED');

    // Budget held: one line canceled, nothing new dialed despite queue depth.
    expect(session.activeCallIds).toEqual([c1]);
    expect(session.leadQueue).toEqual(['lead-3', 'lead-4']);

    s.dialer.hangup(session.id, c1!);

    // Terminal for the connected call keeps status CONNECTED, sets endedAt.
    expect(s.store.calls.get(c1!)!.status).toBe('CONNECTED');
    expect(s.store.calls.get(c1!)!.endedAt).not.toBeNull();
    // Dialing resumed with 2 fresh lines.
    expect(session.activeCallIds).toHaveLength(2);
    expect(session.leadQueue).toEqual([]);
    expect(session.winnerCallId).toBe(c1); // most recent connected call
  });

  it('a new connect after refill moves winnerCallId to the latest connected call', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3']);
    const [c1] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'CONNECTED');
    s.dialer.hangup(session.id, c1!);
    const [c3] = session.activeCallIds;
    s.dialer.forceOutcome(c3!, 'CONNECTED');
    expect(session.winnerCallId).toBe(c3);
  });
});

describe('stop and drain', () => {
  it('stop cancels all active calls and blocks further transitions', () => {
    const session = startSession(['lead-1', 'lead-2']);
    const [c1, c2] = session.activeCallIds;
    s.dialer.stop(session.id);

    expect(session.status).toBe('STOPPED');
    expect(session.activeCallIds).toEqual([]);
    expect(s.store.calls.get(c1!)!.status).toBe('CANCELED_BY_DIALER');
    expect(s.store.calls.get(c2!)!.status).toBe('CANCELED_BY_DIALER');
    expect(session.metrics.canceled).toBe(2);

    // STOPPED accepts no further transitions.
    s.dialer.dispatch(session.id, { type: 'CALL_CONNECTED', callId: c1! });
    expect(session.winnerCallId).toBeNull();
    expect(session.metrics.connected).toBe(0);
  });

  it('queue exhaustion stops the session', () => {
    const session = startSession(['lead-1', 'lead-2']);
    const [c1, c2] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'BUSY');
    expect(session.status).toBe('RUNNING'); // one line still live
    s.dialer.forceOutcome(c2!, 'VOICEMAIL');
    expect(session.status).toBe('STOPPED');
    expect(session.activeCallIds).toEqual([]);
  });

  it('metrics tally per outcome across a full session', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3']);
    const [c1, c2] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'NO_ANSWER'); // failed, refills lead-3 as c3
    const c3 = session.activeCallIds.find((id) => id !== c2)!;
    s.dialer.forceOutcome(c3, 'CONNECTED'); // connected; c2 canceled
    s.dialer.hangup(session.id, c3);

    expect(session.status).toBe('STOPPED');
    expect(session.metrics).toEqual({ attempted: 3, connected: 1, failed: 1, canceled: 1 });
  });

  it('every call reaches exactly one terminal state (none dangling)', () => {
    const session = startSession(['lead-1', 'lead-2', 'lead-3', 'lead-4']);
    const [c1] = session.activeCallIds;
    s.dialer.forceOutcome(c1!, 'CONNECTED');
    s.dialer.hangup(session.id, c1!);
    s.dialer.stop(session.id);

    const calls = [...s.store.calls.values()].filter((c) => c.sessionId === session.id);
    expect(calls.length).toBe(session.metrics.attempted);
    for (const call of calls) {
      expect(call.endedAt, `call ${call.id} left dangling`).not.toBeNull();
    }
  });
});

describe('simulated provider timers', () => {
  it('timer-driven outcomes advance the session without manual forcing', () => {
    // Deterministic "random": always picks the first weighted bucket boundary
    // low enough to CONNECT, and short delays.
    s = createServices({ crmLatency: () => Promise.resolve(), random: () => 0.1 });
    const session = startSession(['lead-1', 'lead-2']);
    vi.advanceTimersByTime(10000); // outcome timers (2-8s) fire → one CONNECTED wins
    expect(session.winnerCallId).not.toBeNull();
    vi.advanceTimersByTime(20000); // duration timer ends the call, queue drained
    expect(session.status).toBe('STOPPED');
  });
});

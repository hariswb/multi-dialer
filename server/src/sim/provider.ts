import type { Call, FailureOutcome } from '@dialer/shared';
import type { CallProvider } from '../domain/dialer.js';
import type { SessionEvent } from '../domain/session.js';

/**
 * Simulated telephony provider (NOTES §4). Placing a call schedules a random
 * outcome after 2–8s, weighted: CONNECTED 40%, NO_ANSWER 30%, BUSY 15%,
 * VOICEMAIL 15%. A CONNECTED call additionally gets a simulated duration
 * (5–15s) after which it ends unless the agent hangs up first.
 */

const OUTCOME_WEIGHTS: Array<['CONNECTED' | FailureOutcome, number]> = [
  ['CONNECTED', 0.4],
  ['NO_ANSWER', 0.3],
  ['BUSY', 0.15],
  ['VOICEMAIL', 0.15],
];

function pickOutcome(random: () => number): 'CONNECTED' | FailureOutcome {
  let roll = random();
  for (const [status, weight] of OUTCOME_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return status;
  }
  return 'VOICEMAIL';
}

export class SimProvider implements CallProvider {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private dispatch: (sessionId: string, event: SessionEvent) => void,
    private random: () => number = Math.random,
  ) {}

  place(call: Call): void {
    const delayMs = 2000 + this.random() * 6000;
    const timer = setTimeout(() => {
      this.timers.delete(call.id);
      const outcome = pickOutcome(this.random);
      if (outcome === 'CONNECTED') {
        this.dispatch(call.sessionId, { type: 'CALL_CONNECTED', callId: call.id });
        // `call` is the live store object; the transition mutated it. Only a
        // call that actually won the line gets a duration timer.
        if (call.status === 'CONNECTED') this.scheduleDuration(call);
      } else {
        this.dispatch(call.sessionId, { type: 'CALL_OUTCOME', callId: call.id, status: outcome });
      }
    }, delayMs);
    this.timers.set(call.id, timer);
  }

  scheduleDuration(call: Call): void {
    const durationMs = 5000 + this.random() * 10000;
    const timer = setTimeout(() => {
      this.timers.delete(call.id);
      this.dispatch(call.sessionId, { type: 'CALL_ENDED', callId: call.id });
    }, durationMs);
    this.timers.set(call.id, timer);
  }

  cancel(callId: string): void {
    const timer = this.timers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(callId);
    }
  }
}

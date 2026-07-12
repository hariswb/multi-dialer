# NOTES.md

Design decisions, made before implementation. Where the spec is ambiguous, the chosen interpretation is stated with its tradeoff. Sections are ordered by correctness-criticality of the dialing/CRM-sync path.

**System in one paragraph:** a single Node process owns all state in memory. Every dialer event (connect, terminal outcome, hangup, stop) flows through one synchronous state-machine transition that mutates session state atomically and emits side effects afterward; a terminal transition emits exactly one event, which the CRM sync module consumes idempotently (keyed by `callId`) and independently of dialer state. The telephony provider is simulated behind the same event seam a real one would use.

**Central tradeoff:** correctness is bought with the single process. Race-freedom comes from the event loop instead of locks, exactly-once CRM sync from an in-memory reservation instead of an outbox, delivery from an in-process emitter instead of a queue. This makes the core logic provably consistent and testable as pure functions — but no guarantee survives a restart or a second replica. Accepted for this scope (spec allows in-memory; one agent drives one session); the exits are in "What I'd do next".

In implementation see [server/README.md](server/README.md).

## 1. Winner semantics

Spec signals: `winnerCallId` (nullable, singular) + `CANCELED_BY_DIALER` status + "Show winner call (if connected)".

**Chosen interpretation:** power-dialer behavior.

- Both lines dial in parallel from the lead queue.
- First call to reach CONNECTED becomes `winnerCallId`; the other in-flight call is immediately terminated as `CANCELED_BY_DIALER`.
- While a connected call is live, **no new dialing starts** (the agent is on the phone; concurrency budget is intentionally held).
- When the connected call ends (agent hangs up via UI, or sim outcome), dialing **resumes** with up to 2 lines from the remaining queue. `winnerCallId` reflects the most recent connected call.
- Session → STOPPED when the queue is empty and no calls are active, or when the agent presses Stop (active calls → CANCELED_BY_DIALER).

Alternative considered and rejected: one winner per session, then stop dialing.

## 2. Session state machine

The problem: concurrent events race against shared session state. Terminal outcomes, connects, hangups, and stop commands arrive from independent sources (timers, HTTP requests) at unpredictable times — including simultaneously. If one handler's read-modify-write interleaves with another's, invariants break (e.g. three active lines). Node being single-threaded doesn't prevent this: any `await` inside a handler is a yield point where another event runs against half-updated state.

Decision: every state change goes through one reducer-style `transition(state, event) → effects` function in `server/src/domain/session.ts`, containing **no `await`**. Side effects (schedule/cancel timers, emit terminal events) are returned and dispatched after the mutation completes. Each event therefore runs start-to-finish against consistent state; the races are impossible by construction, not merely unlikely.

Invariants enforced by the transition function (asserted in code, covered by tests):
- `activeCallIds.length <= 2` at all times.
- At most one CONNECTED call at any time; the concurrent-connect race resolves to exactly one winner, the other → CANCELED_BY_DIALER.
- Queue refill happens only on a terminal transition, and only while no CONNECTED call is live.
- Every call reaches exactly one terminal state — no call is left dangling, none terminates twice.
- STOPPED sessions accept no further transitions.

Tradeoff: atomicity holds only within one process (see intro); the scaling path is state in a DB with locking, then per-session sharding only if lock contention appears.

## 3. CRM sync

The general problem: a state change in one system (dialer) must be reliably reflected in a system it doesn't control (CRM).

Flow per spec: on terminal call → upsert contact if lead lacks `crmExternalId` → create activity (disposition = status) in both the app's `CRMActivity` store and the mock CRM. A call is terminal when `endedAt` is set — for a CONNECTED call that's when it ends (hangup or duration timer), not when it connects.

**1. Delivery — every terminal call must trigger a sync.**
The state machine emits `callTerminal` from its single terminal transition; the CRM module subscribes. One emission point + the "exactly one terminal state per call" invariant (§2) means no event is skipped or double-fired at the source.

**2. Exactly-once effect — retries and races must not create duplicate records.**
Delivery can't be trusted to be exactly-once, so the *effect* is made idempotent: activity writes are keyed by `callId`, reserved **before** the async CRM write; contact upserts are protected by serializing sync per `leadId`.

**3. Failure independence — a failing CRM must not corrupt the dialer.**
A failed write only marks that call's sync status (`PENDING | SYNCED | FAILED`, shown in UI); session and call state are untouched, and the record stays retryable.

Scope decision: CANCELED_BY_DIALER also syncs — spec says "terminal outcome", no exclusions. Tradeoff: real CRMs often skip canceled attempts; one-line filter to change.

## 4. Call simulation

The spec includes `providerCallId` but no provider, so the provider is simulated:

1. **Timer-based outcomes (default):** placing a call schedules an outcome after a random 2–8s delay, weighted (CONNECTED 40%, NO_ANSWER 30%, BUSY 15%, VOICEMAIL 15%). A CONNECTED call additionally schedules a simulated call duration, after which it ends (unless the agent hangs up first).
2. **Deterministic override:** `POST /sim/calls/:id/outcome { status }` forces an outcome immediately, cancelling pending timers.

Timers keep the live demo realistic; the override endpoint makes the winner path, idempotency, and edge cases reproducible on demand and unit-testable without flaky sleeps. Tests inject a fake clock.

## 5. Testing

In priority order, targeting the risky logic rather than coverage numbers:

1. **State machine:** first CONNECTED sets winner and cancels the other line; simultaneous connects resolve to one winner; no dialing while connected; refill after hangup respects concurrency 2; stop cancels active calls; queue exhaustion → STOPPED; metrics increment correctly per outcome.
2. **Idempotency:** duplicate `callTerminal` → exactly one activity; **concurrent** duplicate (second event during the first's in-flight CRM write) → exactly one activity; two same-lead syncs → exactly one contact (per-lead serialization).
3. **CRM sync:** contact created when `crmExternalId` missing and id persisted to lead; existing id skips contact creation; activity written to both stores; CRM failure marks sync FAILED without breaking the session.

UI tests are skipped.

## 6. What I'd do next

Scoped to where the single-process design (Central tradeoff, intro) stops holding:

**Multiple agents, multiple sessions.** One process's in-memory state is what makes `transition()` race-free (§2). Many concurrent agents means many processes, which reopens that race. Move state to a datastore with per-session locking/CAS, shard by `sessionId` (one session is always one agent's, so the shard key is free), keep `transition()` pure.

**A stuck or dead dialer replica.** Today a stuck transition just freezes one process (server/README). With replicas, that's not acceptable — it needs a lease/heartbeat per session so a health check can detect a dead or hung owner, kill it, and hand the session to another replica. Retries bounded (fixed attempts, then surface `FAILED` to a human) rather than open-ended.

**Real CRM + real lead enrichment.** The mock CRM never times out or rate-limits. Replace the in-memory idempotency reservation (§3) with a durable outbox so a crash can't lose an unsynced activity, add a real timeout + bounded retry around the CRM call, and treat enrichment as the same kind of idempotent, retryable effect — not a special case.

## 7. AI tool usage + what I verified

**Design, before any code.** Worked through the ambiguous parts of the spec (winner semantics, where transitions should live, whether CRM sync can be coupled into the transition, how refill triggers) with Claude, weighing alternatives against this spec's constraints before picking one. That's what produced this file's "chosen interpretation / rejected alternative / tradeoff" format.

**Implementation.** One-shotted from this NOTES.md plus the assessment brief using Claude Code (Fable model) — single pass, no iterative patching of the core domain logic.

**Verified by hand, after generation:**
- Traced `transition()` (`session.ts`) and `dispatch()`/`runEffects()` (`dialer.ts`) against each §2 invariant directly in the code, not just the tests.
- `npm test`: 20 tests, 3 files, passing. `npm run typecheck`: clean on server + client.
- Read `crm/sync.ts` to confirm the idempotency reservation happens before the `await`, and that per-lead chaining actually serializes.
- Ran the demo by hand: forced a simultaneous-connect race via `/sim/calls/:id/outcome` → one winner, one `CANCELED_BY_DIALER`; hung up → refill; forced a CRM failure via `/sim/crm/failures` → session stayed healthy, call showed `FAILED`.
- Wrote `server/README.md` while confirming each claim in it against the code.

**Not verified:** load beyond the spec's 2-line/single-session scale; behavior across an actual process restart.

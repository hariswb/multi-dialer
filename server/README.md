# Server architecture

How the modules fit together, and the concurrency model that makes the state
machine in [`NOTES.md`](../NOTES.md) safe without locks. See root
[README.md](../README.md) for run/API instructions.

## Module diagram

```
HTTP (routes.ts)
   │  POST /sessions, /start, /stop, /hangup
   ▼
DialerService (domain/dialer.ts)
   │  dispatch(sessionId, event)
   ▼
transition() (domain/session.ts)     ← pure, sync, no await
   │  mutates session/calls
   │  returns Effect[]
   ▼
runEffects() (domain/dialer.ts)
   ├─ PLACE_CALL ──────► SimProvider.place()  (sim/provider.ts)
   │                          │ setTimeout(2-8s)
   │                          ▼
   │                     dispatch(CALL_CONNECTED | CALL_OUTCOME) ──┐
   │                                                                │
   ├─ CANCEL_PROVIDER ──► SimProvider.cancel()                     │
   │                                                                │
   └─ EMIT_TERMINAL ────► emitter.emit('callTerminal')             │
                                │                                   │
                                ▼                                   │
                      CrmSyncService (crm/sync.ts)                  │
                          │ reserve callId, chain per lead           │
                          ▼                                         │
                      MockCrm (crm/mockCrm.ts)                      │
                                                                     │
   ◄─────────────────────────────────────────────────────────────────┘
   (loops back into dispatch → transition, same cycle)

Store (store.ts): Maps for leads / calls / sessions / activities
   — shared by DialerService and CrmSyncService, no locks needed
     (single-threaded event loop, sync transitions)
```

Everything cycles through `dispatch → transition → effects → provider timer →
dispatch`; that loop is the dialer. `CrmSyncService` is wired in only via the
shared `EventEmitter` (`app.ts`) — dialer code never calls it directly.

## Why there's no worker pool

There's no thread, process, or worker per call — just one `setTimeout` per
active call, all running on Node's single-threaded **event loop**. The event
loop runs one callback at a time to completion before picking up the next;
nothing preempts it mid-callback. `transition()` relies on exactly this: as
long as it contains no `await`, an event (connect, terminal outcome, hangup,
stop) runs start-to-finish against consistent state, so races are impossible
by construction rather than merely unlikely (`NOTES.md` §2).

A call's identity is carried by closures, not shared mutable workers: each
`setTimeout` callback in `SimProvider.place()` closes over the specific
`call` object it was given, and timers are keyed by `callId` in
`SimProvider.timers` so `cancel()` clears the right one. When a timer fires,
`transition()` re-validates the call against current store state before
acting, so a stale/late timer can't corrupt a call that was already canceled.

## Tradeoffs (expands on NOTES.md's "Central tradeoff")

**1. `refill()`'s loop only terminates because the queue strictly shrinks.**
`refill()` (`session.ts`) is a `while (activeCallIds.length < concurrency &&
leadQueue.length > 0)` loop that calls `leadQueue.shift()` every iteration.
Correctness depends on nothing ever re-pushing to `leadQueue` inside that
loop. There's no other bound (no iteration cap, no timeout).

**2. A stuck *synchronous* transition freezes the entire process.**
Because Node is single-threaded, an infinite loop or heavy CPU-bound bug
inside `transition()` blocks the event loop completely — not just one
session, every session, every HTTP request, every timer, until it returns.
This is the direct cost of buying race-freedom from the event loop instead
of locks: it only holds if every transition provably terminates quickly.

**3. A stuck *asynchronous* CRM sync jams one lead, not the system.**
In `CrmSyncService.handleTerminal()` (`crm/sync.ts`), syncs for one lead are
chained: `leadChains.set(leadId, chained.catch(() => {}))`. That `.catch()`
only handles *rejection* — if the awaited CRM call inside `sync()` never
resolves (no timeout anywhere in this codebase), that lead's chain hangs
forever and no later terminal call for the *same* lead can ever sync again.
Other leads are unaffected (independent chains), and the dialer itself is
unaffected too, since CRM sync is decoupled via the event emitter and never
blocks call placement.

Accepted for this scope alongside the rest of the in-memory design (see
`NOTES.md`'s "Central tradeoff"); a production version would add a
per-transition/per-sync timeout and a bounded retry rather than an
open-ended `await`.

# Multi-Line Dialer + Mock CRM Sync

Take-home for AI Sales Doctor (advanced track): an agent runs a **2-line dialer session** over a list of leads; every call that reaches a terminal outcome writes a **CRM activity record** (app DB + mock CRM), exactly once.

Design decisions and tradeoffs are in [NOTES.md](NOTES.md).

## How it works

An agent selects leads and starts a session; the dialer places up to 2 calls in parallel from the lead queue. The first call to connect becomes the session's winner and the other line is canceled — while the agent is on the call, no new dialing starts. Every call that reaches a terminal outcome (connected-and-ended, no answer, busy, voicemail, or canceled) writes exactly one CRM activity, synced to both the app DB and a mock external CRM.

All of this is driven by one synchronous state machine so concurrent events (simultaneous connects, hangups, stop) can't corrupt session state — see [server/README.md](server/README.md) for how that's structured and why.

## Stack

- **Server** — Node.js, Fastify, TypeScript. All state in memory, seeded on boot. Telephony is simulated behind a provider seam.
- **Client** — React, Vite, TypeScript. Polls the session endpoint every 1.5s.
- **Shared** — one workspace package with the domain types, imported by both sides.
- **Tests** — Vitest (state machine, CRM idempotency, CRM sync behavior).

## Run it

Requires Node.js ≥ 20.

```bash
npm install
npm run dev        # server on :3001, client on :5173 (proxies API calls)
```

Open http://localhost:5173.

Production (single process, single origin — what a Render/Railway free tier runs):

```bash
npm run build      # typecheck server + build client bundle
npm start          # serves API + built client on :3001 (PORT env respected)
```

Tests:

```bash
npm test
```

## Demo walkthrough

1. **Leads screen** — select a few leads (lead-6 is pre-linked to a CRM contact, so it skips contact creation on sync) → **Create Dialer Session**.
2. **Session screen** — press **Start**. Two lines dial in parallel; outcomes arrive on their own after 2–8s, or force one instantly with the buttons on a dialing card.
3. First call to connect becomes the **winner** 🏆; the other line is canceled (`CANCELED_BY_DIALER`) and no new dialing starts while the agent is on the call.
4. **Hang up** (or let the simulated duration end the call) — dialing resumes with up to 2 lines from the queue.
5. Watch the **Calls & CRM sync** table: every terminal call gets a CRM activity, `SYNCED` exactly once. Use *Simulation controls → Make next CRM request fail* to see a `FAILED` sync that doesn't disturb the session.
6. Inspect the "external" CRM directly: [/mock-crm/contacts](http://localhost:3001/mock-crm/contacts), [/mock-crm/activities](http://localhost:3001/mock-crm/activities).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/leads` | Seeded leads |
| GET | `/leads/:id/crm-activities` | App's view of a lead's CRM activities |
| POST | `/sessions` | Create session — body `{ "leadIds": ["lead-1", ...] }` |
| GET | `/sessions/:id` | Full session view (session, calls, sync status, activities) — the polling endpoint |
| POST | `/sessions/:id/start` | Start dialing (2 lines) |
| POST | `/sessions/:id/stop` | Stop; active calls → `CANCELED_BY_DIALER` |
| POST | `/sessions/:id/calls/:callId/hangup` | Agent hangs up the connected call |
| GET | `/mock-crm/contacts` | Mock (external) CRM contacts |
| GET | `/mock-crm/activities` | Mock (external) CRM activities |
| POST | `/sim/calls/:id/outcome` | Force a dialing call's outcome — body `{ "status": "CONNECTED" \| "NO_ANSWER" \| "BUSY" \| "VOICEMAIL" }` |
| POST | `/sim/crm/failures` | Make the next N mock-CRM requests fail — body `{ "count": 1 }` |
| GET | `/health` | Liveness |

## Layout

```
shared/   domain types (Lead, Call, DialerSession, CRMActivity, view models)
server/
  src/domain/session.ts   the state machine: transition(state, event) → effects, no await
  src/domain/dialer.ts    dispatch + effect execution, session commands
  src/sim/provider.ts     simulated telephony provider (weighted outcomes, timers)
  src/crm/mockCrm.ts      the "external" CRM (in-memory, injectable failures)
  src/crm/sync.ts         terminal-event consumer: idempotent, per-lead serialized
  test/                   state machine · idempotency · CRM sync suites
client/   React app: LeadsScreen (screen 1) + SessionScreen (screen 2, polling)
```

import { useCallback, useEffect, useState } from 'react';
import type { CallView, DialOutcome, SessionView } from '@dialer/shared';
import { DIAL_OUTCOMES } from '@dialer/shared';
import { api } from './api';

const POLL_MS = 1500;

/** Screen 2: two live lines, metrics, winner, CRM sync status — polled. */
export function SessionScreen({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await api.session(sessionId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  if (!view) return <p className="muted">{error ?? 'Loading session…'}</p>;

  const { session, calls, activities, queue } = view;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const activeCalls = session.activeCallIds.map((id) => byId.get(id)).filter((c): c is CallView => Boolean(c));
  const lines: Array<CallView | null> = [activeCalls[0] ?? null, activeCalls[1] ?? null];
  const winner = session.winnerCallId ? byId.get(session.winnerCallId) : undefined;
  const sortedCalls = [...calls].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  return (
    <section>
      <div className="toolbar">
        <h2>
          Session <span className="mono">{session.id}</span> <StatusBadge status={session.status} />
        </h2>
        <div className="actions">
          {session.status === 'CREATED' && (
            <button className="primary" onClick={() => act(() => api.start(session.id))}>
              Start
            </button>
          )}
          {session.status === 'RUNNING' && (
            <button className="danger" onClick={() => act(() => api.stop(session.id))}>
              Stop
            </button>
          )}
          <button onClick={onBack}>← Leads</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="metrics">
        <Metric label="Attempted" value={session.metrics.attempted} />
        <Metric label="Connected" value={session.metrics.connected} />
        <Metric label="Failed" value={session.metrics.failed} />
        <Metric label="Canceled" value={session.metrics.canceled} />
        <Metric label="In queue" value={session.leadQueue.length} />
      </div>

      <div className="winner">
        {winner ? (
          <>
            🏆 Winner: <strong>{winner.leadName}</strong> <span className="mono">({winner.leadPhone})</span>{' '}
            {winner.endedAt === null ? <span className="badge connected">LIVE</span> : <span className="muted">ended</span>}
          </>
        ) : (
          <span className="muted">No winner yet — first call to connect wins the line.</span>
        )}
      </div>

      <div className="lines">
        {lines.map((call, i) => (
          <LineCard key={call?.id ?? `idle-${i}`} n={i + 1} call={call} sessionStatus={session.status} act={act} sessionId={session.id} />
        ))}
      </div>

      {queue.length > 0 && (
        <p className="muted">
          Up next: {queue.map((q) => q.name).join(', ')}
        </p>
      )}

      <h3>Calls &amp; CRM sync</h3>
      <table>
        <thead>
          <tr>
            <th>Call</th>
            <th>Lead</th>
            <th>Status</th>
            <th>Started</th>
            <th>Ended</th>
            <th>CRM sync</th>
          </tr>
        </thead>
        <tbody>
          {sortedCalls.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.id}{c.id === session.winnerCallId ? ' 🏆' : ''}</td>
              <td>{c.leadName}</td>
              <td><StatusBadge status={c.status} /></td>
              <td className="mono">{time(c.startedAt)}</td>
              <td className="mono">{c.endedAt ? time(c.endedAt) : '—'}</td>
              <td>{c.crmSync ? <StatusBadge status={c.crmSync} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>CRM activities (app DB)</h3>
      {activities.length === 0 ? (
        <p className="muted">No activities yet — created when a call reaches a terminal outcome.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Activity</th>
              <th>Call</th>
              <th>Contact</th>
              <th>Disposition</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {activities.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.id}</td>
                <td className="mono">{a.callId}</td>
                <td className="mono">{a.crmExternalId}</td>
                <td><StatusBadge status={a.disposition} /></td>
                <td className="notes">{a.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details className="sim-panel">
        <summary>Simulation controls</summary>
        <p className="muted">
          Outcomes fire on their own after 2–8s; the buttons on a dialing line force one immediately
          (<span className="mono">POST /sim/calls/:id/outcome</span>). Inspect the external store at{' '}
          <a href="/mock-crm/contacts" target="_blank" rel="noreferrer">/mock-crm/contacts</a> and{' '}
          <a href="/mock-crm/activities" target="_blank" rel="noreferrer">/mock-crm/activities</a>.
        </p>
        <button onClick={() => act(api.failNextCrmSync)}>Make next CRM request fail</button>
      </details>
    </section>
  );
}

function LineCard({
  n,
  call,
  sessionStatus,
  sessionId,
  act,
}: {
  n: number;
  call: CallView | null;
  sessionStatus: string;
  sessionId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  if (!call) {
    return (
      <div className="line-card idle">
        <div className="line-title">Line {n}</div>
        <div className="muted">{sessionStatus === 'RUNNING' ? 'Idle' : 'Not dialing'}</div>
      </div>
    );
  }
  return (
    <div className={`line-card ${call.status.toLowerCase()}`}>
      <div className="line-title">
        Line {n} <StatusBadge status={call.status} />
      </div>
      <div className="line-lead">{call.leadName}</div>
      <div className="mono">{call.leadPhone}</div>
      {call.status === 'DIALING' && (
        <div className="sim-buttons">
          {DIAL_OUTCOMES.map((o: DialOutcome) => (
            <button key={o} onClick={() => act(() => api.simOutcome(call.id, o))}>
              {o.replace('_', ' ').toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {call.status === 'CONNECTED' && (
        <button className="danger" onClick={() => act(() => api.hangup(sessionId, call.id))}>
          Hang up
        </button>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status.toLowerCase()}`}>{status}</span>;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

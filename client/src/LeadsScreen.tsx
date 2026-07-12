import { useEffect, useState } from 'react';
import type { Lead } from '@dialer/shared';
import { api } from './api';

/** Screen 1: seeded leads, checkbox selection, create dialer session. */
export function LeadsScreen({ onSessionCreated }: { onSessionCreated: (sessionId: string) => void }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.leads().then(setLeads).catch((e: Error) => setError(e.message));
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === leads.length ? new Set() : new Set(leads.map((l) => l.id))));
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const session = await api.createSession([...selected]);
      onSessionCreated(session.id);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <section>
      <div className="toolbar">
        <h2>Leads</h2>
        <button className="primary" disabled={selected.size === 0 || creating} onClick={create}>
          Create Dialer Session ({selected.size})
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="select all leads"
                checked={leads.length > 0 && selected.size === leads.length}
                onChange={toggleAll}
              />
            </th>
            <th>ID</th>
            <th>Name</th>
            <th>Company</th>
            <th>Phone</th>
            <th>Email</th>
            <th>CRM link</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id} className={selected.has(lead.id) ? 'selected' : ''}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`select ${lead.name}`}
                  checked={selected.has(lead.id)}
                  onChange={() => toggle(lead.id)}
                />
              </td>
              <td className="mono">{lead.id}</td>
              <td>{lead.name}</td>
              <td>{lead.company}</td>
              <td className="mono">{lead.phone}</td>
              <td>{lead.email}</td>
              <td>{lead.crmExternalId ? <span className="badge synced">{lead.crmExternalId}</span> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Select leads, create a session, then press <strong>Start</strong> on the session screen. The dialer keeps 2
        lines in flight; call outcomes are simulated (2–8s) or can be forced from the session screen.
      </p>
    </section>
  );
}

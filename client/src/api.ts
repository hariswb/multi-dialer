import type { Call, DialerSession, DialOutcome, Lead, SessionView } from '@dialer/shared';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  leads: () => request<Lead[]>('/leads'),
  createSession: (leadIds: string[]) => post<DialerSession>('/sessions', { leadIds }),
  session: (id: string) => request<SessionView>(`/sessions/${id}`),
  start: (id: string) => post<SessionView>(`/sessions/${id}/start`),
  stop: (id: string) => post<SessionView>(`/sessions/${id}/stop`),
  hangup: (id: string, callId: string) => post<SessionView>(`/sessions/${id}/calls/${callId}/hangup`),
  simOutcome: (callId: string, status: DialOutcome) => post<Call>(`/sim/calls/${callId}/outcome`, { status }),
  failNextCrmSync: () => post<{ failNext: number }>('/sim/crm/failures', { count: 1 }),
};

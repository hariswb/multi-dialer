/**
 * Domain types shared by server and client.
 * Field names follow the assessment spec verbatim.
 */

/**
 * Spec statuses are CONNECTED | NO_ANSWER | BUSY | VOICEMAIL | CANCELED_BY_DIALER.
 * DIALING is added to represent a call in flight; a call is *terminal* when
 * `endedAt` is set — a CONNECTED call becomes terminal when it ends (hangup or
 * simulated duration), keeping status CONNECTED per the spec's status list.
 */
export type CallStatus =
  | 'DIALING'
  | 'CONNECTED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'VOICEMAIL'
  | 'CANCELED_BY_DIALER';

/** Statuses a simulated/forced dial attempt can resolve to. */
export const DIAL_OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL'] as const;
export type DialOutcome = (typeof DIAL_OUTCOMES)[number];
export type FailureOutcome = Exclude<DialOutcome, 'CONNECTED'>;

/**
 * Spec lists RUNNING | STOPPED. CREATED is added because the UI separates
 * "Create Dialer Session" from "Start".
 */
export type SessionStatus = 'CREATED' | 'RUNNING' | 'STOPPED';

export type CrmSyncStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface Lead {
  id: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  crmExternalId?: string;
}

export interface Call {
  id: string;
  leadId: string;
  sessionId: string;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  providerCallId: string;
}

export interface SessionMetrics {
  attempted: number;
  connected: number;
  failed: number;
  canceled: number;
}

export interface DialerSession {
  id: string;
  agentId: string;
  leadQueue: string[];
  concurrency: 2;
  activeCallIds: string[];
  winnerCallId: string | null;
  status: SessionStatus;
  metrics: SessionMetrics;
}

export interface CRMActivity {
  id: string;
  leadId: string;
  crmExternalId: string;
  type: 'CALL';
  callId: string;
  disposition: CallStatus;
  notes: string;
  createdAt: string;
}

/* ---- API view models (what GET /sessions/:id returns for polling) ---- */

export interface CallView extends Call {
  leadName: string;
  leadPhone: string;
  crmSync: CrmSyncStatus | null;
}

export interface SessionView {
  session: DialerSession;
  calls: CallView[];
  activities: CRMActivity[];
  queue: Array<{ id: string; name: string }>;
}

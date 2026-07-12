import { useState } from 'react';
import { LeadsScreen } from './LeadsScreen';
import { SessionScreen } from './SessionScreen';

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Multi-Line Dialer</h1>
        <span className="subtitle">2 lines · mock CRM sync · AI Sales Doctor take-home</span>
      </header>
      {sessionId === null ? (
        <LeadsScreen onSessionCreated={setSessionId} />
      ) : (
        <SessionScreen sessionId={sessionId} onBack={() => setSessionId(null)} />
      )}
    </div>
  );
}

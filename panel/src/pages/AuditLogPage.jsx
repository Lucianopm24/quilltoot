import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, EmptyState, Spinner } from '../components/ui';

export function AuditLogPage() {
  const [log, setLog] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.moderation
      .log()
      .then((res) => setLog(res.log))
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="page">
      <h1 className="page__title">Registro de auditoría</h1>
      <p className="page__sub">Últimas 100 acciones de moderación tomadas en esta instancia.</p>

      {error && <p className="page__error">{error}</p>}
      {!log && !error && <Spinner />}
      {log?.length === 0 && <EmptyState title="Todavía no hay acciones registradas" />}

      <div className="audit-list">
        {log?.map((entry) => (
          <Card key={entry.id} className="audit-row">
            <span className="audit-row__action">{entry.action}</span>
            <span className="audit-row__meta">
              por @{entry.moderator_username || 'desconocido'} · {new Date(entry.created_at).toLocaleString()}
            </span>
            {entry.reason && <p className="audit-row__reason">{entry.reason}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
}
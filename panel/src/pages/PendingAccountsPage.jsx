import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Button, EmptyState, Spinner } from '../components/ui';

export function PendingAccountsPage() {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busyUser, setBusyUser] = useState(null);

  async function load() {
    try {
      const res = await api.auth.pending();
      setPending(res.pending);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handle(username, action) {
    setBusyUser(username);
    try {
      if (action === 'approve') await api.auth.approve(username);
      else await api.auth.reject(username);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyUser(null);
    }
  }

  return (
    <div className="page">
      <h1 className="page__title">Cuentas pendientes</h1>
      <p className="page__sub">Solicitudes de registro esperando aprobación.</p>

      {error && <p className="page__error">{error}</p>}
      {!pending && !error && <Spinner />}
      {pending?.length === 0 && <EmptyState title="No hay solicitudes pendientes" />}

      {pending?.map((p) => (
        <Card key={p.id} className="pending-row">
          <div>
            <strong>@{p.username}</strong>
            <span className="mod-account__domain">{p.email}</span>
            {p.display_name && <div className="pending-row__display">{p.display_name}</div>}
            {p.join_reason && <p className="mod-account__reason">"{p.join_reason}"</p>}
            <span className="audit-row__meta">solicitó el {new Date(p.created_at).toLocaleDateString()}</span>
          </div>
          <div className="pending-row__actions">
            <Button variant="ok" size="sm" disabled={busyUser === p.username} onClick={() => handle(p.username, 'approve')}>
              Aprobar
            </Button>
            <Button variant="danger" size="sm" disabled={busyUser === p.username} onClick={() => handle(p.username, 'reject')}>
              Rechazar
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
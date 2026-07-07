import { useState } from 'react';
import { api } from '../lib/api';
import { Card, Button, Input, Badge, StatusPill, EmptyState, Textarea } from '../components/ui';

const STATUS_FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'active', label: 'Activas' },
  { key: 'silenced', label: 'Silenciadas' },
  { key: 'suspended', label: 'Suspendidas' },
];

function AccountCard({ account, onChanged }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const isSuspended = !!account.suspended_at;
  const isSilenced = !!account.silenced_at && !isSuspended;

  async function run(action) {
    setBusy(action);
    try {
      if (action === 'suspend') await api.moderation.suspend(account.type, account.id, reason);
      if (action === 'unsuspend') await api.moderation.unsuspend(account.type, account.id);
      if (action === 'silence') await api.moderation.silence(account.type, account.id, reason);
      if (action === 'unsilence') await api.moderation.unsilence(account.type, account.id);
      setReason('');
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mod-account">
      <div className="mod-account__head">
        <div>
          <strong>@{account.username}</strong>
          {account.domain && <span className="mod-account__domain">@{account.domain}</span>}
          <Badge tone="default">{account.type === 'local' ? 'local' : 'remota'}</Badge>
        </div>
        <StatusPill suspendedAt={account.suspended_at} silencedAt={account.silenced_at} />
      </div>

      {(account.suspended_reason || account.silenced_reason) && (
        <p className="mod-account__reason">Motivo: {account.suspended_reason || account.silenced_reason}</p>
      )}

      {!isSuspended && (
        <Textarea placeholder="Motivo (se guarda en el registro de auditoría)" value={reason} onChange={(e) => setReason(e.target.value)} />
      )}

      <div className="mod-account__actions">
        {isSuspended ? (
          <Button variant="ok" size="sm" disabled={!!busy} onClick={() => run('unsuspend')}>
            Levantar suspensión
          </Button>
        ) : (
          <Button variant="danger" size="sm" disabled={!!busy} onClick={() => run('suspend')}>
            Suspender
          </Button>
        )}
        {!isSuspended &&
          (isSilenced ? (
            <Button variant="ok" size="sm" disabled={!!busy} onClick={() => run('unsilence')}>
              Levantar silencio
            </Button>
          ) : (
            <Button variant="warn" size="sm" disabled={!!busy} onClick={() => run('silence')}>
              Silenciar
            </Button>
          ))}
      </div>
    </Card>
  );
}

export function ModerationAccountsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  async function search() {
    setError(null);
    try {
      const res = await api.moderation.searchAccounts(q, status);
      setResults([...res.local, ...res.remote]);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <h1 className="page__title">Cuentas</h1>
      <p className="page__sub">Buscá una cuenta local o remota para suspenderla o silenciarla.</p>

      <div className="search-bar">
        <Input
          placeholder="Buscar por usuario, email o nombre…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <select className="qb-input" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <Button onClick={search}>Buscar</Button>
      </div>

      {error && <p className="page__error">{error}</p>}
      {results && results.length === 0 && <EmptyState title="Sin resultados" note="Probá con otro término de búsqueda." />}
      {results?.map((acc) => (
        <AccountCard key={`${acc.type}-${acc.id}`} account={acc} onChanged={search} />
      ))}
      {!results && !error && (
        <EmptyState title="Empezá buscando" note="Escribí un nombre de usuario y presioná Buscar." />
      )}
    </div>
  );
}
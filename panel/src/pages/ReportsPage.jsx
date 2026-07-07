import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Card, Button, Badge, EmptyState, Spinner, Textarea } from '../components/ui';

const TABS = [
  { key: 'open', label: 'Abiertos' },
  { key: 'resolved', label: 'Resueltos' },
  { key: 'dismissed', label: 'Descartados' },
];

function targetLabel(report) {
  if (report.target_username) return `@${report.target_username}`;
  if (report.target_actor_username) return `@${report.target_actor_username}@${report.target_actor_domain}`;
  return 'cuenta desconocida';
}

function ReportRow({ report, onResolve }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);

  async function act(action) {
    setBusy(action);
    try {
      await onResolve(report.id, action, note);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="report-row">
      <div className="report-row__head">
        <div>
          <strong>{targetLabel(report)}</strong>
          <span className="report-row__meta"> reportado por @{report.reporter_username}</span>
        </div>
        <Badge tone="default">{new Date(report.created_at).toLocaleDateString()}</Badge>
      </div>

      {report.comment && <p className="report-row__comment">"{report.comment}"</p>}

      {report.status === 'open' ? (
        <>
          <Textarea
            placeholder="Nota de resolución (opcional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="report-row__actions">
            <Button variant="ok" size="sm" disabled={!!busy} onClick={() => act('resolve')}>
              {busy === 'resolve' ? 'Resolviendo…' : 'Marcar resuelto'}
            </Button>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act('dismiss')}>
              {busy === 'dismiss' ? 'Descartando…' : 'Descartar'}
            </Button>
          </div>
        </>
      ) : (
        report.resolution_note && <p className="report-row__resolution">Nota: {report.resolution_note}</p>
      )}
    </Card>
  );
}

export function ReportsPage() {
  const [tab, setTab] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async (status) => {
    setReports(null);
    try {
      const res = await api.moderation.listReports(status);
      setReports(res.reports);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  async function handleResolve(id, action, note) {
    await api.moderation.resolveReport(id, action, note);
    load(tab);
  }

  return (
    <div className="page">
      <h1 className="page__title">Reportes</h1>
      <p className="page__sub">Denuncias enviadas por usuarios de esta instancia.</p>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tabs__item ${tab === t.key ? 'tabs__item--active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="page__error">{error}</p>}
      {!reports && !error && <Spinner />}
      {reports && reports.length === 0 && (
        <EmptyState title="No hay reportes acá" note="Cuando alguien reporte una cuenta, va a aparecer en esta lista." />
      )}
      {reports?.map((r) => (
        <ReportRow key={r.id} report={r} onResolve={handleResolve} />
      ))}
    </div>
  );
}
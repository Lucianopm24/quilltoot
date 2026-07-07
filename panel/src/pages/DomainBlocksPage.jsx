import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Button, Input, Textarea, Badge, EmptyState, Spinner } from '../components/ui';

export function DomainBlocksPage() {
  const [blocks, setBlocks] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ domain: '', severity: 'silence', reason: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const res = await api.moderation.listDomainBlocks();
      setBlocks(res.domain_blocks);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.moderation.createDomainBlock(form);
      setForm({ domain: '', severity: 'silence', reason: '' });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(domain) {
    await api.moderation.removeDomainBlock(domain);
    load();
  }

  return (
    <div className="page">
      <h1 className="page__title">Dominios bloqueados</h1>
      <p className="page__sub">Silenciar limita el alcance de un dominio remoto; suspender lo bloquea por completo.</p>

      <Card style={{ marginBottom: '1.5rem' }}>
        <h2 className="card-title">Bloquear un dominio nuevo</h2>
        <form onSubmit={handleAdd}>
          <div className="domain-form">
            <Input
              placeholder="ejemplo.com"
              value={form.domain}
              onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
              required
            />
            <select
              className="qb-input"
              style={{ width: 140 }}
              value={form.severity}
              onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
            >
              <option value="silence">Silenciar</option>
              <option value="suspend">Suspender</option>
            </select>
          </div>
          <Textarea
            placeholder="Motivo (opcional)"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
          {error && <p className="page__error">{error}</p>}
          <Button type="submit" disabled={saving}>
            {saving ? 'Bloqueando…' : 'Bloquear dominio'}
          </Button>
        </form>
      </Card>

      {!blocks && <Spinner />}
      {blocks?.length === 0 && <EmptyState title="No hay dominios bloqueados" />}
      {blocks?.map((b) => (
        <Card key={b.domain} className="domain-row">
          <div>
            <strong>{b.domain}</strong>
            <Badge tone={b.severity === 'suspend' ? 'danger' : 'warn'} style={{ marginLeft: '0.5rem' }}>
              {b.severity === 'suspend' ? 'suspendido' : 'silenciado'}
            </Badge>
            {b.reason && <p className="mod-account__reason">{b.reason}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => handleRemove(b.domain)}>
            Quitar bloqueo
          </Button>
        </Card>
      ))}
    </div>
  );
}
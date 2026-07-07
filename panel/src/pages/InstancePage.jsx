import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Spinner } from '../components/ui';

export function InstancePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.instance
      .get()
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="page__error">No se pudo cargar la información de la instancia: {error}</p>;
  if (!data) return <Spinner />;

  const { settings, stats } = data;

  return (
    <div className="page">
      <h1 className="page__title">{settings?.title || 'Esta instancia'}</h1>
      {settings?.short_description && <p className="page__sub">{settings.short_description}</p>}

      <div className="stat-grid">
        <Card className="stat-card">
          <span className="stat-card__num">{stats?.user_count ?? 0}</span>
          <span className="stat-card__label">cuentas locales</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-card__num">{stats?.status_count ?? 0}</span>
          <span className="stat-card__label">posts publicados</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-card__num">{stats?.domain_count ?? 0}</span>
          <span className="stat-card__label">instancias con las que federa</span>
        </Card>
      </div>

      {settings?.description && (
        <Card style={{ marginTop: '1.25rem' }}>
          <h2 className="card-title">Sobre esta instancia</h2>
          <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>{settings.description}</p>
        </Card>
      )}

      {settings?.contact_email && (
        <p className="page__footnote">
          Contacto: <a href={`mailto:${settings.contact_email}`}>{settings.contact_email}</a>
        </p>
      )}
    </div>
  );
}
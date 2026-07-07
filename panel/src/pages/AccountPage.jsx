import { useSession } from '../lib/SessionContext';
import { Card, Badge } from '../components/ui';

export function AccountPage() {
  const { user } = useSession();

  return (
    <div className="page">
      <h1 className="page__title">Mi cuenta</h1>
      <p className="page__sub">Así te ve el resto de la instancia (y la federación).</p>

      <Card style={{ marginBottom: '1.25rem' }}>
        <div className="account-row">
          <div>
            <div className="account-row__name">{user?.display_name}</div>
            <div className="account-row__handle">@{user?.username}</div>
          </div>
          <div className="account-row__badges">
            {user?.is_admin && <Badge tone="default">Admin</Badge>}
            {!user?.is_admin && user?.is_moderator && <Badge tone="default">Moderador</Badge>}
            {user?.silenced_at && <Badge tone="warn">Silenciada</Badge>}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="card-title">Datos de la cuenta</h2>
        <dl className="kv">
          <dt>Usuario</dt>
          <dd>@{user?.username}</dd>
          <dt>Se unió</dt>
          <dd>{user?.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</dd>
          <dt>Seguidores</dt>
          <dd>{user?.followers_count ?? 0}</dd>
          <dt>Siguiendo</dt>
          <dd>{user?.following_count ?? 0}</dd>
          <dt>Posts</dt>
          <dd>{user?.statuses_count ?? 0}</dd>
        </dl>
      </Card>

      <p className="page__footnote">
        Por ahora, editar tu nombre, bio o avatar todavía no tiene un endpoint en el backend — esta pantalla es de
        solo lectura. Para publicar, seguir gente, o dar de baja tu cuenta, usá{' '}
        <a href="https://elk.zone" target="_blank" rel="noreferrer">
          Elk
        </a>{' '}
        apuntando a esta instancia.
      </p>
    </div>
  );
}
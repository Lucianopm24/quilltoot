import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../lib/SessionContext';
import { QuillMark } from './QuillMark';
import './AppShell.css';

export function AppShell() {
  const { user, isModerator, logout } = useSession();

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        <div className="shell__brand">
          <QuillMark size={26} />
          <span>Quilltoot</span>
        </div>

        <nav className="shell__nav">
          <NavLink to="/cuenta" className="shell__link">
            Mi cuenta
          </NavLink>
          <NavLink to="/instancia" className="shell__link">
            La instancia
          </NavLink>
          {isModerator && (
            <>
              <div className="shell__nav-divider">Moderación</div>
              <NavLink to="/moderacion/reportes" className="shell__link">
                Reportes
              </NavLink>
              <NavLink to="/moderacion/cuentas" className="shell__link">
                Cuentas
              </NavLink>
              <NavLink to="/moderacion/dominios" className="shell__link">
                Dominios bloqueados
              </NavLink>
              <NavLink to="/moderacion/registro" className="shell__link">
                Registro de auditoría
              </NavLink>
            </>
          )}
          {user?.is_admin && (
            <>
              <div className="shell__nav-divider">Administración</div>
              <NavLink to="/admin/pendientes" className="shell__link">
                Cuentas pendientes
              </NavLink>
              <NavLink to="/admin/ajustes" className="shell__link">
                Ajustes de la instancia
              </NavLink>
            </>
          )}
        </nav>

        <div className="shell__user">
          <div className="shell__user-info">
            <span className="shell__user-name">@{user?.username}</span>
            {user?.is_admin && <span className="shell__user-role">admin</span>}
            {!user?.is_admin && user?.is_moderator && <span className="shell__user-role">mod</span>}
          </div>
          <button className="shell__logout" onClick={logout}>
            Salir
          </button>
        </div>
      </aside>

      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
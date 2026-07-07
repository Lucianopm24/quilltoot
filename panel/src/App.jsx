import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider } from './lib/SessionContext';
import { AppShell } from './components/AppShell';
import { RequireAuth, RequireModerator, RequireAdmin, RedirectIfAuthed } from './components/Guards';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AccountPage } from './pages/AccountPage';
import { InstancePage } from './pages/InstancePage';
import { ReportsPage } from './pages/ReportsPage';
import { ModerationAccountsPage } from './pages/ModerationAccountsPage';
import { DomainBlocksPage } from './pages/DomainBlocksPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { PendingAccountsPage } from './pages/PendingAccountsPage';
import { InstanceSettingsPage } from './pages/InstanceSettingsPage';
import './pages/pages.css';

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter basename="/panel">
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <LoginPage />
              </RedirectIfAuthed>
            }
          />
          <Route
            path="/registro"
            element={
              <RedirectIfAuthed>
                <RegisterPage />
              </RedirectIfAuthed>
            }
          />
          {/* El flujo OAuth necesita un redirect_uri real; esta ruta solo
              existe para que exista una página cuando el navegador vuelve
              acá — en la práctica loginWithPassword() nunca deja que el
              navegador navegue de verdad hasta esta URL. */}
          <Route path="/oauth-callback" element={<Navigate to="/cuenta" replace />} />

          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/cuenta" element={<AccountPage />} />
            <Route path="/instancia" element={<InstancePage />} />

            <Route
              path="/moderacion/reportes"
              element={
                <RequireModerator>
                  <ReportsPage />
                </RequireModerator>
              }
            />
            <Route
              path="/moderacion/cuentas"
              element={
                <RequireModerator>
                  <ModerationAccountsPage />
                </RequireModerator>
              }
            />
            <Route
              path="/moderacion/dominios"
              element={
                <RequireModerator>
                  <DomainBlocksPage />
                </RequireModerator>
              }
            />
            <Route
              path="/moderacion/registro"
              element={
                <RequireModerator>
                  <AuditLogPage />
                </RequireModerator>
              }
            />

            <Route
              path="/admin/pendientes"
              element={
                <RequireAdmin>
                  <PendingAccountsPage />
                </RequireAdmin>
              }
            />
            <Route
              path="/admin/ajustes"
              element={
                <RequireAdmin>
                  <InstanceSettingsPage />
                </RequireAdmin>
              }
            />
          </Route>

          <Route path="*" element={<Navigate to="/cuenta" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
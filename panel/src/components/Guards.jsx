import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/SessionContext';
import { QuillMark } from './QuillMark';

export function FullPageLoader() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <QuillMark size={36} animated />
    </div>
  );
}

export function RequireAuth({ children }) {
  const { status } = useSession();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return children;
}

export function RequireModerator({ children }) {
  const { status, isModerator } = useSession();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  if (!isModerator) return <Navigate to="/cuenta" replace />;
  return children;
}

export function RequireAdmin({ children }) {
  const { status, isAdmin } = useSession();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/cuenta" replace />;
  return children;
}

export function RedirectIfAuthed({ children }) {
  const { status } = useSession();
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'authed') return <Navigate to="/cuenta" replace />;
  return children;
}
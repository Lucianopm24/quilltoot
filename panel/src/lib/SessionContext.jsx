import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, ApiError } from './api';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | authed | anon

  const refresh = useCallback(async () => {
    if (!api.isLoggedIn()) {
      setUser(null);
      setStatus('anon');
      return;
    }
    try {
      const me = await api.account.verifyCredentials();
      setUser(me);
      setStatus('authed');
    } catch (err) {
      // Token vencido/inválido/revocado: volvemos a modo anónimo en
      // silencio, sin quedar en un loop de error.
      api.logout();
      setUser(null);
      setStatus('anon');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(
    async (identifier, password) => {
      await api.loginWithPassword(identifier, password);
      await refresh();
    },
    [refresh]
  );

  const logout = useCallback(() => {
    api.logout();
    setUser(null);
    setStatus('anon');
  }, []);

  const value = {
    user,
    status,
    login,
    logout,
    refresh,
    isModerator: !!user && (user.is_moderator || user.is_admin),
    isAdmin: !!user && user.is_admin,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession debe usarse dentro de <SessionProvider>');
  return ctx;
}

export { ApiError };
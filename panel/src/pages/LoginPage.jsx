import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/SessionContext';
import { Card, Field, Input, Button } from '../components/ui';
import { QuillMark } from '../components/QuillMark';
import './AuthPages.css';

export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(identifier, password);
      navigate('/cuenta');
    } catch (err) {
      setError(err.message || 'No se pudo iniciar sesión.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <Card className="auth-card">
        <div className="auth-brand">
          <QuillMark size={32} animated />
          <h1>Quilltoot</h1>
        </div>
        <p className="auth-sub">Entrá a tu cuenta para administrar tu instancia.</p>

        <form onSubmit={handleSubmit}>
          <Field label="Usuario o email">
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="Contraseña" error={error}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Entrando…' : 'Entrar'}
          </Button>
        </form>

        <p className="auth-foot">
          ¿No tenés cuenta? <Link to="/registro">Registrate</Link>
        </p>
      </Card>
    </div>
  );
}
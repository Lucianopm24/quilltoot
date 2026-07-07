import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Field, Input, Textarea, Button } from '../components/ui';
import { QuillMark } from '../components/QuillMark';
import './AuthPages.css';

export function RegisterPage() {
  const [instance, setInstance] = useState(null);
  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    display_name: '',
    join_reason: '',
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.instance
      .get()
      .then(setInstance)
      .catch(() => setInstance(null));
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body = { ...form };
      if (!body.join_reason.trim()) delete body.join_reason;
      if (!body.display_name.trim()) delete body.display_name;
      const res = await api.auth.register(body);
      setResult(res);
    } catch (err) {
      setError(err.message || 'No se pudo crear la cuenta.');
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div className="auth-page">
        <Card className="auth-card">
          <div className="auth-brand">
            <QuillMark size={32} />
            <h1>Quilltoot</h1>
          </div>
          <div className="auth-success">
            {result.user.approval_status === 'pending'
              ? 'Tu cuenta se creó y quedó pendiente de aprobación. Un administrador la va a revisar pronto — vas a poder entrar apenas la aprueben.'
              : 'Tu cuenta se creó y ya está aprobada. Ya podés iniciar sesión.'}
          </div>
          <p className="auth-foot">
            <Link to="/login">Ir a iniciar sesión</Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <Card className="auth-card">
        <div className="auth-brand">
          <QuillMark size={32} />
          <h1>Quilltoot</h1>
        </div>
        <p className="auth-sub">
          {instance?.settings?.title ? `Sumate a ${instance.settings.title}.` : 'Creá tu cuenta.'}
        </p>

        <form onSubmit={handleSubmit}>
          <Field label="Usuario" hint="minúsculas, números y guion bajo, sin espacios">
            <Input
              value={form.username}
              onChange={(e) => update('username', e.target.value.toLowerCase())}
              pattern="[a-z0-9_]{1,30}"
              required
            />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} required />
          </Field>
          <Field label="Contraseña" hint="mínimo 8 caracteres">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              minLength={8}
              required
            />
          </Field>
          <Field label="Nombre para mostrar (opcional)">
            <Input value={form.display_name} onChange={(e) => update('display_name', e.target.value)} />
          </Field>
          <Field label="¿Por qué querés unirte? (puede ser obligatorio según la instancia)" error={error}>
            <Textarea value={form.join_reason} onChange={(e) => update('join_reason', e.target.value)} />
          </Field>
          <Button type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Creando cuenta…' : 'Crear cuenta'}
          </Button>
        </form>

        <p className="auth-foot">
          ¿Ya tenés cuenta? <Link to="/login">Iniciá sesión</Link>
        </p>
      </Card>
    </div>
  );
}
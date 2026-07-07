import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Field, Input, Textarea, Button, Spinner } from '../components/ui';

export function InstanceSettingsPage() {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.instance
      .getAdminSettings()
      .then((res) => setForm(res.settings))
      .catch((err) => setError(err.message));
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setSaved(false);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.instance.updateAdminSettings({
        title: form.title,
        short_description: form.short_description,
        description: form.description,
        contact_email: form.contact_email,
      });
      setForm(res.settings);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!form && !error) return <Spinner />;

  return (
    <div className="page">
      <h1 className="page__title">Ajustes de la instancia</h1>
      <p className="page__sub">Esto es lo que ve cualquiera que visite tu instancia o busque conectarse a ella.</p>

      {error && <p className="page__error">{error}</p>}

      {form && (
        <Card>
          <form onSubmit={handleSubmit}>
            <Field label="Título">
              <Input value={form.title || ''} onChange={(e) => update('title', e.target.value)} />
            </Field>
            <Field label="Descripción corta" hint="Se muestra en tarjetas y listados de instancias">
              <Input value={form.short_description || ''} onChange={(e) => update('short_description', e.target.value)} />
            </Field>
            <Field label="Descripción completa">
              <Textarea value={form.description || ''} onChange={(e) => update('description', e.target.value)} rows={5} />
            </Field>
            <Field label="Email de contacto">
              <Input type="email" value={form.contact_email || ''} onChange={(e) => update('contact_email', e.target.value)} />
            </Field>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </Button>
            {saved && <span style={{ marginLeft: '0.75rem', color: 'var(--ok)', fontSize: '0.85rem' }}>Guardado ✓</span>}
          </form>
        </Card>
      )}

      <p className="page__footnote">
        Registro abierto y aprobación requerida se controlan con las variables de entorno OPEN_REGISTRATION y
        APPROVAL_REQUIRED en Vercel — no se pueden cambiar desde acá porque requieren un redeploy.
      </p>
    </div>
  );
}
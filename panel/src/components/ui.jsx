import './ui.css';

export function Button({ children, variant = 'primary', size = 'md', ...props }) {
  return (
    <button className={`qb-btn qb-btn--${variant} qb-btn--${size}`} {...props}>
      {children}
    </button>
  );
}

export function Card({ children, className = '', ...props }) {
  return (
    <div className={`qb-card ${className}`} {...props}>
      {children}
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="qb-field">
      <span className="qb-field__label">{label}</span>
      {children}
      {hint && !error && <span className="qb-field__hint">{hint}</span>}
      {error && <span className="qb-field__error">{error}</span>}
    </label>
  );
}

export function Input(props) {
  return <input className="qb-input" {...props} />;
}

export function Textarea(props) {
  return <textarea className="qb-input qb-input--area" {...props} />;
}

export function Badge({ tone = 'default', children }) {
  return <span className={`qb-badge qb-badge--${tone}`}>{children}</span>;
}

export function StatusPill({ suspendedAt, silencedAt }) {
  if (suspendedAt) return <Badge tone="danger">Suspendida</Badge>;
  if (silencedAt) return <Badge tone="warn">Silenciada</Badge>;
  return <Badge tone="ok">Activa</Badge>;
}

export function EmptyState({ title, note }) {
  return (
    <div className="qb-empty">
      <p className="qb-empty__title">{title}</p>
      {note && <p className="qb-empty__note">{note}</p>}
    </div>
  );
}

export function Spinner() {
  return <span className="qb-spinner" aria-label="Cargando" />;
}
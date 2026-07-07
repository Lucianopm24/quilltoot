// Firma visual del panel: una pluma trazando una línea de tinta que se
// curva hacia una nota (el "toot"). Se usa como logo y como loading state.
export function QuillMark({ size = 28, animated = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M6 38 C 14 34, 16 26, 22 22"
        stroke="var(--ink-dim)"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        style={
          animated
            ? { strokeDasharray: 24, strokeDashoffset: 24, animation: 'qb-ink-draw 1.1s ease forwards' }
            : undefined
        }
      />
      <path
        d="M22 22 C 26 18, 30 8, 40 6 C 38 16, 28 20, 24 24"
        fill="var(--ink)"
      />
      <circle cx="24" cy="24" r="2.3" fill="var(--text)" />
      <style>{`
        @keyframes qb-ink-draw {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </svg>
  );
}
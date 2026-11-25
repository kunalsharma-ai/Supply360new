export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <defs>
          <linearGradient id="s360g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--info)" />
          </linearGradient>
        </defs>
        <circle
          cx="16"
          cy="16"
          r="13"
          fill="none"
          stroke="url(#s360g)"
          strokeWidth="2.5"
          strokeDasharray="62 20"
          strokeLinecap="round"
        />
        <circle cx="16" cy="16" r="5" fill="url(#s360g)" />
      </svg>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight">
          Supply<span className="text-accent">360</span>
        </span>
      )}
    </div>
  );
}

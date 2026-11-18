import clsx from "clsx";

/** Doott wordmark: red mark + lowercase wordmark. */
export function Logo({ className, inverted, compact }: { className?: string; inverted?: boolean; compact?: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 64 64" className="h-8 w-8 shrink-0" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill={inverted ? "#fff" : "#d9142b"} />
        <circle cx="25" cy="32" r="11" fill="none" stroke={inverted ? "#d9142b" : "#fff"} strokeWidth="6" />
        <circle cx="43" cy="32" r="5" fill={inverted ? "#d9142b" : "#fff"} />
      </svg>
      {!compact && (
        <span className="leading-none">
          <span className={clsx("block font-display text-[19px] font-extrabold tracking-tight", inverted ? "text-white" : "text-ink-900")}>
            doott<span className={inverted ? "text-white/70" : "text-brand-600"}>.</span>
          </span>
          <span className={clsx("mt-0.5 block text-[10px] font-semibold uppercase tracking-[0.18em]", inverted ? "text-white/70" : "text-ink-400")}>Lead OS</span>
        </span>
      )}
    </span>
  );
}

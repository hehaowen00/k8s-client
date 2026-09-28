import { useEffect, useRef, useState } from "react";
import { ALL_NAMESPACES, nsSelection } from "../util";

/** Multi-select namespace picker. `value` is "" (none), "*" (all) or a comma-separated list. */
export function NamespacePicker({
  value,
  options,
  onChange,
  onOpen,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const sel = nsSelection(value);
  const selected = sel.list;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const label = sel.all ? "All namespaces" : selected.length === 0 ? "Select namespace" : selected.length === 1 ? selected[0] : `${selected.length} namespaces`;
  const toggle = (ns: string) => {
    const next = selected.includes(ns) ? selected.filter((x) => x !== ns) : [...selected, ns];
    onChange(next.join(","));
  };
  // Keep selected namespaces visible even if they aren't in the listed options.
  const all = [...new Set([...options, ...selected])];
  const shown = all.filter((n) => !q || n.includes(q.toLowerCase()));

  return (
    <div className="ns-picker" ref={ref}>
      <button
        className="select select-btn ns-picker-button"
        title={sel.all ? "All namespaces" : selected.join(", ") || "No namespace selected"}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <span className="select-value">{label}</span>
        <svg className="select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ns-popover" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <input className="input" autoFocus placeholder="Filter namespaces" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className={`ns-option ${sel.all ? "active" : ""}`} onClick={() => onChange(sel.all ? "" : ALL_NAMESPACES)}>
            <span className="ns-check">{sel.all ? "✓" : ""}</span>
            All namespaces
          </button>
          <div className="ns-list">
            {shown.map((n) => (
              <div key={n} className={`ns-option ${selected.includes(n) ? "active" : ""}`}>
                <button className="ns-toggle" onClick={() => toggle(n)} title="Add / remove">
                  <span className="ns-check">{selected.includes(n) ? "✓" : ""}</span>
                  {n}
                </button>
                <button className="ns-only" onClick={() => onChange(n)} title={`Only ${n}`}>
                  only
                </button>
              </div>
            ))}
            {shown.length === 0 && <div className="muted small pad">No namespaces</div>}
          </div>
        </div>
      )}
    </div>
  );
}

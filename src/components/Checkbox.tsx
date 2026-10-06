import type { ReactNode } from "react";

/** Event shape matching a native checkbox, so call sites keep `e.target.checked`. */
export interface CheckboxChangeEvent {
  target: { checked: boolean };
  currentTarget: { checked: boolean };
}

interface Props {
  checked: boolean;
  onChange?: (e: CheckboxChangeEvent) => void;
  /** Raw click (e.g. to read shiftKey for range selection). */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
}

/** Themed replacement for <input type="checkbox"> (with optional label). */
export function Checkbox({ checked, onChange, onClick, indeterminate, disabled, title, className, children, ...rest }: Props) {
  const state = indeterminate ? "mixed" : checked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state}
      aria-label={rest["aria-label"]}
      disabled={disabled}
      title={title}
      className={`checkbox ${checked ? "on" : ""} ${indeterminate ? "mixed" : ""} ${children ? "labelled" : ""} ${className ?? ""}`}
      onClick={(e) => {
        onClick?.(e);
        const next = !checked;
        onChange?.({ target: { checked: next }, currentTarget: { checked: next } });
      }}
    >
      <span className="checkbox-box" aria-hidden>
        {indeterminate ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ) : checked ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1.8 5.2 4 7.3 8.2 2.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      {children && <span className="checkbox-label">{children}</span>}
    </button>
  );
}

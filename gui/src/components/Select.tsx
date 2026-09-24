import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

interface Option {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}

/** Plain text of option children like `{c.name}{c.init ? " (init)" : ""}`. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** Collect `<option>` elements from children (through fragments, arrays and conditionals). */
function collectOptions(children: ReactNode, out: Option[] = []): Option[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; title?: string; disabled?: boolean }>;
    if (el.type === "option") {
      const label = textOf(el.props.children);
      out.push({ value: String(el.props.value ?? label), label, title: el.props.title, disabled: el.props.disabled });
    } else if (el.props.children !== undefined) {
      collectOptions(el.props.children, out);
    }
  });
  return out;
}

/** Event shape matching a native <select>, so call sites keep `e.target.value`. */
export interface SelectChangeEvent {
  target: { value: string };
  currentTarget: { value: string };
}

interface Props {
  value: string | number | null | undefined;
  onChange?: (e: SelectChangeEvent) => void;
  /** `<option value=…>label</option>` elements, as with a native select. */
  children: ReactNode;
  className?: string;
  title?: string;
  disabled?: boolean;
  onFocus?: () => void;
  "aria-label"?: string;
}

const SEARCH_THRESHOLD = 10;

/** Themed replacement for <select>: button + listbox popover (portalled), keyboard accessible. */
export function Select({ value, onChange, children, className, title, disabled, onFocus, ...rest }: Props) {
  const options = useMemo(() => collectOptions(children), [children]);
  const current = String(value ?? "");
  const selected = options.find((o) => o.value === current) ?? options[0];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listId = useId();

  const searchable = options.length > SEARCH_THRESHOLD;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;

  const place = () => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 8;
    const above = b.top - 8;
    const up = below < 220 && above > below;
    setPos({
      left: Math.min(b.left, window.innerWidth - Math.max(b.width, 160) - 8),
      top: up ? b.top - 4 : b.bottom + 4,
      width: Math.max(b.width, 160),
      maxHeight: Math.min(340, up ? above : below),
      up,
    });
  };

  const openList = () => {
    if (disabled) return;
    onFocus?.();
    setQuery("");
    setCursor(Math.max(0, options.findIndex((o) => o.value === current)));
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (o: Option | undefined) => {
    if (!o || o.disabled) return;
    close();
    if (o.value !== current) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open, shown.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      // Only close when the scroll moved the anchor (an ancestor of the button scrolled), not for
      // unrelated scrollers like a log view auto-following new lines.
      const t = e.target as Node;
      if (buttonRef.current && t.contains?.(buttonRef.current)) close(false);
    };
    const onBlur = () => close(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    // Without a search box, focus the list so arrow keys / Enter / type-ahead work.
    if (!searchable) requestAnimationFrame(() => listRef.current?.focus());
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const move = (delta: number) => {
    if (!shown.length) return;
    let i = cursor;
    for (let step = 0; step < shown.length; step++) {
      i = (i + delta + shown.length) % shown.length;
      if (!shown[i].disabled) break;
    }
    setCursor(i);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[cursor]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    } else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Type-ahead like a native select.
      const now = Date.now();
      const ta = typeahead.current;
      ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase();
      ta.at = now;
      const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(ta.text));
      if (i >= 0) setCursor(i);
    }
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openList();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`select select-btn ${className ?? ""}`}
        title={title ?? selected?.title}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={rest["aria-label"] ?? title}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKey}
      >
        <span className="select-value">{selected?.label ?? ""}</span>
        <svg className="select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={`select-pop ${pos.up ? "up" : ""}`}
            style={{ left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight }}
            onKeyDown={onListKey}
          >
            {searchable && (
              <input
                className="input select-search"
                autoFocus
                placeholder="Filter…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
              />
            )}
            <div
              ref={listRef}
              id={listId}
              className="select-list"
              role="listbox"
              tabIndex={-1}
              aria-activedescendant={shown[cursor] ? `${listId}-${cursor}` : undefined}
            >
              {shown.map((o, i) => (
                <div
                  key={o.value + i}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === current}
                  aria-disabled={o.disabled}
                  title={o.title}
                  className={`select-option ${i === cursor ? "cursor" : ""} ${o.value === current ? "chosen" : ""} ${o.disabled ? "disabled" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  <span className="select-check" aria-hidden>
                    {o.value === current && (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M2.5 6.2 5 8.5 9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="select-label">{o.label}</span>
                </div>
              ))}
              {shown.length === 0 && <div className="select-empty">No matches</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

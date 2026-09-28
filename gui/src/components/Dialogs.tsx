import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

type Dialog =
  | {
      type: "confirm";
      title: string;
      message: string;
      danger?: boolean;
      confirmLabel?: string;
      /** OK-only; no Cancel button. */
      alert?: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      type: "prompt";
      title: string;
      message: string;
      initial: string;
      inputType?: string;
      max?: number;
      resolve: (v: string | null) => void;
    }
  | {
      type: "error";
      title: string;
      message: string;
      resolve: () => void;
    };

interface Toast {
  id: number;
  message: string;
  tone: "ok" | "bad";
}

// Dialogs queue: an error raised while another dialog is open waits instead of replacing it
// (which would also leave that dialog's promise unresolved).
const useDialogs = create<{ queue: Dialog[]; toasts: Toast[] }>(() => ({
  queue: [],
  toasts: [],
}));
const show = (d: Dialog) => useDialogs.setState((s) => ({ queue: [...s.queue, d] }));

export function confirmDialog(opts: {
  title: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => show({ type: "confirm", ...opts, resolve }));
}

export function promptDialog(opts: {
  title: string;
  message: string;
  initial?: string;
  inputType?: string;
  /** Upper bound for inputType "range". */
  max?: number;
}): Promise<string | null> {
  return new Promise((resolve) => show({ type: "prompt", initial: "", ...opts, resolve }));
}

export function alertDialog(title: string, message: string): Promise<void> {
  return new Promise((resolve) => show({ type: "confirm", title, message, alert: true, confirmLabel: "OK", resolve: () => resolve() }));
}

/** The full text of an error, in a dialog it can be read and copied from. */
export function errorDialog(message: string, title = "Error"): Promise<void> {
  // The same failure repeated (e.g. a button clicked twice) shows once.
  const queued = useDialogs.getState().queue.find((d) => d.type === "error" && d.message === message);
  if (queued) return Promise.resolve();
  return new Promise((resolve) => show({ type: "error", title, message, resolve }));
}

let toastId = 0;
/** A passing notice; failures ("bad") open an error dialog with the whole message instead. */
export function toast(message: string, tone: "ok" | "bad" = "ok") {
  if (tone === "bad") {
    void errorDialog(message);
    return;
  }
  const id = ++toastId;
  useDialogs.setState((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
  setTimeout(
    () => useDialogs.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    3500,
  );
}

export function DialogHost() {
  const { queue, toasts } = useDialogs();
  const dialog = queue[0] ?? null;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog?.type === "prompt") {
      setValue(dialog.initial);
      setTimeout(() => (dialog.inputType === "range" ? inputRef.current?.focus() : inputRef.current?.select()), 0);
    } else if (dialog) {
      setTimeout(() => okRef.current?.focus(), 0);
    }
  }, [dialog]);

  const finish = (ok: boolean) => {
    if (!dialog) return;
    if (dialog.type === "confirm") dialog.resolve(ok);
    else if (dialog.type === "error") dialog.resolve();
    else dialog.resolve(ok ? value : null);
    useDialogs.setState((s) => ({ queue: s.queue.slice(1) }));
  };

  return (
    <>
      {dialog && (
        <div className="modal-backdrop" onMouseDown={() => finish(false)}>
          <form
            className={`modal ${dialog.type === "error" ? "modal-wide" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              finish(true);
            }}
            onKeyDown={(e) => e.key === "Escape" && finish(false)}
          >
            <h3>{dialog.title}</h3>
            {dialog.type === "error" ? <pre className="modal-error">{dialog.message}</pre> : <p>{dialog.message}</p>}
            {dialog.type === "prompt" && dialog.inputType === "range" ? (
              <div className="modal-slider">
                <input
                  ref={inputRef}
                  type="range"
                  min={0}
                  max={dialog.max ?? 10}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  // Range inputs don't implicitly submit on Enter.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      finish(true);
                    }
                  }}
                />
                <output>{value}</output>
              </div>
            ) : dialog.type === "prompt" && (
              <input
                ref={inputRef}
                className="input"
                // type=number can't be select()ed in WebKit, so use text + inputMode.
                type="text"
                inputMode={dialog.inputType === "number" ? "numeric" : undefined}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div className="modal-actions">
              {dialog.type === "error" && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigator.clipboard.writeText(dialog.message).then(() => toast("Copied"))}
                >
                  Copy
                </button>
              )}
              {dialog.type !== "error" && !(dialog.type === "confirm" && dialog.alert) && (
                <button type="button" className="btn" onClick={() => finish(false)}>
                  Cancel
                </button>
              )}
              <button
                ref={okRef}
                type="submit"
                className={`btn ${dialog.type === "confirm" && dialog.danger ? "btn-danger" : "btn-primary"}`}
              >
                {dialog.type === "confirm" ? dialog.confirmLabel ?? "Confirm" : "OK"}
              </button>
            </div>
          </form>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}

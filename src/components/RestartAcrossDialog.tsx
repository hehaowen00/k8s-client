import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, type KubeObject } from "../api";
import type { Target } from "../actions";
import { contextLabel } from "../store";
import { errorDialog, toast } from "./Dialogs";
import { Checkbox } from "./Checkbox";
import { S } from "../strings";

type Status =
  | { state: "checking" }
  | { state: "missing" }
  | { state: "found"; ready: string }
  | { state: "restarted" }
  | { state: "failed"; error: string };

const useDialog = create<{ target: Target | null }>(() => ({ target: null }));

/** Restart the object with the same kind, namespace and name in each chosen cluster. */
export function restartAcrossDialog(target: Target) {
  useDialog.setState({ target });
}

const readyOf = (o: KubeObject) =>
  S.restartAcross.ready(
    o.status?.readyReplicas ?? o.status?.numberReady ?? 0,
    o.spec?.replicas ?? o.status?.desiredNumberScheduled ?? 1,
  );

export function RestartAcrossDialogHost() {
  const target = useDialog((s) => s.target);
  const [rows, setRows] = useState<Record<string, Status>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const update = (ctx: string, s: Status) => !cancelled && setRows((r) => ({ ...r, [ctx]: s }));
    setRows({});
    setPicked(new Set([target.context]));
    setConfirming(false);
    api.listContexts().then(
      (contexts) => {
        if (cancelled) return;
        setRows(Object.fromEntries(contexts.map((c) => [c.name, { state: "checking" } as Status])));
        for (const c of contexts) {
          api.getObject({ ...target, context: c.name }).then(
            (o) => update(c.name, { state: "found", ready: readyOf(o) }),
            (e) =>
              update(
                c.name,
                /not ?found/i.test(String(e)) ? { state: "missing" } : { state: "failed", error: String(e) },
              ),
          );
        }
      },
      (e) => toast(String(e), "bad"),
    );
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;
  const close = () => !busy && useDialog.setState({ target: null });
  const chosen = [...picked].filter((c) => rows[c]?.state === "found");
  const found = Object.keys(rows).filter((c) => rows[c].state === "found");
  const toggle = (ctx: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(ctx);
      else n.delete(ctx);
      return n;
    });

  const submit = async () => {
    setBusy(true);
    const results = await Promise.allSettled(chosen.map((ctx) => api.restartResource({ ...target, context: ctx })));
    const failed: string[] = [];
    results.forEach((r, i) => {
      const ctx = chosen[i];
      if (r.status === "fulfilled") setRows((s) => ({ ...s, [ctx]: { state: "restarted" } }));
      else {
        setRows((s) => ({ ...s, [ctx]: { state: "failed", error: String(r.reason) } }));
        failed.push(`${contextLabel(ctx)}: ${r.reason}`);
      }
    });
    setPicked(new Set());
    setConfirming(false);
    setBusy(false);
    const done = chosen.length - failed.length;
    if (done) toast(S.restartAcross.restarted(target.name, done));
    if (failed.length) errorDialog(failed.join("\n"), S.restartAcross.failed(failed.length));
  };

  const kind = target.resource.kind.toLowerCase();
  const objName = `${target.namespace ? `${target.namespace}/` : ""}${target.name}`;
  const describe = (s: Status | undefined) => {
    switch (s?.state) {
      case "found":
        return s.ready;
      case "missing":
        return S.restartAcross.notFound;
      case "restarted":
        return S.restartAcross.restartedState;
      case "failed":
        return s.error;
      default:
        return S.restartAcross.checking;
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal modal-wide"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirming) submit();
          else setConfirming(true);
        }}
        onKeyDown={(e) => e.key === "Escape" && (confirming && !busy ? setConfirming(false) : close())}
      >
        {confirming ? (
          <>
            <h3>{S.restartAcross.confirmTitle}</h3>
            <p>{S.restartAcross.confirmMessage(chosen.length, kind)}</p>
            <div className="folders restart-across">
              {chosen.map((ctx) => (
                <div key={ctx} className="folder-row">
                  <span>
                    {contextLabel(ctx)}
                    <span className="mono small muted restart-obj">{objName}</span>
                  </span>
                  <span className="small muted">{describe(rows[ctx])}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                {S.common.back}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !chosen.length} autoFocus>
                {busy ? S.restartAcross.restarting : S.restartAcross.restartN(chosen.length)}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>{S.restartAcross.title}</h3>
            <p>{S.restartAcross.message(kind, objName)}</p>
            <div className="swatches restart-tools">
              <button
                type="button"
                className="btn btn-xs"
                disabled={busy || !found.length}
                onClick={() => setPicked(new Set(found))}
              >
                {S.common.selectAll}
              </button>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={busy || !picked.size}
                onClick={() => setPicked(new Set())}
              >
                {S.common.clearAll}
              </button>
            </div>
            <div className="folders restart-across">
              {Object.entries(rows).map(([ctx, s]) => (
                <div key={ctx} className="folder-row">
                  <Checkbox
                    checked={picked.has(ctx)}
                    disabled={busy || s.state !== "found"}
                    onChange={(e) => toggle(ctx, e.target.checked)}
                  >
                    {contextLabel(ctx)}
                  </Checkbox>
                  <span
                    className={`small ${s.state === "failed" ? "mcp-bad" : "muted"}`}
                    title={s.state === "failed" ? s.error : undefined}
                  >
                    {describe(s)}
                  </span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={close} disabled={busy}>
                {S.common.close}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!chosen.length}>
                {S.restartAcross.review(chosen.length)}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

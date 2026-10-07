import { shortcut } from "../keys";
import { useState } from "react";
import { api } from "../api";
import { useNamespaces } from "../hooks";
import { useContexts } from "../settings";
import { useTabs, type Tab, contextLabel } from "../store";
import { YamlEditor } from "../components/YamlEditor";
import { confirmDialog, toast } from "../components/Dialogs";
import { TEMPLATES } from "../templates";
import { Select } from "../components/Select";

const SAMPLE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  hello: world
`;

// Drafts used to be stored per tab and were never removed.
try {
  for (const k of Object.keys(localStorage)) if (k.startsWith("kubetab.pref.apply.draft.")) localStorage.removeItem(k);
} catch {
  /* ignore */
}

export function ApplyView({ tab }: { tab: Extract<Tab, { kind: "apply" }> }) {
  const update = useTabs((s) => s.update);
  const contexts = useContexts();
  const context = tab.context ?? contexts.data?.find((c) => c.current)?.name ?? contexts.data?.[0]?.name ?? null;
  const namespaces = useNamespaces(context);
  const [draft, setDraft] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);

  const apply = async () => {
    if (!context) return;
    setBusy(true);
    setResult(null);
    try {
      const applied = await api.applyManifest(context, draft, tab.namespace);
      setResult({ ok: true, lines: applied.map((a) => `${a} applied`) });
      toast(`Applied ${applied.length} object${applied.length === 1 ? "" : "s"}`);
    } catch (e) {
      setResult({ ok: false, lines: [String(e)] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="apply-view">
      <div className="toolbar">
        <h2 className="toolbar-title">Apply Manifest</h2>
        <Select
          className="select"
          value={context ?? ""}
          onChange={(e) => update(tab.id, { context: e.target.value, namespace: null })}
        >
          {contexts.data?.map((c) => (
            <option key={c.name} value={c.name} title={c.name}>
              {contextLabel(c.name)}
            </option>
          ))}
        </Select>
        <Select
          className="select"
          value={tab.namespace ?? ""}
          onChange={(e) => update(tab.id, { namespace: e.target.value || null })}
          title="Default namespace for objects without metadata.namespace"
        >
          <option value="">(default namespace)</option>
          {namespaces.data?.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        <Select
          className="select"
          value=""
          title="Start from a template"
          onChange={async (e) => {
            const t = TEMPLATES[e.target.value];
            if (!t) return;
            if (draft.trim() && draft !== t) {
              const ok = await confirmDialog({ title: "Replace editor contents?", message: `Load the ${e.target.value} template?`, confirmLabel: "Load" });
              if (!ok) return;
            }
            setDraft(t);
          }}
        >
          <option value="">Template</option>
          {Object.keys(TEMPLATES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <div className="spacer" />
        <span className="muted small">Server-side apply · {shortcut("S")}</span>
        <button className="btn btn-sm btn-primary" disabled={!context || busy} onClick={apply}>
          {busy ? "Applying…" : "Apply"}
        </button>
      </div>
      {result && (
        <div className={result.ok ? "ok-box" : "error-box"}>
          {result.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
      <YamlEditor value={draft} onChange={setDraft} onSave={apply} />
    </div>
  );
}

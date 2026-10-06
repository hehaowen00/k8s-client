import { useState } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "./Dialogs";
import { YamlEditor } from "./YamlEditor";
import { bumpContexts } from "../settings";

const useDialog = create<{ open: boolean; onAdded?: (contexts: string[]) => void }>(() => ({ open: false }));

export function addClusterDialog(onAdded?: (contexts: string[]) => void) {
  useDialog.setState({ open: true, onAdded });
}

/** Paste a kubeconfig; it's saved into Kube Portal's own folder (not your ~/.kube/config). */
export function AddClusterDialogHost() {
  const { open, onAdded } = useDialog();
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const close = () => {
    useDialog.setState({ open: false });
    setYaml("");
    setName("");
  };
  const add = async () => {
    setBusy(true);
    try {
      const contexts = await invoke<string[]>("add_kubeconfig", { name: name || "cluster", yaml });
      toast(`Added ${contexts.length} context${contexts.length === 1 ? "" : "s"}`);
      bumpContexts();
      onAdded?.(contexts);
      close();
    } catch (e) {
      toast(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <h3>Add cluster</h3>
        <p>Paste a kubeconfig. It's stored privately in Kube Portal's config folder; your ~/.kube/config isn't modified.</p>
        <label className="field">
          <span>Name</span>
          <input className="input" placeholder="my-cluster" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="paste-editor">
          <YamlEditor value={yaml} onChange={setYaml} onSave={add} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !yaml.trim()} onClick={add}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

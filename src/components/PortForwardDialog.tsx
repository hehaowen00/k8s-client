import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { toast } from "./Dialogs";
import { Select } from "./Select";
import { Checkbox } from "./Checkbox";
import { S } from "../strings";

export interface PortChoice {
  port: number;
  label: string;
}

interface Request {
  context: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  ports: PortChoice[];
  initial?: number;
}

const useDialog = create<{ req: Request | null }>(() => ({ req: null }));

export function portForwardDialog(req: Request) {
  if (!req.ports.length) return toast(S.portForward.noPorts(req.name), "bad");
  useDialog.setState({ req });
}

const looksHttp = (p: PortChoice) =>
  /http|web|ui|grpc-web/i.test(p.label) || [80, 443, 3000, 5000, 8000, 8080, 8443, 9090].includes(p.port);

export function PortForwardDialogHost() {
  const req = useDialog((s) => s.req);
  const [remote, setRemote] = useState(0);
  const [local, setLocal] = useState("");
  const [browser, setBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const localRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!req) return;
    const first = req.ports.find((p) => p.port === req.initial) ?? req.ports[0];
    setRemote(first.port);
    setLocal("");
    setBrowser(looksHttp(first));
    setTimeout(() => localRef.current?.focus(), 0);
  }, [req]);

  if (!req) return null;
  const close = () => useDialog.setState({ req: null });
  const submit = async () => {
    const localPort = local.trim() ? Number(local) : null;
    if (localPort !== null && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) {
      return toast(S.portForward.badLocalPort, "bad");
    }
    setBusy(true);
    try {
      const f = await api.startPortForward({ ...req, remotePort: remote, localPort });
      toast(S.portForward.forwarding(f.localPort, `${req.kind}/${req.name}:${remote}`));
      if (browser) openUrl(`http://localhost:${f.localPort}`).catch((e) => toast(String(e), "bad"));
      close();
    } catch (e) {
      toast(String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <h3>{S.portForward.title}</h3>
        <p>{S.portForward.target(`${req.kind}/${req.name}`, req.namespace)}</p>
        <label className="field">
          <span>{S.portForward.remotePort}</span>
          <Select
            className="select"
            value={remote}
            onChange={(e) => {
              const p = req.ports.find((x) => x.port === Number(e.target.value))!;
              setRemote(p.port);
              setBrowser(looksHttp(p));
            }}
          >
            {req.ports.map((p) => (
              <option key={p.port} value={p.port}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span>{S.portForward.localPort}</span>
          <input
            ref={localRef}
            className="input"
            inputMode="numeric"
            placeholder={S.portForward.automatic}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        </label>
        <Checkbox checked={browser} onChange={(e) => setBrowser(e.target.checked)} className="field-check">
          {S.portForward.openInBrowser}
        </Checkbox>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>
            {S.common.cancel}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? S.portForward.starting : S.common.start}
          </button>
        </div>
      </form>
    </div>
  );
}

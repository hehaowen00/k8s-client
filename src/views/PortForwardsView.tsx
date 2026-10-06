import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type ForwardInfo } from "../api";
import { toast } from "../components/Dialogs";
import { contextColor, contextLabel } from "../store";

export function PortForwardsView({ active }: { active: boolean }) {
  const [list, setList] = useState<ForwardInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    const load = () => api.listPortForwards().then(setList, () => {});
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [active]);

  return (
    <div className="pf-view">
      <div className="toolbar">
        <h2 className="toolbar-title">
          Port Forwards <span className="muted small">{list.length}</span>
        </h2>
        <span className="muted small">Start one from a pod or service (right-click → Port Forward)</span>
        <div className="spacer" />
        {list.length > 0 && (
          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={async () => {
              for (const f of list) await api.stopPortForward(f.id);
              setList([]);
            }}
          >
            Stop all
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="empty">No active port forwards</div>
      ) : (
        <table className="dtable pf-table">
          <thead>
            <tr>
              <th>Local</th>
              <th>Target</th>
              <th>Namespace</th>
              <th>Cluster</th>
              <th>Connections</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((f) => {
              const url = `http://localhost:${f.localPort}`;
              return (
                <tr key={f.id}>
                  <td>
                    <button className="link mono" onClick={() => openUrl(url).catch((e) => toast(String(e), "bad"))}>
                      localhost:{f.localPort}
                    </button>
                  </td>
                  <td>
                    {f.kind}/{f.name}:{f.remotePort}
                    {f.kind === "service" && f.lastPod && <div className="muted small">via {f.lastPod}</div>}
                  </td>
                  <td>{f.namespace}</td>
                  <td>
                    <span className="tab-dot inline" style={{ background: contextColor(f.context) }} />{" "}
                    {contextLabel(f.context)}
                  </td>
                  <td>
                    {f.activeConnections} open · {f.connections} total
                  </td>
                  <td className="wrap">
                    {f.lastError ? <span className="tone-warn">{f.lastError}</span> : <span className="tone-ok">Active</span>}
                  </td>
                  <td className="pf-actions">
                    <button className="btn btn-xs" onClick={() => openUrl(url).catch((e) => toast(String(e), "bad"))}>
                      Open
                    </button>
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() => navigator.clipboard.writeText(`localhost:${f.localPort}`).then(() => toast("Copied"))}
                    >
                      Copy
                    </button>
                    <button className="btn btn-xs btn-danger-ghost" onClick={() => api.stopPortForward(f.id).then(setList)}>
                      Stop
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

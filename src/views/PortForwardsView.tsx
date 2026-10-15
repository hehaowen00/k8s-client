import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { toast } from "../components/Dialogs";
import { setPortForwards, stopPortForward, usePortForwards } from "../hooks";
import { contextColor, contextLabel } from "../store";
import { S } from "../strings";

export function PortForwardsView({ active }: { active: boolean }) {
  const list = usePortForwards(active);

  return (
    <div className="pf-view">
      <div className="toolbar">
        <h2 className="toolbar-title">
          {S.portForward.listTitle} <span className="muted small">{list.length}</span>
        </h2>
        <span className="muted small">{S.portForward.listHint}</span>
        <div className="spacer" />
        {list.length > 0 && (
          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={async () => {
              for (const f of list) await api.stopPortForward(f.id);
              setPortForwards([]);
            }}
          >
            {S.portForward.stopAll}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="empty">{S.portForward.none}</div>
      ) : (
        <table className="dtable pf-table">
          <thead>
            <tr>
              <th>{S.portForward.colLocal}</th>
              <th>{S.portForward.colTarget}</th>
              <th>{S.portForward.colNamespace}</th>
              <th>{S.portForward.colCluster}</th>
              <th>{S.portForward.colConnections}</th>
              <th>{S.portForward.colStatus}</th>
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
                    {f.kind === "service" && f.lastPod && (
                      <div className="muted small">{S.portForward.via(f.lastPod)}</div>
                    )}
                  </td>
                  <td>{f.namespace}</td>
                  <td>
                    <span className="tab-dot inline" style={{ background: contextColor(f.context) }} />{" "}
                    {contextLabel(f.context)}
                  </td>
                  <td>{S.portForward.connections(f.activeConnections, f.connections)}</td>
                  <td className="wrap">
                    {f.lastError ? (
                      <span className="tone-warn">{f.lastError}</span>
                    ) : (
                      <span className="tone-ok">{S.portForward.active}</span>
                    )}
                  </td>
                  <td className="pf-actions">
                    <button className="btn btn-xs" onClick={() => openUrl(url).catch((e) => toast(String(e), "bad"))}>
                      {S.common.open}
                    </button>
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() =>
                        navigator.clipboard.writeText(`localhost:${f.localPort}`).then(() => toast(S.common.copied))
                      }
                    >
                      {S.common.copy}
                    </button>
                    <button
                      className="btn btn-xs btn-danger-ghost"
                      onClick={() => stopPortForward(f.id).catch((e) => toast(String(e), "bad"))}
                    >
                      {S.common.stop}
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

import { shortcut } from "../keys";
import { dock, tabTitle, type DockHost } from "../store";
import { LogsView } from "../views/LogsView";
import { TerminalView } from "../views/TerminalView";
import { openContextMenu } from "./ContextMenu";
import { S } from "../strings";

const ICON = { logs: "≡", exec: "›_", terminal: "$" } as const;
const BAR = 32;

/** Bottom dock of a workspace tab: its own sub-tabs of logs, shells and terminals. */
export function Dock({ host, active }: { host: DockHost; active: boolean }) {
  const d = host.dock;
  if (!d || d.items.length === 0) return null;
  const open = d.open;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = d.height;
    const max = window.innerHeight - 160;
    const move = (ev: MouseEvent) =>
      dock.setHeight(host.id, Math.min(max, Math.max(120, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="dock" style={{ height: open ? d.height : BAR }}>
      {open && <div className="dock-resize" onMouseDown={startResize} title={S.common.dragToResize} />}
      <div className="dock-bar" onDoubleClick={(e) => e.target === e.currentTarget && dock.setOpen(host.id, !open)}>
        <div className="dock-tabs">
          {d.items.map((item) => (
            <div
              key={item.id}
              className={`dock-tab ${item.id === d.activeId ? "active" : ""}`}
              title={tabTitle(item)}
              onMouseDown={(e) => e.button === 0 && dock.activate(host.id, item.id)}
              onAuxClick={(e) => e.button === 1 && dock.close(host.id, item.id)}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: S.common.openInNewTab, onClick: () => dock.popOut(host.id, item.id) },
                  { separator: true, label: "" },
                  { label: S.common.close, onClick: () => dock.close(host.id, item.id) },
                  { label: S.common.closeOthers, onClick: () => dock.closeOthers(host.id, item.id) },
                  { label: S.common.closeAll, onClick: () => dock.closeAll(host.id) },
                ])
              }
            >
              <span className="tab-icon">{ICON[item.kind]}</span>
              <span className="tab-title">{tabTitle(item)}</span>
              <button
                className="tab-close"
                aria-label={S.common.close}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => dock.close(host.id, item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="dock-actions">
          {d.activeId && (
            <button
              className="btn btn-xs btn-ghost"
              title={S.dock.popOut}
              onClick={() => dock.popOut(host.id, d.activeId!)}
            >
              ⧉
            </button>
          )}
          <button
            className="btn btn-xs btn-ghost"
            title={S.dock.toggle(open, shortcut("J"))}
            onClick={() => dock.setOpen(host.id, !open)}
          >
            {open ? "▾" : "▴"}
          </button>
          <button className="btn btn-xs btn-ghost" title={S.common.closeAll} onClick={() => dock.closeAll(host.id)}>
            ✕
          </button>
        </div>
      </div>
      {/* Items stay mounted while minimised so streams and shells keep running. */}
      <div className="dock-body" style={{ display: open ? "flex" : "none" }}>
        {d.items.map((item) => {
          const visible = active && open && item.id === d.activeId;
          const onUpdate = (patch: object) => dock.update(host.id, item.id, patch);
          return (
            <div key={item.id} className="dock-pane" style={{ display: item.id === d.activeId ? "flex" : "none" }}>
              {item.kind === "logs" ? (
                <LogsView tab={item} active={visible} onUpdate={onUpdate} />
              ) : (
                <TerminalView tab={item} active={visible} onUpdate={onUpdate} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

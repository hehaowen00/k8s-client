import { useRef, useState } from "react";
import { contextColor, tabContext, tabTitle, useTabs, type Tab, contextLabel } from "../store";
import { openContextMenu } from "./ContextMenu";

const ICONS: Record<Tab["kind"], string> = {
  home: "⌂",
  cluster: "☸",
  detail: "◇",
  logs: "≡",
  exec: "›_",
  terminal: "$",
  apply: "⇪",
  portforwards: "⇄",
  settings: "⚙",
};

export function TabBar() {
  const { tabs, activeId, splitId, setSplit, activate, close, closeOthers, closeRight, open, move } = useTabs();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const duplicate = (t: Tab) => {
    const { id: _id, ...rest } = t;
    open(rest as never, { after: t.id });
  };

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div
        className="tabstrip"
        ref={stripRef}
        onWheel={(e) => {
          if (stripRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            stripRef.current.scrollLeft += e.deltaY;
          }
        }}
      >
        {tabs.map((t, i) => {
          // The "New Tab" page lives behind the + button, not in the strip.
          if (t.kind === "home") return null;
          const ctx = tabContext(t);
          return (
            <div
              key={t.id}
              className={`tab ${t.id === activeId ? "active" : ""} ${t.id === splitId ? "split" : ""} ${overIdx === i && dragIdx !== i ? "drop-target" : ""}`}
              title={ctx && t.kind !== "cluster" ? `${tabTitle(t)} — ${contextLabel(ctx)}` : tabTitle(t)}
              draggable
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIdx(i);
              }}
              onDragLeave={() => setOverIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && dragIdx !== i) move(dragIdx, i);
                setDragIdx(null);
                setOverIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
              onMouseDown={(e) => {
                if (e.button === 0) activate(t.id);
              }}
              onClick={() => activate(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  close(t.id);
                }
              }}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Duplicate Tab", onClick: () => duplicate(t) },
                  t.id === splitId
                    ? { label: "Close Split", hint: "Ctrl+\\", onClick: () => setSplit(null) }
                    : { label: "Open in Right Split", hint: "Ctrl+\\", disabled: t.id === activeId, onClick: () => setSplit(t.id) },
                  { separator: true, label: "" },
                  { label: "Close", hint: "Ctrl+W", onClick: () => close(t.id) },
                  { label: "Close Other Tabs", onClick: () => closeOthers(t.id) },
                  { label: "Close Tabs to the Right", onClick: () => closeRight(t.id) },
                ])
              }
            >
              {ctx && <span className="tab-dot" style={{ background: contextColor(ctx) }} />}
              <span className="tab-icon">{ICONS[t.kind]}</span>
              <span className="tab-title">{tabTitle(t)}</span>
              <button
                className="tab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => close(t.id)}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        className={`tab-new ${tabs.find((t) => t.id === activeId)?.kind === "home" ? "active" : ""}`}
        title="New tab (Ctrl+T)"
        onClick={() => open({ kind: "home" })}>
        +
      </button>
    </div>
  );
}

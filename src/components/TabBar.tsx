import { useShallow } from "zustand/react/shallow";
import { shortcut } from "../keys";
import { useEffect, useRef, useState } from "react";
import { contextColor, tabContext, tabTitle, useTabs, type Tab, contextLabel } from "../store";
import { openContextMenu } from "./ContextMenu";
import { S } from "../strings";

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
  "cluster-settings": "⚙",
};

// Only macOS draws the window under the tab bar (overlay titlebar); elsewhere the native
// titlebar stays, so the bar must not act as one.
const OVERLAY_TITLEBAR = navigator.userAgent.includes("Mac");

export function TabBar() {
  const { tabs, activeId, leftId, splitId } = useTabs(
    useShallow((s) => ({ tabs: s.tabs, activeId: s.activeId, leftId: s.leftId, splitId: s.splitId })),
  );
  const inSplit = (id: string) => !!splitId && (id === leftId || id === splitId);
  const setSplit = useTabs((s) => s.setSplit);
  const activate = useTabs((s) => s.activate);
  const close = useTabs((s) => s.close);
  const closeOthers = useTabs((s) => s.closeOthers);
  const closeRight = useTabs((s) => s.closeRight);
  const open = useTabs((s) => s.open);
  const move = useTabs((s) => s.move);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // Where the dragged tab would land: before or after the tab at `idx`.
  const [over, setOver] = useState<{ idx: number; after: boolean } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const endDrag = () => {
    setDragIdx(null);
    setOver(null);
  };

  // The webview doesn't reliably deliver dragend to the source tab (drops outside the window,
  // cancelled drags), so any later press clears a stale drag.
  useEffect(() => {
    const events = ["dragend", "drop", "pointerdown"] as const;
    events.forEach((ev) => window.addEventListener(ev, endDrag));
    return () => events.forEach((ev) => window.removeEventListener(ev, endDrag));
  }, []);

  const halfOf = (e: React.DragEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX > box.left + box.width / 2;
  };

  // Index of the neighbouring strip tab (the home tab isn't shown), or -1.
  const neighbour = (i: number, after: boolean) => {
    for (let j = after ? i + 1 : i - 1; j >= 0 && j < tabs.length; j += after ? 1 : -1) {
      if (tabs[j].kind !== "home") return j;
    }
    return -1;
  };

  // Dropping on the dragged tab's own edges wouldn't move it, so don't promise a move.
  const wouldMove = (i: number, after: boolean) => dragIdx !== null && dragIdx !== i && neighbour(i, after) !== dragIdx;

  const drop = (i: number, after: boolean) => {
    const from = dragIdx;
    const moves = wouldMove(i, after);
    endDrag();
    if (from === null || !moves) return;
    let to = after ? i + 1 : i;
    if (from < to) to -= 1;
    move(from, to);
  };

  const duplicate = (t: Tab) => {
    const { id: _id, ...rest } = t;
    open(rest as never, { after: t.id });
  };

  return (
    <div className="tabbar" data-tauri-drag-region={OVERLAY_TITLEBAR || undefined}>
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
              className={`tab ${t.id === activeId ? "active" : ""} ${t.id !== activeId && inSplit(t.id) ? "split" : ""} ${dragIdx === i ? "dragging" : ""} ${over?.idx === i ? (over.after ? "drop-after" : "drop-before") : ""}`}
              title={ctx && t.kind !== "cluster" ? `${tabTitle(t)} — ${contextLabel(ctx)}` : tabTitle(t)}
              draggable
              onDragStart={(e) => {
                // Snapshot the tab where it was grabbed, before the dimmed class lands.
                const box = e.currentTarget.getBoundingClientRect();
                e.dataTransfer.setDragImage(e.currentTarget, e.clientX - box.left, e.clientY - box.top);
                e.dataTransfer.setData("text/plain", t.id);
                e.dataTransfer.effectAllowed = "move";
                setDragIdx(i);
              }}
              onDragOver={(e) => {
                if (dragIdx === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const after = halfOf(e);
                setOver(wouldMove(i, after) ? { idx: i, after } : null);
              }}
              onDragLeave={() => {
                if (over?.idx === i) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(i, halfOf(e));
              }}
              onDragEnd={endDrag}
              onPointerDown={(e) => {
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
                  { label: S.tabs.duplicate, onClick: () => duplicate(t) },
                  inSplit(t.id)
                    ? { label: S.tabs.closeSplit, hint: shortcut("\\"), onClick: () => setSplit(null) }
                    : {
                        label: S.tabs.openInSplit,
                        hint: shortcut("\\"),
                        disabled: t.id === (splitId ? leftId : activeId),
                        onClick: () => setSplit(t.id),
                      },
                  { separator: true, label: "" },
                  { label: S.common.close, hint: shortcut("W"), onClick: () => close(t.id) },
                  { label: S.tabs.closeOthers, onClick: () => closeOthers(t.id) },
                  { label: S.tabs.closeRight, onClick: () => closeRight(t.id) },
                ])
              }
            >
              {ctx && <span className="tab-dot" style={{ background: contextColor(ctx) }} />}
              <span className="tab-icon">{ICONS[t.kind]}</span>
              <span className="tab-title">{tabTitle(t)}</span>
              <button
                className="tab-close"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => close(t.id)}
                aria-label={S.tabs.closeTab}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        className={`tab-new ${tabs.find((t) => t.id === activeId)?.kind === "home" ? "active" : ""}`}
        title={S.tabs.newTabHint(shortcut("T"))}
        onClick={() => open({ kind: "home" })}
      >
        +
      </button>
    </div>
  );
}

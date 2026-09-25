import { useState } from "react";
import { useSettings, NO_CLUSTERS } from "../settings";
import { usePref } from "../hooks";
import { contextColor, contextIcon, contextLabel, openCluster, openSingleton, tabContext, useTabs } from "../store";
import { openContextMenu } from "./ContextMenu";

/** Pinned clusters rail (Lens "hotbar"). Hidden until something is pinned. */
export function Hotbar() {
  const clusters = useSettings((s) => s.settings?.clusters ?? NO_CLUSTERS);
  const updateCluster = useSettings((s) => s.updateCluster);
  const activeContext = useTabs((s) => {
    const t = s.tabs.find((x) => x.id === s.activeId);
    return t ? tabContext(t) : null;
  });
  const [order, setOrder] = usePref<string[]>("hotbar.order", []);
  const [dragCtx, setDragCtx] = useState<string | null>(null);
  const [overCtx, setOverCtx] = useState<string | null>(null);
  // Newly pinned clusters (not in the saved order yet) go last.
  const rank = (ctx: string) => (order.includes(ctx) ? order.indexOf(ctx) : Infinity);
  const pinned = Object.entries(clusters)
    .filter(([, c]) => c.pinned)
    .map(([ctx]) => ctx)
    .sort((a, b) => rank(a) - rank(b));
  if (!pinned.length) return null;
  const drop = (target: string) => {
    if (dragCtx && dragCtx !== target) {
      const next = pinned.filter((c) => c !== dragCtx);
      next.splice(pinned.indexOf(target), 0, dragCtx);
      setOrder(next);
    }
    setDragCtx(null);
    setOverCtx(null);
  };
  return (
    <nav className="hotbar" aria-label="Pinned clusters">
      {pinned.map((ctx) => {
        const label = contextLabel(ctx);
        return (
          <button
            key={ctx}
            className={`hotbar-item ${activeContext === ctx ? "active" : ""} ${overCtx === ctx && dragCtx !== ctx ? "drop-target" : ""}`}
            style={{ background: contextColor(ctx) }}
            title={label}
            draggable
            onDragStart={(e) => {
              setDragCtx(ctx);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverCtx(ctx);
            }}
            onDragLeave={() => setOverCtx(null)}
            onDrop={(e) => {
              e.preventDefault();
              drop(ctx);
            }}
            onDragEnd={() => {
              setDragCtx(null);
              setOverCtx(null);
            }}
            onClick={(e) => openCluster(ctx, { focusExisting: !(e.ctrlKey || e.metaKey), background: e.ctrlKey || e.metaKey })}
            onAuxClick={(e) => e.button === 1 && openCluster(ctx, { background: true })}
            onContextMenu={(e) =>
              openContextMenu(e, [
                { label: "Open in New Tab", onClick: () => openCluster(ctx) },
                { label: "Cluster Settings…", onClick: () => useTabs.getState().open({ kind: "settings", context: ctx }) },
                { separator: true, label: "" },
                { label: "Unpin", onClick: () => updateCluster(ctx, { pinned: false }) },
              ])
            }
          >
            {!contextIcon(ctx) && (label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?")}
          </button>
        );
      })}
      <div className="spacer" />
      <button className="hotbar-tool" title="Settings (Ctrl+,)" onClick={() => openSingleton("settings")}>
        ⚙
      </button>
    </nav>
  );
}

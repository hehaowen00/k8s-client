import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { TabBar } from "./components/TabBar";
import { ContextMenuHost } from "./components/ContextMenu";
import { DialogHost } from "./components/Dialogs";
import { useTabs, type Tab } from "./store";
import { HomeView } from "./views/HomeView";
import { ClusterView } from "./views/ClusterView";
import { DetailTab } from "./views/DetailView";
import { LogsView } from "./views/LogsView";
import { TerminalView } from "./views/TerminalView";
import { ApplyView } from "./views/ApplyView";
import { PortForwardsView } from "./views/PortForwardsView";
import { PortForwardDialogHost } from "./components/PortForwardDialog";
import { AddClusterDialogHost } from "./components/AddClusterDialog";
import { Hotbar } from "./components/Hotbar";
import { ClusterSettingsView, SettingsView } from "./views/SettingsView";
import { useResolvedTheme, useSettings, useSettingsBootstrap } from "./settings";
import { dock, isDockHost, openSingleton } from "./store";
import { CommandPaletteHost, openPalette } from "./components/CommandPalette";
import { usePref } from "./hooks";
import { loadExtensions } from "./extensions";

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "home":
      return <HomeView tab={tab} />;
    case "cluster":
      return <ClusterView tab={tab} active={active} />;
    case "detail":
      return <DetailTab tab={tab} active={active} />;
    case "logs":
      return <LogsView tab={tab} active={active} />;
    case "exec":
    case "terminal":
      return <TerminalView tab={tab} active={active} />;
    case "apply":
      return <ApplyView tab={tab} />;
    case "portforwards":
      return <PortForwardsView active={active} />;
    case "settings":
      return <SettingsView />;
    case "cluster-settings":
      return <ClusterSettingsView tab={tab} />;
  }
}

export default function App() {
  const { tabs, activeId, splitId, open, close, cycle, activate, toggleSplit } = useTabs();
  const [savedRatio, saveRatio] = usePref("split.ratio", 0.5);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const splitRatio = dragRatio ?? savedRatio;
  const split = splitId && splitId !== activeId && tabs.some((t) => t.id === splitId) ? splitId : null;
  useSettingsBootstrap();
  useEffect(() => {
    loadExtensions();
  }, []);
  useEffect(() => {
    const un = listen("open-settings", () => openSingleton("settings"));
    return () => {
      un.then((f) => f());
    };
  }, []);
  // Re-render on settings changes (display names / colours are read from the store).
  useSettings((s) => s.settings);
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Always keep at least one tab open.
  useEffect(() => {
    if (tabs.length === 0) open({ kind: "home" });
    else if (!tabs.some((t) => t.id === activeId)) activate(tabs[0].id);
  }, [tabs, activeId, open, activate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const { tabs, activeId } = useTabs.getState();
      if ((e.key === "P" || e.key === "p") && e.shiftKey) {
        e.preventDefault();
        openPalette();
      } else if (e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        openPalette();
      } else if (e.key === "\\") {
        e.preventDefault();
        toggleSplit();
      } else if (e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        open({ kind: "home" });
      } else if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (activeId) close(activeId);
      } else if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        cycle(1);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        cycle(-1);
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        e.preventDefault();
        const n = Number(e.key);
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) activate(target.id);
      } else if (e.key === "j" && !e.shiftKey) {
        // Toggle the active workspace's dock.
        e.preventDefault();
        const host = tabs.find((t) => t.id === activeId);
        if (isDockHost(host) && host.dock?.items.length) dock.setOpen(host.id, !host.dock.open);
      } else if (e.key === ",") {
        e.preventDefault();
        openSingleton("settings");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, cycle, activate, toggleSplit]);

  return (
    <div className="app">
      <TabBar />
      <div className="app-body">
        <Hotbar />
        <div className={`tab-panels ${split ? "is-split" : ""}`}>
          {tabs.map((t) => {
            const left = t.id === activeId;
            const right = t.id === split;
            const style: React.CSSProperties = !left && !right
              ? { display: "none" }
              : split
                ? left
                  ? { display: "flex", right: `${(1 - splitRatio) * 100}%` }
                  : { display: "flex", left: `${splitRatio * 100}%` }
                : { display: "flex" };
            return (
              <div key={t.id} className={`tab-panel ${right ? "split-pane" : ""}`} style={style} onMouseDown={() => right && activate(t.id)}>
                <TabContent tab={t} active={left || right} />
              </div>
            );
          })}
          {split && (
            <div
              className="split-divider"
              style={{ left: `calc(${splitRatio * 100}% - 3px)` }}
              onMouseDown={(e) => {
                e.preventDefault();
                const host = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                let ratio = savedRatio;
                const move = (ev: MouseEvent) => {
                  ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - host.left) / host.width));
                  setDragRatio(ratio);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  saveRatio(ratio);
                  setDragRatio(null);
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
            />
          )}
        </div>
      </div>
      <ContextMenuHost />
      <DialogHost />
      <PortForwardDialogHost />
      <AddClusterDialogHost />
      <CommandPaletteHost />
    </div>
  );
}

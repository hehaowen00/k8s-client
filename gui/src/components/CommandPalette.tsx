import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, type ContextInfo, type ResourceInfo } from "../api";
import { loadDiscovery } from "../hooks";
import { useSettings } from "../settings";
import { useExtensions } from "../extensions";
import { contextLabel, openCluster, openSession, openSingleton, pluralLabel, tabContext, tabTitle, useTabs } from "../store";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

const usePalette = create<{ open: boolean }>(() => ({ open: false }));
export const openPalette = () => usePalette.setState({ open: true });

/** Subsequence fuzzy match; lower score is better, null = no match. */
function score(q: string, text: string): number | null {
  if (!q) return 0;
  const t = text.toLowerCase();
  let pos = 0;
  let gaps = 0;
  for (const ch of q.toLowerCase()) {
    const i = t.indexOf(ch, pos);
    if (i < 0) return null;
    gaps += i - pos;
    pos = i + 1;
  }
  return gaps + (t.startsWith(q.toLowerCase()) ? -50 : 0) + (t.includes(q.toLowerCase()) ? -20 : 0);
}

export function CommandPaletteHost() {
  const open = usePalette((s) => s.open);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [contexts, setContexts] = useState<ContextInfo[]>([]);
  const [resources, setResources] = useState<ResourceInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const active = tabs.find((t) => t.id === activeId);
  const activeCtx = active ? tabContext(active) : null;

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    api.listContexts().then(setContexts, () => setContexts([]));
    if (activeCtx) loadDiscovery(activeCtx).then(setResources, () => setResources([]));
    else setResources([]);
  }, [open, activeCtx]);

  const commands = useMemo<Command[]>(() => {
    const T = useTabs.getState();
    const cmds: Command[] = [];
    const clusterTab = active?.kind === "cluster" ? active : null;
    if (clusterTab) {
      cmds.push({ id: "ov", group: "Go to", label: "Overview", run: () => T.update(clusterTab.id, { resource: null, page: undefined }) });
      cmds.push({ id: "hr", group: "Go to", label: "Helm Releases", run: () => T.update(clusterTab.id, { resource: null, page: "releases" }) });
      cmds.push({ id: "hc", group: "Go to", label: "Helm Charts", run: () => T.update(clusterTab.id, { resource: null, page: "charts" }) });
      for (const r of resources) {
        cmds.push({
          id: `r:${r.group}/${r.kind}`,
          group: "Go to",
          label: pluralLabel(r),
          hint: r.group || "core",
          run: () => T.update(clusterTab.id, { resource: r, page: undefined }),
        });
      }
    }
    for (const t of tabs) {
      if (t.id === activeId || t.kind === "home") continue;
      const ctx = tabContext(t);
      cmds.push({ id: `t:${t.id}`, group: "Tabs", label: tabTitle(t), hint: ctx ? contextLabel(ctx) : undefined, run: () => T.activate(t.id) });
    }
    for (const c of contexts) {
      cmds.push({ id: `c:${c.name}`, group: "Clusters", label: contextLabel(c.name), hint: "open", run: () => openCluster(c.name, { focusExisting: true }) });
    }
    for (const c of useExtensions.getState().commands) {
      cmds.push({ id: `x:${c.ext}:${c.id}`, group: "Extensions", label: c.label, hint: c.ext, run: c.run });
    }
    const st = useSettings.getState();
    cmds.push(
      { id: "new", group: "Commands", label: "New Tab", hint: "Ctrl+T", run: () => T.open({ kind: "home" }) },
      { id: "close", group: "Commands", label: "Close Tab", hint: "Ctrl+W", run: () => activeId && T.close(activeId) },
      { id: "split", group: "Commands", label: T.splitId ? "Close Split View" : "Split View", hint: "Ctrl+\\", run: () => T.toggleSplit() },
      ...(activeCtx ? [{ id: "cterm", group: "Commands", label: `Terminal for ${contextLabel(activeCtx)}`, run: () => openSession({ kind: "terminal", context: activeCtx }) }] : []),
      { id: "apply", group: "Commands", label: "Apply Manifest", run: () => T.open({ kind: "apply", context: activeCtx, namespace: null }) },
      { id: "pf", group: "Commands", label: "Port Forwards", run: () => openSingleton("portforwards") },
      { id: "settings", group: "Commands", label: "Settings", hint: "Ctrl+,", run: () => openSingleton("settings") },
      {
        id: "theme",
        group: "Commands",
        label: "Toggle Light / Dark Theme",
        run: () => {
          const s = st.settings;
          if (!s) return;
          const cur = s.theme === "system" ? (document.documentElement.dataset.theme as "light" | "dark") : s.theme;
          st.save({ ...s, theme: cur === "dark" ? "light" : "dark" });
        },
      },
    );
    return cmds;
  }, [tabs, activeId, active, activeCtx, contexts, resources]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: score(q, `${c.label} ${c.hint ?? ""}`) }))
      .filter((x) => x.s !== null) as { c: Command; s: number }[];
    if (q) scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, 80).map((x) => x.c);
  }, [commands, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const close = () => usePalette.setState({ open: false });
  const run = (c?: Command) => {
    if (!c) return;
    close();
    c.run();
  };
  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="input palette-input"
          autoFocus
          placeholder="Type a command, cluster, tab or resource"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") run(results[sel]);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((c, i) => {
            const header = !q && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item ${i === sel ? "selected" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span>{c.label}</span>
                  {c.hint && <span className="menu-hint">{c.hint}</span>}
                </button>
              </div>
            );
          })}
          {results.length === 0 && <div className="muted pad">No matches</div>}
        </div>
      </div>
    </div>
  );
}

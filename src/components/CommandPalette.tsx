import { shortcut } from "../keys";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, type ContextInfo, type ResourceInfo } from "../api";
import { loadDiscovery } from "../hooks";
import { useSettings } from "../settings";
import { useExtensions } from "../extensions";
import {
  contextLabel,
  openCluster,
  openClusterSettings,
  openSession,
  openSingleton,
  pluralLabel,
  tabContext,
  tabTitle,
  useTabs,
  toggleSidebar,
} from "../store";
import { S } from "../strings";

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
    let cancelled = false;
    if (activeCtx)
      loadDiscovery(activeCtx).then(
        (r) => !cancelled && setResources(r),
        () => !cancelled && setResources([]),
      );
    else setResources([]);
    return () => {
      cancelled = true;
    };
  }, [open, activeCtx]);

  const commands = useMemo<Command[]>(() => {
    const T = useTabs.getState();
    const cmds: Command[] = [];
    const clusterTab = active?.kind === "cluster" ? active : null;
    if (clusterTab) {
      cmds.push({
        id: "ov",
        group: S.palette.goTo,
        label: S.cluster.overview,
        run: () => T.update(clusterTab.id, { resource: null, page: undefined }),
      });
      cmds.push({
        id: "hr",
        group: S.palette.goTo,
        label: S.helm.releases,
        run: () => T.update(clusterTab.id, { resource: null, page: "releases" }),
      });
      cmds.push({
        id: "hc",
        group: S.palette.goTo,
        label: S.helm.charts,
        run: () => T.update(clusterTab.id, { resource: null, page: "charts" }),
      });
      for (const r of resources) {
        cmds.push({
          id: `r:${r.group}/${r.kind}`,
          group: S.palette.goTo,
          label: pluralLabel(r),
          hint: r.group || S.palette.coreGroup,
          run: () => T.update(clusterTab.id, { resource: r, page: undefined }),
        });
      }
    }
    for (const t of tabs) {
      if (t.id === activeId || t.kind === "home") continue;
      const ctx = tabContext(t);
      cmds.push({
        id: `t:${t.id}`,
        group: S.palette.tabs,
        label: tabTitle(t),
        hint: ctx ? contextLabel(ctx) : undefined,
        run: () => T.activate(t.id),
      });
    }
    for (const c of contexts) {
      cmds.push({
        id: `c:${c.name}`,
        group: S.palette.clusters,
        label: contextLabel(c.name),
        hint: S.palette.open,
        run: () => openCluster(c.name, { focusExisting: true }),
      });
    }
    for (const c of useExtensions.getState().commands) {
      cmds.push({ id: `x:${c.ext}:${c.id}`, group: S.palette.extensions, label: c.label, hint: c.ext, run: c.run });
    }
    const st = useSettings.getState();
    cmds.push(
      {
        id: "new",
        group: S.palette.commands,
        label: S.tabs.newTab,
        hint: shortcut("T"),
        run: () => T.open({ kind: "home" }),
      },
      {
        id: "close",
        group: S.palette.commands,
        label: S.tabs.closeTab,
        hint: shortcut("W"),
        run: () => activeId && T.close(activeId),
      },
      {
        id: "split",
        group: S.palette.commands,
        label: T.splitId ? S.palette.closeSplitView : S.palette.splitView,
        hint: shortcut("\\"),
        run: () => T.toggleSplit(),
      },
      ...(active?.kind === "cluster"
        ? [
            {
              id: "sidebar",
              group: S.palette.commands,
              label: active.sidebarHidden ? S.palette.showSidebar : S.palette.hideSidebar,
              hint: shortcut("B"),
              run: () => toggleSidebar(active.id),
            },
          ]
        : []),
      ...(activeCtx
        ? [
            {
              id: "cterm",
              group: S.palette.commands,
              label: S.palette.terminalFor(contextLabel(activeCtx)),
              run: () => openSession({ kind: "terminal", context: activeCtx }),
            },
          ]
        : []),
      {
        id: "apply",
        group: S.palette.commands,
        label: S.apply.title,
        run: () => T.open({ kind: "apply", context: activeCtx, namespace: null }),
      },
      { id: "pf", group: S.palette.commands, label: S.portForward.listTitle, run: () => openSingleton("portforwards") },
      {
        id: "settings",
        group: S.palette.commands,
        label: S.settings.title,
        hint: shortcut(","),
        run: () => openSingleton("settings"),
      },
      ...(activeCtx
        ? [
            {
              id: "csettings",
              group: S.palette.commands,
              label: S.palette.clusterSettingsFor(contextLabel(activeCtx)),
              run: () => openClusterSettings(activeCtx),
            },
          ]
        : []),
      {
        id: "theme",
        group: S.palette.commands,
        label: S.palette.toggleTheme,
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
          placeholder={S.palette.placeholder}
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
          {results.length === 0 && <div className="muted pad">{S.common.noMatches}</div>}
        </div>
      </div>
    </div>
  );
}

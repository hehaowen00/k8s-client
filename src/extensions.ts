// Kube Portal extension runtime.
//
// An extension is an ES module whose default export (or `activate` export) is
// called with the `portal` API below. Everything it registers is tagged with
// the extension id so a failing extension can be reported without breaking others.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { api, type KubeObject, type ResourceInfo } from "./api";
import { toast } from "./components/Dialogs";
import { openDetail, type Target } from "./actions";
import { useTabs } from "./store";
import { podUsage } from "./metrics";
import { S } from "./strings";

export interface KindFilter {
  group?: string;
  kind: string;
}

export interface ExtCommand {
  ext: string;
  id: string;
  label: string;
  run: () => void;
}
export interface ExtAction {
  ext: string;
  label: string;
  kinds?: KindFilter[];
  run: (target: Target) => void;
}
export interface ExtPanel {
  ext: string;
  title: string;
  kinds?: KindFilter[];
  /** Render into `el`; may return a cleanup function. Called again when the object changes. */
  render: (el: HTMLElement, obj: KubeObject, target: Target) => void | (() => void);
}
export interface ExtPage {
  ext: string;
  id?: string;
  title: string;
  render: (el: HTMLElement, ctx: { context: string; namespace: string }) => void | (() => void);
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  source?: string | null;
  error?: string | null;
}

interface Registry {
  extensions: ExtensionInfo[];
  /** Load errors per extension id (besides manifest errors from the backend). */
  errors: Record<string, string>;
  commands: ExtCommand[];
  actions: ExtAction[];
  panels: ExtPanel[];
  pages: ExtPage[];
}

export const useExtensions = create<Registry>(() => ({
  extensions: [],
  errors: {},
  commands: [],
  actions: [],
  panels: [],
  pages: [],
}));

export const matchesKind = (kinds: KindFilter[] | undefined, r: ResourceInfo) =>
  !kinds || kinds.some((k) => k.kind === r.kind && (k.group === undefined || k.group === r.group));

function makeApi(ext: string, appVersion: string) {
  const add = <K extends "commands" | "actions" | "panels" | "pages">(key: K, item: Registry[K][number]) =>
    useExtensions.setState((s) => ({ [key]: [...s[key], item] }) as Partial<Registry>);
  return Object.freeze({
    version: appVersion,
    registerCommand: (c: { id: string; label: string; run: () => void }) => add("commands", { ...c, ext }),
    registerResourceAction: (a: { label: string; kinds?: KindFilter[]; run: (t: Target) => void }) =>
      add("actions", { ...a, ext }),
    registerDetailPanel: (p: Omit<ExtPanel, "ext">) => add("panels", { ...p, ext }),
    registerPage: (p: Omit<ExtPage, "ext">) => add("pages", { ...p, ext }),
    ui: {
      toast: (message: string, tone: "ok" | "bad" = "ok") => toast(message, tone),
      openDetail: (t: Target) => openDetail(t),
      openTerminal: (context: string) => useTabs.getState().open({ kind: "terminal", context }),
    },
    // Read/apply helpers over the same backend the UI uses.
    k8s: {
      contexts: () => api.listContexts(),
      discover: (context: string) => api.discover(context),
      namespaces: (context: string) => api.listNamespaces(context),
      get: (t: Target) => api.getObject(t),
      /** Full objects of a resource type; find the type with `discover(context)`. */
      list: (context: string, resource: ResourceInfo, namespace?: string | null, labelSelector?: string | null) =>
        api.listObjects(context, resource, namespace, labelSelector),
      getYaml: (t: Target) => api.getYaml(t),
      apply: (context: string, yaml: string, namespace?: string | null) =>
        api.applyManifest(context, yaml, namespace ?? null),
      delete: (t: Target) => api.deleteResource(t),
      patch: (t: Target, patch: unknown) => api.patchResource(t, patch),
      podMetrics: (context: string, namespace?: string | null) => podUsage(context, namespace ?? null),
    },
  });
}

export type KubePortalApi = ReturnType<typeof makeApi>;

let loaded = false;

/** Import every enabled extension once. */
export async function loadExtensions() {
  if (loaded) return;
  loaded = true;
  let list: ExtensionInfo[] = [];
  try {
    list = await invoke<ExtensionInfo[]>("list_extensions");
  } catch (e) {
    console.error("extensions:", e);
    return;
  }
  useExtensions.setState({ extensions: list });
  const appVersion = await getVersion().catch(() => "");
  for (const ext of list) {
    if (!ext.enabled || !ext.source || ext.error) continue;
    const url = URL.createObjectURL(new Blob([ext.source], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      const activate = mod.default ?? mod.activate;
      if (typeof activate !== "function") throw new Error(S.extensions.noActivate);
      await activate(makeApi(ext.id, appVersion));
    } catch (e) {
      console.error(`extension ${ext.id}:`, e);
      useExtensions.setState((s) => ({ errors: { ...s.errors, [ext.id]: String(e) } }));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

import { useCallback, useEffect, useState } from "react";
import { api, type KubeObject, type ResourceInfo } from "./api";
import { forgetPerms } from "./permissions";

const discoveryCache = new Map<string, Promise<ResourceInfo[]>>();

export function loadDiscovery(context: string, refresh = false): Promise<ResourceInfo[]> {
  if (refresh || !discoveryCache.has(context)) {
    const p = api.discover(context, refresh);
    p.catch(() => discoveryCache.delete(context));
    discoveryCache.set(context, p);
  }
  return discoveryCache.get(context)!;
}

export function forgetContext(context: string) {
  discoveryCache.delete(context);
  namespaceCache.delete(context);
  forgetPerms(context);
}

const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/**
 * Generic async loader with reload. Results are only returned for the `deps` they were loaded with;
 * a change in `refresh` reloads but keeps showing the previous result meanwhile.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], refresh: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; deps?: unknown[] }>({
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => !cancelled && setState({ data, loading: false, deps }),
      (e) => !cancelled && setState({ error: String(e), loading: false, deps }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ...refresh, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  if (!state.deps || !sameDeps(state.deps, deps)) return { data: undefined, error: undefined, loading: true, reload };
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export function useDiscovery(context: string | null) {
  return useAsync(() => (context ? loadDiscovery(context) : Promise.resolve([])), [context]);
}

const namespaceCache = new Map<string, Promise<string[]>>();
export function useNamespaces(context: string | null) {
  return useAsync(() => {
    if (!context) return Promise.resolve([]);
    if (!namespaceCache.has(context)) {
      const p = api.listNamespaces(context);
      p.catch(() => namespaceCache.delete(context));
      namespaceCache.set(context, p);
    }
    return namespaceCache.get(context)!;
  }, [context]);
}

export function refreshNamespaces(context: string) {
  namespaceCache.delete(context);
}

/** localStorage-backed state for small UI preferences. */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`kubetab.pref.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(`kubetab.pref.${key}`, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

/**
 * Live objects from a watch. `items` is null until the first list arrives; on errors the last items are kept.
 * Pass a null resource or `active = false` to stop watching.
 */
export function useWatchObjects(
  context: string,
  resource: ResourceInfo | null | undefined,
  namespace: string | null,
  selectors: { labelSelector?: string | null; fieldSelector?: string | null },
  active = true,
) {
  const [state, setState] = useState<{ items: KubeObject[] | null; error: string | null }>({
    items: null,
    error: null,
  });
  const { labelSelector, fieldSelector } = selectors;
  useEffect(() => {
    setState({ items: null, error: null });
    if (!resource || !active) return;
    const byUid = new Map<string, KubeObject>();
    const uid = (o: KubeObject) => o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`;
    const publish = () => setState({ items: [...byUid.values()], error: null });
    return api.watchObjects(
      context,
      resource,
      namespace,
      (e) => {
        if (e.type === "error") return setState((s) => ({ ...s, error: e.message }));
        if (e.type === "reset") {
          byUid.clear();
          e.items.forEach((o) => byUid.set(uid(o), o));
        } else if (e.type === "upsert") byUid.set(uid(e.object), e.object);
        else byUid.delete(uid(e.object));
        publish();
      },
      { labelSelector, fieldSelector },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, resource?.group, resource?.version, resource?.plural, namespace, labelSelector, fieldSelector, active]);
  return state;
}

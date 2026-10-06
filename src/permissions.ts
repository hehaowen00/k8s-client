import { useEffect, useState } from "react";
import { api, type ResourceInfo } from "./api";

/** What the current user may do with a resource type in a namespace (SelfSubjectAccessReview). */
export interface Perms {
  update: boolean;
  patch: boolean;
  delete: boolean;
  create: boolean;
  exec: boolean;
  attach: boolean;
  logs: boolean;
  portForward: boolean;
  evict: boolean;
}

export const ALL_ALLOWED: Perms = {
  update: true,
  patch: true,
  delete: true,
  create: true,
  exec: true,
  attach: true,
  logs: true,
  portForward: true,
  evict: true,
};

const cache = new Map<string, { at: number; p: Promise<Perms> }>();
const TTL = 60_000;

export function loadPerms(context: string, r: ResourceInfo, namespace: string | null | undefined): Promise<Perms> {
  const ns = namespace ?? "";
  const key = `${context}|${r.group}/${r.plural}|${ns}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const base = { group: r.group, resource: r.plural, namespace: ns || null };
  const pod = { group: "", resource: "pods", namespace: ns || null };
  const checks = [
    { ...base, verb: "update" },
    { ...base, verb: "patch" },
    { ...base, verb: "delete" },
    { ...base, verb: "create" },
    { ...pod, subresource: "exec", verb: "create" },
    { ...pod, subresource: "attach", verb: "create" },
    { ...pod, subresource: "log", verb: "get" },
    { ...pod, subresource: "portforward", verb: "create" },
    { ...pod, subresource: "eviction", verb: "create" },
  ];
  const p = api.canI(context, checks).then(
    ([update, patch, del, create, exec, attach, logs, portForward, evict]) => ({
      update,
      patch,
      delete: del,
      create,
      exec,
      attach,
      logs,
      portForward,
      evict,
    }),
    () => ALL_ALLOWED,
  );
  cache.set(key, { at: Date.now(), p });
  return p;
}

export function usePerms(context: string, r: ResourceInfo, namespace: string | null | undefined): Perms {
  const [perms, setPerms] = useState<Perms>(ALL_ALLOWED);
  useEffect(() => {
    let cancelled = false;
    loadPerms(context, r, namespace).then((p) => !cancelled && setPerms(p));
    return () => {
      cancelled = true;
    };
  }, [context, r.group, r.plural, namespace, r]);
  return perms;
}

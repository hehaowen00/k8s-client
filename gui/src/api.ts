import { Channel, invoke } from "@tauri-apps/api/core";

export interface ContextInfo {
  /** Unique id: the context name, suffixed with its file name if another source uses the same name. */
  name: string;
  contextName: string;
  /** Kubeconfig file for folder-loaded contexts; undefined for the default kubeconfig. */
  source?: string | null;
  cluster: string;
  user?: string;
  namespace?: string;
  current: boolean;
}

export interface ForwardInfo {
  id: string;
  context: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  remotePort: number;
  localPort: number;
  connections: number;
  activeConnections: number;
  lastError?: string | null;
  lastPod?: string | null;
}

export interface Usage {
  namespace?: string | null;
  name: string;
  /** cores */
  cpu: number;
  /** bytes */
  memory: number;
  containers: { name: string; cpu: number; memory: number }[];
}

export interface PrometheusTarget {
  namespace: string;
  service: string;
  port: number;
}

export interface Overview {
  serverVersion: string;
  nodes: {
    name: string;
    ready: boolean;
    unschedulable: boolean;
    roles: string[];
    cpuAllocatable: number;
    memoryAllocatable: number;
    podsAllocatable: number;
    kubeletVersion: string;
  }[];
  podPhases: Record<string, number>;
  podsTotal: number;
  cpuRequests: number;
  memoryRequests: number;
  cpuLimits: number;
  memoryLimits: number;
  workloads: { kind: string; total: number; healthy: number; progressing: number; failed: number }[];
  warnings: { namespace: string; object: string; reason: string; message: string; count: number; lastSeen?: string }[];
  namespaces?: number | null;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}
export interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}
export interface HelmChart {
  name: string;
  version: string;
  app_version: string;
  description: string;
}
export interface HelmReleaseDetails {
  values: string;
  computedValues: string;
  manifest: string;
  notes: string;
  history: HelmRevision[];
  status: KubeObject | null;
}

export interface FolderInfo {
  path: string;
  files: number;
  contexts: number;
  errors: string[];
  /** Kube Portal's own folder of pasted kubeconfigs. */
  managed: boolean;
}

export interface ResourceInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  verbs: string[];
}

export interface Column {
  name: string;
  type: string;
  format: string;
  priority: number;
  description: string;
}

export interface Row {
  uid: string;
  name: string;
  namespace?: string;
  created?: string;
  labels: Record<string, string> | null;
  cells: unknown[];
}

export type TableEvent =
  | { type: "reset"; columns: Column[]; rows: Row[] }
  | { type: "upsert"; rows: Row[] }
  | { type: "delete"; uids: string[] }
  | { type: "error"; message: string };

export type LogEvent =
  | { type: "lines"; lines: string[] }
  | { type: "end" }
  | { type: "error"; message: string };

export interface TaggedLine {
  pod: string;
  container: string;
  line: string;
}
export interface LogSource {
  pod: string;
  container: string;
  state: "streaming" | "waiting" | "done";
}
export type MultiLogEvent =
  | { type: "lines"; lines: TaggedLine[] }
  | { type: "sources"; sources: LogSource[] }
  | { type: "error"; message: string };

export type SessionEvent =
  | { type: "data"; data: string }
  | { type: "exit"; message?: string | null };

export interface EventInfo {
  kind: string;
  reason: string;
  message: string;
  count: number;
  lastSeen?: string;
  source: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KubeObject = Record<string, any>;

interface ObjRef {
  context: string;
  resource: ResourceInfo;
  namespace?: string | null;
  name: string;
}

/** Start a backend stream; returns a stop function that is safe to call before the id arrives. */
function startStream<E>(
  command: string,
  args: Record<string, unknown>,
  onEvent: (e: E) => void,
  onError: (msg: string) => void,
): () => void {
  const channel = new Channel<E>();
  let stopped = false;
  channel.onmessage = (e) => {
    if (!stopped) onEvent(e);
  };
  const idPromise = invoke<string>(command, { ...args, channel }).catch((e) => {
    if (!stopped) onError(String(e));
    return null;
  });
  return () => {
    stopped = true;
    idPromise.then((id) => id && invoke("stop_stream", { id }));
  };
}

export const api = {
  listContexts: () => invoke<ContextInfo[]>("list_contexts"),
  listKubeconfigFolders: () => invoke<FolderInfo[]>("list_kubeconfig_folders"),
  addKubeconfigFolder: (path: string) => invoke<FolderInfo[]>("add_kubeconfig_folder", { path }),
  removeKubeconfigFolder: (path: string) => invoke<FolderInfo[]>("remove_kubeconfig_folder", { path }),
  startPortForward: (opts: {
    context: string;
    namespace: string;
    kind: "pod" | "service";
    name: string;
    remotePort: number;
    localPort?: number | null;
  }) => invoke<ForwardInfo>("start_port_forward", opts),
  stopPortForward: (id: string) => invoke<ForwardInfo[]>("stop_port_forward", { id }),
  listPortForwards: () => invoke<ForwardInfo[]>("list_port_forwards"),
  podMetrics: (context: string, namespace?: string | null, selector?: string | null) =>
    invoke<Usage[]>("pod_metrics", { context, namespace, selector }),
  nodeMetrics: (context: string) => invoke<Usage[]>("node_metrics", { context }),
  prometheusDetect: (context: string, refresh = false) =>
    invoke<PrometheusTarget | null>("prometheus_detect", { context, refresh }),
  prometheusRange: (context: string, queries: string[], start: number, end: number, step: number) =>
    invoke<[number, number][][]>("prometheus_range", { context, queries, start, end, step }),
  clusterOverview: (context: string, namespace?: string | null) =>
    invoke<Overview>("cluster_overview", { context, namespace }),
  helmList: (context: string, namespace?: string | null) => invoke<HelmRelease[]>("helm_list", { context, namespace }),
  helmRelease: (context: string, namespace: string, name: string) =>
    invoke<HelmReleaseDetails>("helm_release", { context, namespace, name }),
  helmInstall: (req: {
    context: string;
    namespace: string;
    name: string;
    chart: string;
    version?: string | null;
    values: string;
    createNamespace?: boolean;
    upgrade?: boolean;
  }) => invoke<string>("helm_install", { req }),
  helmRollback: (context: string, namespace: string, name: string, revision: number) =>
    invoke<void>("helm_rollback", { context, namespace, name, revision }),
  helmUninstall: (context: string, namespace: string, name: string) =>
    invoke<void>("helm_uninstall", { context, namespace, name }),
  helmRepos: () => invoke<{ name: string; url: string }[]>("helm_repos"),
  helmRepoAdd: (name: string, url: string) => invoke<void>("helm_repo_add", { name, url }),
  helmRepoRemove: (name: string) => invoke<void>("helm_repo_remove", { name }),
  helmRepoUpdate: () => invoke<string>("helm_repo_update"),
  helmSearch: (query?: string | null, versions = false) => invoke<HelmChart[]>("helm_search", { query, versions }),
  helmChartInfo: (chart: string, version?: string | null) =>
    invoke<{ values: string; readme: string; chart: string }>("helm_chart_info", { chart, version }),
  countResources: (context: string, resources: ResourceInfo[], namespace?: string | null) =>
    invoke<(number | null)[]>("count_resources", { context, resources, namespace }),
  canI: (
    context: string,
    checks: { group: string; resource: string; subresource?: string; verb: string; namespace?: string | null; name?: string }[],
  ) => invoke<boolean[]>("can_i", { context, checks }),
  reconnect: (context: string) => invoke<void>("reconnect", { context }),
  discover: (context: string, refresh = false) =>
    invoke<ResourceInfo[]>("discover", { context, refresh }),
  listNamespaces: (context: string) => invoke<string[]>("list_namespaces", { context }),

  watchResources: (
    context: string,
    resource: ResourceInfo,
    namespace: string | null,
    onEvent: (e: TableEvent) => void,
    selectors?: { labelSelector?: string | null; fieldSelector?: string | null },
  ) =>
    startStream<TableEvent>("watch_resources", { context, resource, namespace, ...selectors }, onEvent, (message) =>
      onEvent({ type: "error", message }),
    ),

  getObject: (r: ObjRef) => invoke<KubeObject>("get_object", { ...r }),
  listObjects: (context: string, resource: ResourceInfo, namespace?: string | null, labelSelector?: string | null) =>
    invoke<KubeObject[]>("list_objects", { context, resource, namespace, labelSelector }),
  listOwned: (context: string, resource: ResourceInfo, namespace: string | null, ownerUid: string) =>
    invoke<KubeObject[]>("list_owned", { context, resource, namespace, ownerUid }),
  getYaml: (r: ObjRef) => invoke<string>("get_yaml", { ...r }),
  /** `originalYaml` lets the backend rebase over status-only changes on conflict. */
  replaceYaml: (r: ObjRef, yaml: string, originalYaml?: string | null) => invoke<string>("replace_yaml", { ...r, yaml, originalYaml }),
  deleteResource: (r: ObjRef) => invoke<void>("delete_resource", { ...r }),
  scaleResource: (r: ObjRef, replicas: number) => invoke<void>("scale_resource", { ...r, replicas }),
  restartResource: (r: ObjRef) => invoke<void>("restart_resource", { ...r }),
  patchResource: (r: ObjRef, patch: unknown) => invoke<void>("patch_resource", { ...r, patch }),
  drainNode: (context: string, node: string) =>
    invoke<{ evicted: string[]; skipped: string[]; failed: string[]; pending: string[] }>("drain_node", { context, node }),
  nodeShellCreate: (context: string, node: string) =>
    invoke<{ namespace: string; pod: string }>("node_shell_create", { context, node }),
  triggerCronjob: (context: string, namespace: string, name: string) =>
    invoke<string>("trigger_cronjob", { context, namespace, name }),
  listEvents: (context: string, namespace: string | null | undefined, uid: string) =>
    invoke<EventInfo[]>("list_events", { context, namespace, uid }),
  applyManifest: (context: string, yaml: string, defaultNamespace: string | null) =>
    invoke<string[]>("apply_manifest", { context, yaml, defaultNamespace }),

  streamLogs: (
    opts: {
      context: string;
      namespace: string;
      pod: string;
      container?: string | null;
      tailLines?: number | null;
      previous?: boolean;
      timestamps?: boolean;
      sinceSeconds?: number | null;
    },
    onEvent: (e: LogEvent) => void,
  ) =>
    startStream<LogEvent>("stream_logs", opts, onEvent, (message) =>
      onEvent({ type: "error", message }),
    ),

  /** Logs from every pod matching `selector`, or every container of `pod`. */
  streamMultiLogs: (
    opts: {
      context: string;
      namespace: string;
      selector?: string | null;
      pod?: string | null;
      container?: string | null;
      tailLines?: number | null;
      timestamps?: boolean;
      sinceSeconds?: number | null;
    },
    onEvent: (e: MultiLogEvent) => void,
  ) =>
    startStream<MultiLogEvent>("stream_multi_logs", opts, onEvent, (message) =>
      onEvent({ type: "error", message }),
    ),

  execStart: (
    opts: {
      context: string;
      namespace: string;
      pod: string;
      container?: string | null;
      command?: string[] | null;
      attach?: boolean;
      cols: number;
      rows: number;
    },
    channel: Channel<SessionEvent>,
  ) => invoke<string>("exec_start", { ...opts, channel }),
  ptyStart: (opts: { cols: number; rows: number; context: string }, channel: Channel<SessionEvent>) =>
    invoke<string>("pty_start", { ...opts, channel }),
  sessionWrite: (id: string, data: string) => invoke<void>("session_write", { id, data }),
  sessionResize: (id: string, cols: number, rows: number) =>
    invoke<void>("session_resize", { id, cols, rows }),
  sessionClose: (id: string) => invoke<void>("session_close", { id }),
};

export const resourceKey = (r: Pick<ResourceInfo, "group" | "kind">) =>
  `${r.group || "core"}/${r.kind}`;

/** Resources that can be scaled / restarted via spec.replicas / pod template. */
export const isScalable = (r: ResourceInfo) =>
  ["Deployment", "StatefulSet", "ReplicaSet"].includes(r.kind) && r.group === "apps";
export const isRestartable = (r: ResourceInfo) =>
  ["Deployment", "StatefulSet", "DaemonSet"].includes(r.kind) && r.group === "apps";
export const isPod = (r: ResourceInfo) => r.kind === "Pod" && r.group === "";
export const isNode = (r: ResourceInfo) => r.kind === "Node" && r.group === "";
export const isCronJob = (r: ResourceInfo) => r.kind === "CronJob" && r.group === "batch";
export const canDelete = (r: ResourceInfo) => r.verbs.length === 0 || r.verbs.includes("delete");
/** Workloads whose logs can be streamed via their pod selector. */
export const hasWorkloadLogs = (r: ResourceInfo) =>
  (r.group === "apps" && ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"].includes(r.kind)) ||
  (r.group === "batch" && r.kind === "Job");
export const hasLogs = (r: ResourceInfo) => isPod(r) || hasWorkloadLogs(r);

export const POD_RESOURCE: ResourceInfo = {
  group: "",
  version: "v1",
  kind: "Pod",
  plural: "pods",
  namespaced: true,
  verbs: [],
};

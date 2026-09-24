# Kube Portal roadmap: Lens feature parity

Tracks which features Kube Portal has, compared with Lens.

**Status markers:** `[x]` done · `[~]` partial (see note) · `[ ]` not started.
To update, change the marker and, for `[~]`, say what's missing. Run `pnpm roadmap` in `gui/` to see progress
(`pnpm roadmap --todo` lists what's left).

## Clusters & kubeconfig

- [x] Load contexts from `$KUBECONFIG` / `~/.kube/config`
- [x] Load folders of kubeconfig files (any file name, invalid files ignored)
- [x] Duplicate context names across files stay distinct
- [x] Friendly names for EKS ARN contexts
- [x] Switch cluster per tab
- [x] Connection error shown with cause and retry
- [x] Add a cluster by pasting a kubeconfig (stored privately in Kube Portal's config folder)
- [x] Per-cluster settings: display name, colour, default namespace
- [x] Accessible namespaces (for users who can't list namespaces; "all" merges watches across them)
- [x] Pinned clusters hotbar
- [x] Watch kubeconfig files and folders for changes (live)
- [x] HTTP / SOCKS proxy per cluster (API, Helm, terminals)

## Cluster overview

- [x] Cluster dashboard: node count, pod counts by phase, capacity meters, node table, warnings (namespace-scopable)
- [x] Cluster CPU / memory / pod capacity charts
- [x] Cluster warning events on the overview

## Resource browsing

- [x] Every API resource via discovery, including CRDs
- [x] Sidebar grouped like Lens (Workloads, Config, Network, Storage, Access Control, Cluster, Custom Resources)
- [x] kubectl-style columns from server-side Table rendering
- [x] Live updates via watch
- [x] Filter by name / label / status text
- [x] Column sorting
- [x] "Wide" extra columns
- [x] Virtual scrolling for large lists
- [x] Keyboard navigation in tables
- [x] Namespace filter: all, one, or several namespaces
- [x] Choose / hide / reorder columns (per kind, remembered)
- [x] Resource counts in the sidebar
- [x] Workloads overview (status bar per workload kind, on the cluster overview)

## Resource details

- [x] Detail side panel and detail tabs
- [x] Metadata: labels, annotations, owner links, finalizers
- [x] Conditions table
- [x] Events tab
- [x] YAML editor with save (replace) and conflict errors
- [x] Pod details: containers, state, restarts, ports, resources
- [x] Workload details: replicas, strategy, selector, images
- [x] Service details: type, IPs, ports, selector
- [x] ConfigMap and Secret data (with secret reveal)
- [x] Node details: system info, taints, capacity
- [x] Ingress details (rules, backends, TLS)
- [x] PersistentVolumeClaim / PersistentVolume / StorageClass details
- [x] CronJob / Job details (schedule, last run, child jobs)
- [x] HPA details (targets, current metrics)
- [x] RBAC details (Role rules, binding subjects)
- [x] CRD details (versions, schema, printer columns)
- [x] Related resources: a workload's / job's / service's / node's pods, a service's endpoints
- [x] Pod / node / workload CPU and memory charts (requests, limits, allocatable reference lines)

## Actions

- [x] Delete
- [x] Scale (Deployment, StatefulSet, ReplicaSet)
- [x] Rolling restart (Deployment, StatefulSet, DaemonSet)
- [x] Bulk-select and restart workloads
- [x] Create / apply manifests (server-side apply, multi-document)
- [x] Bulk actions: select any rows, then restart (workloads) or delete
- [x] Port-forward pods and services (with open-in-browser and a list of active forwards)
- [x] Cordon / uncordon / drain nodes
- [x] Node shell (privileged pod with nsenter, removed on close)
- [x] Trigger CronJob now; suspend / resume CronJob
- [x] Attach to a running container
- [x] Resource templates for "Create"
- [x] Disable actions the user isn't allowed to perform (SelfSubjectAccessReview)

## Logs

- [x] Stream logs with follow
- [x] Container picker, including init containers
- [x] Tail size, timestamps, previous container
- [x] Search with highlighting and "only matches" mode
- [x] Save logs to a file
- [x] All containers merged into one view
- [x] "Since" time filter
- [x] Line wrapping toggle
- [x] Logs for a whole workload (all pods of a Deployment / StatefulSet / DaemonSet / ReplicaSet / Job), following rollouts
- [x] Logs button on pod and workload rows; pod filter in workload logs
- [x] ANSI colour rendering

## Terminal

- [x] Pod shell (exec with TTY and resize)
- [x] Local terminal
- [x] Multiple terminals in tabs
- [x] Local terminal pre-configured for the tab's cluster (KUBECONFIG + context)
- [x] Per-cluster kubectl: downloads the release matching each cluster (SHA-256 verified) for its terminals

## Helm

- [x] List releases
- [x] Release details: values, manifest, history
- [x] Upgrade / rollback / uninstall release
- [x] Browse chart repositories and install charts
- [x] Manage chart repositories

## Metrics

- [x] Detect metrics-server / Prometheus (auto-detected via the API server service proxy)
- [x] CPU / memory columns in pod and node lists
- [x] Metric charts in detail views (Prometheus history, or sampled from metrics-server)

## App & UI

- [x] Tabs: reorder, duplicate, close others / to the right, middle-click close
- [x] Tabs restored on restart
- [x] Per-tab dock for logs, shells and terminals (like Lens's dock, but one per tab)
- [x] Keyboard shortcuts for tabs
- [x] Per-cluster colour on tabs
- [x] Toasts and confirm dialogs
- [x] Command palette (Ctrl+Shift+P / Ctrl+K)
- [x] Settings page
- [x] Light theme (and follow-system)
- [x] Split view (two tabs side by side, resizable)
- [x] Auto-update: signed updates from a feed you publish (Settings → Updates)
- [x] Extensions: Kube Portal extension API (commands, resource actions, detail panels, pages). Lens extensions themselves are not compatible

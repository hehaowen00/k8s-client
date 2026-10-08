# Optimisations

## API server load and bandwidth (2026-10-08)

Goal: fewer and cheaper requests against the API server, and fewer bytes on the wire.

| Idea | Status | What changed |
| --- | --- | --- |
| gzip responses | Applied | Enabled kube's `gzip` feature: requests send `Accept-Encoding: gzip`, so JSON lists and watch streams arrive compressed (often 5–10x smaller). |
| Serve lists from the watch cache | Applied | Resource tables, the overview, namespaces, extension lists, MCP lists, Prometheus detection and port-forward pod lookups list with `resourceVersion=0`. These no longer do a quorum read from etcd. Not applied to `count_resources` (with `resourceVersion=0` the server ignores `limit=1` and returns the full list) or to node drain, which needs fresh data. |
| Watch bookmarks | Applied | Watches send `allowWatchBookmarks=true`. On quiet resources the resourceVersion now keeps moving, so resuming after the 290s timeout no longer hits 410 Gone and relists everything. |
| One list+watch driver | Applied | `watch.rs` handles list/watch/relist/backoff for resource tables, detail views and multi-pod logs. Resources without the `watch` verb relist every 10s instead of failing the watch over and over. |
| Detail view: watch the object instead of polling | Applied | Was a full GET every 4s per open detail view. Now a single watch with `fieldSelector=metadata.name=…` that only sends data when the object changes. |
| Events, Endpoints and CronJob jobs: watch instead of polling | Applied | Were a list or GET every 5s each. Now watches. The `list_events` and `list_owned` commands are removed. |
| Multi-pod logs: watch pods instead of re-listing | Applied | Was a full pod list every 3s for each workload log tab. Now a pod watch, and reconciling streams only happens when the pod set changed or a stream ended. |
| Helm releases: skip `helm list` when nothing changed | Applied | `helm list` reads every release secret in full (it decodes the gzipped chart and manifest) every 10s. A metadata-only list of `owner=helm` secrets from the watch cache now fingerprints the releases, and the last result is reused until it changes. Falls back to always running `helm list` when no release secrets are visible, e.g. with the ConfigMap storage driver. |
| Pause polling while the window is hidden | Applied | Overview (10s), sidebar counts (30s), Helm releases (10s), metrics-server usage (15s) and metric charts skip ticks while the window is minimised or hidden, and refresh once when it's shown again. |
| Overview: replace 6 full lists every 10s with watches | Applied | `overview.rs` watches nodes, pods, deployments, statefulsets, daemonsets, jobs, warning events and namespaces per (cluster, namespace). It keeps only a small summary per object (phase and requests/limits for pods, healthy/progressing/failed for workloads), so memory stays small. A refresh is now computed in memory with no API calls. The server version is fetched once. Watches stop 90s after the last refresh, so a closed or hidden overview costs nothing, and reconnecting stops them. |
| Background table tabs: close watches | Applied | A table in a tab that has been in the background for 5 minutes closes its watches. Showing the tab again relists from the cache. |
| Share watches between views | Applied | `api.ts` keeps one backend watch per (cluster, resource, namespace, selectors), shared by every table and detail view that asks for it. A view that subscribes late is caught up with a snapshot. An unused watch stays open for 5s so a remounting view picks it straight back up. |
| Single-object metrics | Applied | Charts for one pod or node fetched every pod in the namespace (or every node) and picked one out. They now fetch `metrics.k8s.io/.../pods/{name}` or `nodes/{name}`, or reuse a namespace-wide fetch less than 30s old. |
| Share metrics-server requests | Applied | Usage tables, charts and the extension API go through one cache with in-flight sharing and a 30s TTL. |
| Metrics polling every minute | Applied | Usage tables 15s → 60s, metrics-server chart samples 10s → 60s, Prometheus chart refresh 10–30s → 60s. metrics-server itself only refreshes every 15–60s. Side effect: without Prometheus, the 1m span holds only one sample. |
| Incremental Prometheus range queries | Applied | Each refresh re-queried the whole span (up to 12h) through the API server's service proxy. It now queries from the last point it has (re-fetching that point because it may have been partial) and trims to the window. |
| Sidebar counts | Applied | Refresh every 10 minutes (was 30s), when a section is expanded, and on namespace change. The open resource shows its table's live count instead. |
| HTTP/2 for API requests | Skipped | kube-client is HTTP/1 only, so each watch holds its own TCP+TLS connection. An HTTP/2 client for get/list/watch (exec, attach and port-forward stay on HTTP/1 for the WebSocket upgrade) would multiplex them all onto one connection. Skipped at the user's request. |
| Longer permission cache TTL | Applied | 60s → 10 minutes. Reconnecting a cluster now also clears its cached permissions (it didn't before). |
| Pod usage for multi-namespace selections | Applied | With 2+ namespaces selected, the pods table asked metrics-server for every pod in the cluster every 15s. It now fetches only the selected namespaces, or the accessible namespaces configured for the cluster. |
| Paginate large table lists | Rejected for now | `resourceVersion=0` lists come from the cache, where the server ignores `limit`. The cache read is cheaper than paginated etcd reads. |

Nothing was benchmarked. Checked with `tsc`, `cargo test --lib` and `cargo clippy -D warnings`.

# Changelog

## 0.1.4 — 2026-10-08

### Added
- Restart Across Clusters: rolling-restart the same deployment, statefulset or daemonset in several clusters at once, from the resource menu or the detail view.
  - Looks the object up in every cluster in parallel and shows each one's ready count, "Not found", or the connection error.
  - Select All / Clear All, then a confirmation screen listing every cluster and object that will be restarted.
  - Each cluster shows "Restarted" or its error afterwards, and failures are also collected in an error dialog.
- MCP: `get_deployment` tool returning replicas, revision, strategy, conditions, and each container's image, ports and resources, plus its pods when `pods` is shared. Env vars and volumes are left out because they can hold credentials.
- MCP: `get_logs` accepts `deployment` instead of `pod` and reads up to 10 of its pods in parallel, prefixing each line with the pod name.
- MCP: each tool can be turned off under MCP Server → Tools. Turned-off tools are hidden from clients, and calls to them are refused and logged as denied.
- MCP: shared namespaces are picked from a checklist of the cluster's namespaces, with "All namespaces" on by default and a way to add a namespace by name when they can't be listed.
- MCP: the MCP Server section of Settings has a cluster picker for editing any cluster's MCP access without leaving Settings.
- Metrics: charts are bar charts, with a time span selector (1m to 12hr, default 1hr) that is remembered while the app is open.

### Changed
- MCP: `get_logs` without a container uses the pod's default container, then its first, so pods with several containers no longer fail.
- MCP: the "Pod logs" option now reads "Pod and deployment logs".
- Settings no longer lists every cluster. Per-cluster settings open from the hotbar, New Tab or the command palette.

## 0.1.3 — 2026-10-07

### Added
- Window size, position and maximized state are remembered across launches.

### Changed
- Shortcuts use Cmd on macOS, Super on Linux and Ctrl or Super on Windows, so Ctrl+W/K/T/J/\ reach the shell in terminals. Ctrl+Tab cycles tabs on macOS; terminal copy/paste is Cmd+C/V on macOS and Ctrl+Shift+C/V elsewhere.
- Far fewer disk writes: tab state is saved at most once a second and only when it changes, the split ratio is saved when a drag ends, Apply drafts stay in memory, and scoped kubeconfigs are rewritten only when they change.
- Faster frontend: fewer re-renders in logs and resource tables, and switching cluster or namespace no longer briefly shows the previous data. Related pods stop polling while their tab is hidden.
- Smaller cargo build artifacts.
- The project moved from `gui/` to the repo root.

### Fixed
- MCP: names and namespaces that could change the API path are refused, Secrets are redacted by the returned object's kind, and the last-applied-configuration annotation on Secrets is hidden.
- The last-applied annotation on Secrets is masked behind Reveal in the detail view.
- Contexts whose names differ only in punctuation no longer share one scoped kubeconfig.
- The Helm view reloads when its tab's cluster changes, so a stale release can't be uninstalled from the wrong cluster.
- Failing watches back off (500 ms to 30 s) instead of looping, and their errors are shown.
- Exec/attach connections close with their session; node-shell pods are deleted if setup fails and on exit, and long node names fit.
- Drain refuses unmanaged pods, retries evictions blocked by a PodDisruptionBudget, and waits by UID.
- Cached clients are rebuilt when a context's cluster or user changes.
- kubectl downloads have timeouts, use a temp file per download, and clean up on failure.
- The config folder is restricted to 0700 and settings.db (which holds the MCP token) to 0600.

## 0.1.2 — 2026-10-01

### Added
- Built-in read-only MCP server (off by default) on 127.0.0.1 with a bearer token. Per cluster, choose the resource types, namespaces, and whether full objects (Secret values redacted), logs and events are shared. Every call is recorded in an access log in Settings.
- Per-cluster settings tab (name, colour, icon, pin, namespaces, proxy, MCP access), separate from app-wide Settings.
- Drag to reorder pinned clusters in the hotbar.
- Overlay titlebar on macOS, and ad-hoc code signing by default.

### Changed
- Terminals use ghostty-web instead of xterm.js.
- Terminals always belong to a cluster and target it through a scoped kubeconfig and the cluster's proxy; the plain local terminal is gone.
- Links to related resources (owners, references, CronJob jobs, Helm release resources) and related pods open in the cluster view's own list when on the same cluster.
- Errors open in a dialog with the full, copyable message instead of a toast, and dialogs queue instead of replacing each other.
- Menu items, buttons and placeholders no longer end with an ellipsis.
- The tab bar is restyled with drag-to-reorder placeholders.
- The logs toolbar collapses into an overflow menu based on the available width.

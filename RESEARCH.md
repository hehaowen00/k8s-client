# Research

Algorithms and data structures used by Kube Portal and why they were chosen. Written after most of
the app was built, so it records the choices already in the code. Add new research here before
writing code for new features. Measured performance changes go in `OPTIMISATIONS.md`.

## Keeping resource lists live

**Options considered**

| Approach | Cost | Notes |
| --- | --- | --- |
| Poll with a full LIST every N seconds | One quorum read of etcd per poll, per view | Simple, but load grows with views × clusters, and data is up to N seconds stale. |
| LIST once, then WATCH (informer pattern) | One list, then only the changes | The pattern client-go informers use. Needs resume and relist handling. |
| LIST with `resourceVersion=0`, WATCH with bookmarks | List comes from the API server's watch cache, not etcd. Bookmarks keep the resourceVersion fresh | Chosen. |

**Chosen:** `src-tauri/src/watch.rs` runs one list+watch loop:

- It lists with `resourceVersion=0`, so the API server answers from its in-memory cache.
- It watches with `allowWatchBookmarks=true`. When the server ends the watch (timeout), the loop
  resumes from the last resourceVersion. It only relists after `410 Gone` or a stream error.
- Failures back off exponentially, from 0.5s up to 30s.
- APIs without the `watch` verb relist every 10s.
- The frontend (`src/api.ts`) shares one backend watch per (cluster, resource, namespace,
  selectors) across every view that asks for it. A view that subscribes late gets a snapshot.
  Unused watches close after a 5s grace period, so a remounting view picks its watch straight back up.

**Trade-off:** each watch still holds its own HTTP/1 connection, because kube-client has no HTTP/2.
See `OPTIMISATIONS.md`.

## Table rows

- Rows are kept in a `Map<uid, Row>`. Watch events (add, modify, delete) are O(1) by uid. With
  several namespaces selected, each namespace's stream has its own map, so relisting one
  namespace replaces only its own rows.
- Columns come from server-side Table rendering (`Accept: application/json;as=Table`). The server
  decides kubectl's columns for built-in types and CRDs alike, so the client doesn't need a
  per-kind printer.
- Tables use virtual scrolling with a fixed row height (`ROW_HEIGHT = 30`). The visible range is
  `floor(scrollTop / h) - overscan .. ceil((scrollTop + height) / h) + overscan`, which takes O(1)
  to compute, and only those rows reach the DOM. A fixed height avoids measuring rows, which
  variable-height lists need.

## Logs

- Lines are held in an array capped at `MAX_LINES = 100,000`. When it grows past 110% of the cap,
  one `splice` drops the oldest lines. Trimming in bulk keeps the cost of front deletes amortised
  O(1) per line, without the indexing overhead of a ring buffer in JS.
- The backend batches lines and flushes every 80ms, capping a batch at 2,000 lines (multi-pod
  logs). The frontend gets a few IPC messages per second instead of one per line.
- Search keeps an incremental filter: only new lines are tested against the regex, and the
  matches are trimmed together with the buffer.
- Wrap mode can't use fixed-height virtualisation, so it renders only the newest lines.
- Multi-pod logs track pods in a `BTreeMap` (sorted for stable colours and order) and active
  streams in a `HashMap<key, CancellationToken>`. Streams are only reconciled when the pod set
  changes or a stream ends.

## Cluster overview

- One watch per kind (nodes, pods, workloads, warning events, namespaces) for each (cluster,
  namespace) pair. It stores only a small summary per object: pod phase and requests/limits, and
  workload health. Memory stays O(objects) with a small constant.
- A refresh is computed in memory, with no API calls. The watches stop 90s after the last
  refresh.

## Metrics

- metrics-server responses go through one cache with a 30s TTL that shares in-flight requests,
  so concurrent views asking for the same data cause a single request.
- Prometheus range queries are incremental: each refresh queries from the last point already held
  (re-fetching that point, which may have been partial) and trims to the time window.
- Kubernetes quantities (`Ki`, `Mi`, `m`, …) are parsed with a suffix table into an `f64`.

## Command palette

- Fuzzy matching is subsequence-based and scored by the total gap between matched characters
  (lower is better), with bonuses for prefix and substring matches. It is O(text length)
  per command, which is fine for a few hundred commands. Results are capped at 80. A full fuzzy
  library such as fzf's algorithm wasn't needed at this size.

## Disk writes

- Frontend state (tabs, layout) is saved through a zustand storage wrapper that skips unchanged
  values and writes at most once per second, flushing when the window closes.
- Settings are written only on an explicit save. Kubeconfig file watching is debounced, because
  editors emit several events per save.
- Window size, position and maximised state are saved by `tauri-plugin-window-state`.

## Permissions

- SelfSubjectAccessReview results are cached for 10 minutes per (cluster, resource, namespace), covering every
  action at once. Reconnecting a cluster clears its cached permissions.

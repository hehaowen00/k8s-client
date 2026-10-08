# Kube Portal

A Kubernetes IDE in the spirit of Lens, built with Tauri 2 + React. Unlike Lens, everything opens in **tabs**,
so you can keep several clusters, resource lists, logs, shells and Helm releases open side by side (or in a
split view).

## Features

Feature parity with Lens is tracked item by item in [`ROADMAP.md`](ROADMAP.md).

- **Tabs & layout**: any mix of cluster views, object details, logs, shells, terminals, manifests, port
  forwards and settings. Drag to reorder, middle-click to close, right-click to duplicate / close others /
  open in a **right split**. Tabs are restored on restart. A **command palette** (Mod+Shift+P / Mod+K)
  jumps to any cluster, tab, resource type or command. Pinned clusters live in a **hotbar**.
- **Dock**: logs, shells, attach sessions and terminals open in a dock at the bottom of the tab you're
  working in, as sub-tabs. Every cluster or detail tab has its own dock, so several tabs on the same
  cluster keep separate sessions. Minimise with Mod+J, drag to resize, or pop an item out into its own tab.
- **Clusters**: contexts from `$KUBECONFIG` / `~/.kube/config`, **kubeconfig folders** (any file name;
  invalid files ignored; changes picked up live), and kubeconfigs **pasted** into Kube Portal. Per-cluster
  display name, colour, default namespace, accessible namespaces (for users who can't list namespaces) and
  HTTP/SOCKS proxy.
- **Cluster overview**: nodes, pods, namespaces and warnings at a glance; CPU / memory / pod capacity
  meters; usage charts; workload health per kind; node table; recent warning events.
- **Resources**: every API resource including CRDs, with kubectl-style columns from the API server's Table
  rendering, kept live by watches. Filter, sort, wide columns, choose/hide/reorder columns, multi-namespace
  selection, sidebar counts, virtual scrolling, CPU/memory columns for pods and nodes.
- **Details**: overview (kind-specific panels for pods, workloads, services, ingresses, config maps,
  secrets, nodes, PVC/PV/StorageClass, jobs, cron jobs, HPAs, RBAC, CRDs), related pods / endpoints / child
  jobs, metrics charts, YAML editor, events.
- **Actions**: logs, shell, attach, port-forward, scale, restart, delete (single or bulk), cordon /
  uncordon / drain, node shell, trigger / suspend cron jobs, create from templates, server-side apply.
  Actions you're not allowed to perform are disabled (SelfSubjectAccessReview).
- **Logs**: single container, all containers, or a whole workload (following rollouts); tail, since,
  timestamps, previous, wrap, ANSI colours, search / filter, pod filter, save.
- **Terminals**: pod shells and attach (Ghostty VT via ghostty-web), and cluster terminals: a local shell with
  `KUBECONFIG` scoped to that cluster (and its proxy), using a kubectl downloaded to match the cluster version.
- **Metrics**: live usage from metrics-server; history from Prometheus when present (auto-detected and
  queried through the API server's service proxy), otherwise sampled while Kube Portal is open.
- **Helm**: releases (details, values, manifest, history, upgrade, rollback, uninstall), chart browser with
  README / values / install, repository management. Uses your `helm` CLI and repositories.
- **Port forwarding** for pods and services, with open-in-browser and a list of active forwards.
- **MCP server** (off by default): a read-only MCP endpoint on `127.0.0.1` for AI assistants. Per cluster you
  choose the resource types, namespaces, and whether full objects (Secret values always redacted), logs and
  events are shared; otherwise only `kubectl get`-style rows are. Every request is shown in an access log.
- **Settings** (app menu, Mod+, or the command palette): app-wide theme (system / dark / light), kubeconfig
  sources, Helm / kubectl / shell, extensions, updates and the MCP server; each cluster has its own settings page (name, colour, icon,
  namespaces, proxy, MCP access) from its context menu or the command palette.

## Shortcuts

**Mod** is Cmd on macOS, Super on Linux, and Ctrl or the Windows key on Windows. On Windows, Ctrl shortcuts other
than tab switching go to the shell while a terminal is focused (the Windows key still works).

| Keys | Action |
| --- | --- |
| Mod+T / Mod+W | New / close tab |
| Mod+Tab / Mod+Shift+Tab, Mod+PgDn / PgUp (Ctrl+Tab on macOS) | Next / previous tab |
| Mod+1…9 | Jump to tab (9 = last) |
| Mod+Shift+P, Mod+K | Command palette |
| Mod+\\ | Toggle split view |
| Mod+J | Minimise / restore the dock |
| Mod+, | Settings |
| Mod+S | Save (YAML editor) / apply (Apply Manifest) |
| Cmd+C / V (macOS), Ctrl+Shift+C / V | Copy / paste in a terminal |
| Cmd-click (macOS), Ctrl-click, middle-click | Open a cluster, resource type or object in a background tab |
| Double-click / Enter | Open an object in a new tab |
| Right-click a column header | Choose columns (drag headers to reorder) |

## Install

`make install` rebuilds the app, packages it and installs it:

| OS | What it does |
| --- | --- |
| macOS | Builds `Kube Portal.app` and copies it to `/Applications` (`APP_DIR=…` to change) |
| Linux | Installs `kube-portal` to `~/.local/bin` with a desktop entry and icons (`sudo make install PREFIX=/usr/local` for system-wide) |
| Windows | Builds the NSIS installer and runs it silently (per-user; Start menu entry). Run from Git Bash / MSYS `make` |

`make uninstall` removes it again (settings are kept). `make help` lists all targets (`run`, `build`, `package`,
`fmt`, `test`, `prune`, `clean`, and `macos-install` / `linux-install` / `windows-install` to install for a
specific OS). macOS builds are ad-hoc signed; pass `SIGN_ID="Developer ID Application: …"` to
sign for distribution.

## Development

Requires Rust, Node + pnpm, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/).
Helm features need the `helm` CLI on PATH (or a path in Settings).

```sh
pnpm install
pnpm tauri dev      # run in development
pnpm tauri build    # produce a release bundle
make fmt            # format TypeScript (Prettier) and Rust (rustfmt)
make test           # type-check, format check, Rust tests and clippy
```

### Where things are stored

- Settings: `~/.config/kube-portal/settings.db` (`$XDG_CONFIG_HOME/kube-portal` if set).
- Pasted kubeconfigs: `kubeconfigs/` in the same dir (owner-only permissions).
- Extensions: `extensions/` in the same dir.
- Downloaded kubectl binaries: `bin/` in the app data dir.
- Scoped kubeconfigs for terminals and Helm: `kubeconfigs/` in the app cache dir (owner-only).

## Extensions

Kube Portal loads ES modules from `extensions/<id>/` (Settings → Extensions → Open extensions folder). Each
folder has an optional `extension.json` (`name`, `version`, `description`, `main`) and a module
(default `index.js`) whose default export receives the `portal` API:

```js
export default function activate(portal) {
  portal.registerCommand({ id: "hello", label: "Say hello", run: () => portal.ui.toast("Hello") });
  portal.registerResourceAction({ label: "Do something", kinds: [{ group: "", kind: "Pod" }], run: (target) => {} });
  portal.registerDetailPanel({ title: "My panel", kinds: [{ group: "apps", kind: "Deployment" }], render: (el, obj) => {} });
  portal.registerPage({ title: "My page", render: (el, { context, namespace }) => {} });
  // portal.k8s: contexts, discover, namespaces, list, get, getYaml, apply, patch, delete, podMetrics
}
```

See [`examples/extensions/image-inventory`](examples/extensions/image-inventory) for a complete example.
Extensions are trusted code with the same access as Kube Portal (as with Lens); Lens extensions themselves
aren't compatible because they depend on Lens and Electron internals.

## Releases & auto-update

Kube Portal has no central update server; updates come from a feed you publish:

1. Generate a signing key once: `pnpm tauri signer generate -w ~/.tauri/portal.key` (keep the private key
   secret; the `.pub` file is the public key).
2. Build with `TAURI_SIGNING_PRIVATE_KEY` set and `"createUpdaterArtifacts": true` under `bundle` in
   `tauri.conf.json`, then publish the bundles, their `.sig` files and a `latest.json` (e.g. as GitHub
   release assets).
3. In Settings → Updates, set the feed URL (e.g.
   `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`) and the public key.

## Layout

- `src-tauri/src/`: `kube_ops.rs` (discovery, live tables, object ops, counts, access checks),
  `kubeconfigs.rs` / `settings.rs` (sources, settings, watcher), `streams.rs` / `multi_logs.rs` (logs, exec,
  attach, PTY), `portforward.rs`, `nodeops.rs` (drain, node shell, cron jobs), `metrics.rs` (metrics-server,
  Prometheus, overview), `helm.rs`, `kubectl.rs`, `updates.rs`, `extensions.rs`, `mcp.rs` (MCP server)
- `src/`: `store.ts` (tabs), `settings.ts`, `extensions.ts`, `metrics.ts`, `permissions.ts`, `views/`,
  `components/`

// Example Kubetab extension. Copy this folder into Kubetab's extensions folder
// (Settings → Extensions → Open extensions folder), then Reload extensions.
//
// `kubetab` API:
//   registerCommand({ id, label, run })                       → command palette
//   registerResourceAction({ label, kinds?, run(target) })    → right-click menu on resources
//   registerDetailPanel({ title, kinds?, render(el, obj, target) }) → section in detail views
//   registerPage({ title, render(el, { context, namespace }) })     → sidebar page under "Extensions"
//   ui.toast / ui.openDetail / ui.openTerminal
//   k8s.contexts / discover / namespaces / list / get / getYaml / apply / patch / delete / podMetrics
// `kinds` entries look like { group: "apps", kind: "Deployment" } (group "" = core).

const WORKLOADS = [
  { group: "apps", kind: "Deployment" },
  { group: "apps", kind: "StatefulSet" },
  { group: "apps", kind: "DaemonSet" },
];

// Pods carry containers directly; workloads under spec.template.
const podSpecOf = (obj) => (obj.spec?.containers ? obj.spec : obj.spec?.template?.spec) ?? {};
const imagesOf = (obj) => [...(podSpecOf(obj).initContainers ?? []), ...(podSpecOf(obj).containers ?? [])].map((c) => c.image);

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

export default function activate(kubetab) {
  kubetab.registerCommand({
    id: "about",
    label: "Image Inventory: About",
    run: () => kubetab.ui.toast(`Image Inventory example running on Kubetab ${kubetab.version}`),
  });

  kubetab.registerResourceAction({
    label: "Copy Container Images",
    kinds: [{ group: "", kind: "Pod" }, ...WORKLOADS],
    async run(target) {
      const obj = await kubetab.k8s.get(target);
      const images = imagesOf(obj);
      await navigator.clipboard.writeText(images.join("\n"));
      kubetab.ui.toast(`Copied ${images.length} image${images.length === 1 ? "" : "s"}`);
    },
  });

  kubetab.registerDetailPanel({
    title: "Images",
    kinds: WORKLOADS,
    render(root, obj) {
      const list = el("ul", { className: "ext-images" });
      for (const c of podSpecOf(obj).containers ?? []) {
        list.append(el("li", {}, el("strong", { textContent: c.name }), ` ${c.image}`));
      }
      root.append(list);
    },
  });

  kubetab.registerPage({
    title: "Image Inventory",
    render(root, { context, namespace }) {
      let cancelled = false;
      root.append(el("div", { className: "muted", textContent: "Loading pods…" }));
      (async () => {
        const resources = await kubetab.k8s.discover(context);
        const pods = resources.find((r) => r.group === "" && r.kind === "Pod");
        // Several selected namespaces are comma-separated; list each (or all).
        const namespaces = namespace ? namespace.split(",") : [null];
        const all = (await Promise.all(namespaces.map((ns) => kubetab.k8s.list(context, pods, ns)))).flat();
        if (cancelled) return;
        const counts = new Map();
        for (const p of all) for (const img of imagesOf(p)) counts.set(img, (counts.get(img) ?? 0) + 1);
        const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const table = el(
          "table",
          { className: "dtable" },
          el("thead", {}, el("tr", {}, el("th", { textContent: "Image" }), el("th", { textContent: "Pods" }))),
          el("tbody", {}, ...rows.map(([img, n]) => el("tr", {}, el("td", { className: "mono", textContent: img }), el("td", { textContent: String(n) })))),
        );
        root.replaceChildren(el("p", { className: "muted", textContent: `${rows.length} images across ${all.length} pods` }), table);
      })().catch((e) => !cancelled && root.replaceChildren(el("div", { className: "error-box", textContent: String(e) })));
      return () => {
        cancelled = true;
      };
    },
  });
}

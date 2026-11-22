# Pending

## Waiting on the user

- **Ports section on deployment detail** (2026-10-15, 9764652): deployments have no ports section; Forward and Stop sit on pod container ports and service ports in `src/views/DetailView.tsx`. Options: add a ports section to workloads that forwards to a ready pod, or leave it as is.

## Next

- **Side-by-side logs prototype** (2026-10-30, ad62888): the dock in `src/components/Dock.tsx` can show all its items as columns (◫ in the dock bar), and checking pods in the table then pressing Logs opens them side by side. Not yet tried in the app. Open questions: equal-width columns only (no dragging the dividers between them); no way to stack logs vertically or choose which items share the split; the dock may need a maximise to give logs the full tab height; the side-by-side setting isn't restored because docks aren't saved across restarts.

## Later

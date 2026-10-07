import { isBackgroundClick } from "./keys";
import { createContext, useContext } from "react";
import { openDetail, type Target } from "./actions";

/**
 * Provided by a cluster view around its content: shows an object in that view's own list
 * (switching resource type and selecting it) instead of opening a separate detail tab.
 */
export const ClusterNavContext = createContext<{ context: string; show: (t: Target) => void } | null>(null);

/**
 * Open a linked object (an owner, a related pod, a node…). Inside a cluster view on the same
 * cluster it's shown in that view's list; otherwise, or when `background`, in a detail tab.
 */
export function useOpenObject() {
  const nav = useContext(ClusterNavContext);
  return (t: Target, background = false) => {
    if (nav && !background && nav.context === t.context) nav.show(t);
    else openDetail(t, { background });
  };
}

export const inBackground = isBackgroundClick;

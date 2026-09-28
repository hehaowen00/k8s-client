import { createContext, useContext } from "react";
import type { ResourceInfo, Row } from "./api";

/**
 * Provided by a cluster view around its detail drawer: shows an object in the cluster view's own
 * list (switching resource type and selecting it) instead of opening a separate detail tab.
 */
export const ClusterNavContext = createContext<((resource: ResourceInfo, row: Row) => void) | null>(null);

export const useClusterNav = () => useContext(ClusterNavContext);

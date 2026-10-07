export type Platform = "mac" | "linux" | "windows";

export const platform: Platform = navigator.userAgent.includes("Mac")
  ? "mac"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "linux";

type Mods = { ctrlKey: boolean; metaKey: boolean };

/** App shortcut modifier: Cmd on macOS, Super on Linux, Ctrl or Super on Windows. */
export const isMod = (e: Mods) => (platform === "windows" ? e.ctrlKey || e.metaKey : e.metaKey);

/** Label for an app shortcut, e.g. shortcut("T") → "⌘T" / "Super+T" / "Ctrl+T". */
export function shortcut(key: string, opts?: { shift?: boolean }): string {
  if (platform === "mac") return `${opts?.shift ? "⇧" : ""}⌘${key}`;
  return `${platform === "linux" ? "Super" : "Ctrl"}+${opts?.shift ? "Shift+" : ""}${key}`;
}

export const nextTabLabel = platform === "mac" ? "⌃Tab" : shortcut("Tab");

/** Opening in a background tab follows the OS's link convention: Cmd-click on macOS, Ctrl-click elsewhere, or middle-click. */
export const isBackgroundClick = (e: Mods & { button: number }) =>
  (platform === "mac" ? e.metaKey : e.ctrlKey) || e.button === 1;

export const backgroundClickLabel = platform === "mac" ? "⌘-click" : "Ctrl-click";

/** Copy / paste inside the terminal: Cmd+C / V on macOS, Ctrl+Shift+C / V elsewhere (Ctrl+C is the shell's interrupt). */
export const terminalClipboardLabel = platform === "mac" ? "⌘C / ⌘V" : "Ctrl+Shift+C / V";

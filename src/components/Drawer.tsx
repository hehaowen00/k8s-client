import { useRef, useState } from "react";
import { usePref } from "../hooks";
import { S } from "../strings";

const MIN = 320;

/** Right-hand side pane with a draggable left edge; the width is remembered across sessions. */
export function Drawer({ children }: { children: React.ReactNode }) {
  const [saved, setSaved] = usePref<number | null>("drawer.width", null);
  const [width, setWidth] = useState(saved);
  const ref = useRef<HTMLDivElement>(null);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    // Leave room for the table beside the pane.
    const max = Math.max(MIN, (el.parentElement?.clientWidth ?? window.innerWidth) - 240);
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.min(max, Math.max(MIN, startW + (startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      setSaved(w);
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div ref={ref} className="drawer" style={width ? { width, maxWidth: "calc(100% - 240px)" } : undefined}>
      <div
        className="drawer-resize"
        onMouseDown={startResize}
        onDoubleClick={() => {
          setWidth(null);
          setSaved(null);
        }}
        title={S.common.dragToResizeOrReset}
      />
      {children}
    </div>
  );
}

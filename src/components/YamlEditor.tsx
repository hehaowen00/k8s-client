import { platform } from "../keys";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap, EditorView } from "@codemirror/view";
import { useMemo, useRef } from "react";
import { useResolvedTheme } from "../settings";

export function YamlEditor({
  value,
  onChange,
  onSave,
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}) {
  const theme = useResolvedTheme();
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const extensions = useMemo(
    () => [
      yaml(),
      EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--mono)" } }),
      keymap.of([
        {
          // CodeMirror's "Mod" is Ctrl on Linux; the app uses Super there.
          key: platform === "linux" ? "Meta-s" : "Mod-s",
          preventDefault: true,
          run: () => {
            saveRef.current?.();
            return true;
          },
        },
      ]),
    ],
    [],
  );
  return (
    <div className="yaml-editor">
      <CodeMirror
        value={value}
        height="100%"
        theme={theme === "dark" ? oneDark : "light"}
        extensions={extensions}
        readOnly={readOnly}
        onChange={onChange}
        basicSetup={{ foldGutter: true, highlightActiveLine: true, tabSize: 2 }}
      />
    </div>
  );
}

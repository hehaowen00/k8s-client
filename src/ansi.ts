// Minimal ANSI SGR renderer for log lines: 16/256/truecolor fg+bg, bold, dim, italic, underline.
// Non-SGR escape sequences are dropped.

export interface Segment {
  text: string;
  style?: React.CSSProperties;
}

const BASE = [
  "#1c1f26", "#ef6b73", "#8fd18b", "#e5c07b", "#7aa2ff", "#c678dd", "#56b6c2", "#d6dae3",
  "#5c6370", "#ff8a91", "#a9e5a5", "#f0d399", "#9bbaff", "#d99cf0", "#7fd0db", "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return BASE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;?]*)([A-Za-z])/g;
// eslint-disable-next-line no-control-regex
export const hasAnsi = (s: string) => s.includes("\x1b");
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

export function parseAnsi(input: string): Segment[] {
  const out: Segment[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  const style = (): React.CSSProperties | undefined => {
    if (!fg && !bg && !bold && !dim && !italic && !underline) return undefined;
    return {
      color: fg,
      background: bg,
      fontWeight: bold ? 700 : undefined,
      opacity: dim ? 0.7 : undefined,
      fontStyle: italic ? "italic" : undefined,
      textDecoration: underline ? "underline" : undefined,
    };
  };
  let last = 0;
  for (const m of input.matchAll(ESC)) {
    if (m.index! > last) out.push({ text: input.slice(last, m.index), style: style() });
    last = m.index! + m[0].length;
    if (m[2] !== "m") continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        fg = bg = undefined;
        bold = dim = italic = underline = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = dim = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) fg = BASE[c - 90 + 8];
      else if (c >= 40 && c <= 47) bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) bg = BASE[c - 100 + 8];
      else if (c === 39) fg = undefined;
      else if (c === 49) bg = undefined;
      else if (c === 38 || c === 48) {
        let value: string | undefined;
        if (codes[i + 1] === 5) {
          value = color256(codes[i + 2] ?? 0);
          i += 2;
        } else if (codes[i + 1] === 2) {
          value = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
          i += 4;
        }
        if (c === 38) fg = value;
        else bg = value;
      }
    }
  }
  if (last < input.length) out.push({ text: input.slice(last), style: style() });
  // Drop OSC sequences (e.g. hyperlinks) that slipped through.
  return out.map((s) => ({ ...s, text: stripAnsi(s.text) })).filter((s) => s.text);
}

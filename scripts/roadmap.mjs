import { readFileSync } from "node:fs";

const todoOnly = process.argv.includes("--todo");
const lines = readFileSync(new URL("../ROADMAP.md", import.meta.url), "utf8").split("\n");

const sections = [];
for (const line of lines) {
  const heading = line.match(/^## (.+)/);
  if (heading) {
    sections.push({ name: heading[1], items: [] });
    continue;
  }
  const item = line.match(/^- \[([ x~])\] (.+)/);
  if (item && sections.length) sections.at(-1).items.push({ mark: item[1], text: item[2] });
}

const count = (items, mark) => items.filter((i) => i.mark === mark).length;
const all = sections.flatMap((s) => s.items);

for (const { name, items } of sections) {
  if (todoOnly) {
    const left = items.filter((i) => i.mark !== "x");
    if (!left.length) continue;
    console.log(`\n${name}`);
    for (const i of left) console.log(`  [${i.mark}] ${i.text}`);
  } else {
    console.log(`${name.padEnd(28)} ${count(items, "x")}/${items.length} done, ${count(items, "~")} partial`);
  }
}

const done = count(all, "x");
const pct = all.length ? Math.round((done / all.length) * 100) : 0;
console.log(
  `\nTotal: ${done}/${all.length} done (${pct}%), ${count(all, "~")} partial, ${count(all, " ")} not started`,
);

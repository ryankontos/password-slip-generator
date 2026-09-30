import { copyFile, mkdir } from "node:fs/promises";

// Ship the pinned browser bundle so the Mac launcher needs no Node runtime
// and the editor never requests a third-party CDN while handling passwords.
const destination = new URL("../web/vendor/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [source, target] of [["Sortable.min.js", "sortable.min.js"], ["LICENSE", "sortable.LICENSE"]]) {
  await copyFile(new URL(`../node_modules/sortablejs/${source}`, import.meta.url), new URL(target, destination));
}

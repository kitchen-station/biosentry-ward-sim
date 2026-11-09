// Streaming reader for the eICU-CRD Demo's .csv.gz tables, shared by the extract and the fit.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

export function parse(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** Calls visit(row) for each row of <folder>/<name>.csv.gz that keep(row) accepts. */
export async function rows(folder, name, visit, keep = () => true) {
  const stream = createReadStream(`${folder}/${name}.csv.gz`).pipe(createGunzip());
  let header = null;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!header) {
      header = parse(line);
      continue;
    }
    const cells = parse(line);
    const row = Object.fromEntries(header.map((key, i) => [key, cells[i]]));
    if (keep(row)) visit(row);
  }
}

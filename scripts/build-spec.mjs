#!/usr/bin/env node
// Converts the YAML specs in spec/ to the JSON files the CLI loads at runtime (no YAML parser needed at install).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "spec");
for (const name of ["runta-openapi", "runta-openapi.original"]) {
  const doc = parse(readFileSync(join(dir, `${name}.yaml`), "utf8"));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(doc) + "\n");
  console.log(`spec/${name}.json`);
}

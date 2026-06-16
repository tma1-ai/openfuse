import { mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy GreptimeDB migration `.sql` files into `dist` after `tsc` (which only emits `.js`/`.d.ts`).
 * `applyGreptimeMigrations` resolves them at runtime as `dist/greptime/migrations/*.sql` (see its
 * `MIGRATIONS_DIR`), so web/worker server tests that bootstrap the schema can read them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "greptime", "migrations");
const dest = join(here, "..", "dist", "greptime", "migrations");

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const file of readdirSync(src)) {
  if (!file.endsWith(".sql")) continue;
  copyFileSync(join(src, file), join(dest, file));
  copied += 1;
}
console.log(`[copy-greptime-migrations] copied ${copied} .sql file(s) to dist/greptime/migrations`);

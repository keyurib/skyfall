// Runs `vgpu check --require-validation` on each WGSL file and prints a one-line
// verdict per file plus every diagnostic. Exits non-zero if any file fails or warns.
// Usage: node scripts/check-wgsl.mjs [file.wgsl ...]   (defaults to src/shaders/*.wgsl)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SHADER_DIR = "src/shaders";
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(SHADER_DIR)
        .filter((name) => name.endsWith(".wgsl"))
        .map((name) => join(SHADER_DIR, name));

let failed = false;
for (const file of files) {
  const run = spawnSync("npx", ["vgpu", "check", file, "--require-validation"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.log(`FAIL  ${file}\n${run.stdout}${run.stderr}`);
    failed = true;
    continue;
  }
  const diagnostics = [...(report.diagnostics ?? [])];
  if (report.validation?.error) diagnostics.push(report.validation.error);
  const ok = run.status === 0 && report.validation?.ok === true && diagnostics.length === 0;
  const entryPoints = (report.reflection?.entryPoints ?? [])
    .map((entry) => `${entry.stage}:${entry.name}`)
    .join(", ");
  const bindings = (report.reflection?.bindings ?? []).map((binding) => binding.name).join(", ");
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${file}  validated=${report.validation?.ok}` +
      `  entry=[${entryPoints}]  bindings=[${bindings}]`
  );
  for (const diagnostic of diagnostics) {
    console.log(
      `      ${diagnostic.severity ?? "error"} ${diagnostic.code} line ${diagnostic.line}: ${diagnostic.message}`
    );
  }
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);

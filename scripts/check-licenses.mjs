// Fails CI when any installed dependency is licensed under a GPL/AGPL variant.
import { execFileSync } from "node:child_process";

const BLOCKED = /\b(A?GPL|LGPL)\b/i;

const raw = execFileSync("pnpm", ["-r", "licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const byLicense = JSON.parse(raw);

const offenders = Object.entries(byLicense)
  .filter(([license]) => BLOCKED.test(license))
  .flatMap(([license, pkgs]) => pkgs.map((p) => `${p.name}@${p.versions?.join(",")} (${license})`));

if (offenders.length > 0) {
  console.error("Blocked licences found:\n  " + offenders.join("\n  "));
  process.exit(1);
}
console.log(`Licence check passed (${Object.keys(byLicense).join(", ") || "no deps"}).`);

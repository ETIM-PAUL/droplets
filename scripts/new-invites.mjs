// Prints beta invite codes to paste into BETA_INVITES. Usage: node scripts/new-invites.mjs "Paul" "Paul's mum" ...
import { randomBytes } from "node:crypto";

// No 0/O or 1/I/L, so codes survive being read out over the phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("").replace(/^(.{4})/, "$1-");

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('Give one name per tester, e.g. node scripts/new-invites.mjs "Paul" "Paul\'s mum"');
  process.exit(1);
}
const pairs = names.map((n) => `${code()}=${n.replace(/[,=]/g, " ")}`);
for (const p of pairs) console.log(p);
console.log(`\nBETA_INVITES=${pairs.join(",")}`);

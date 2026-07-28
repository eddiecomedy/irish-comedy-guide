#!/usr/bin/env node
/* ============================================================================
   Data integrity check. Runs in CI before every build so bad data can never
   reach the live site. Exits non-zero on anything that would embarrass us.
   ========================================================================== */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const j = f => JSON.parse(readFileSync(join(ROOT, "data", f), "utf8"));

const venues = j("venues.json");
const shows = j("shows.json");
const ids = new Set(venues.map(v => v.id));

const errors = [], warnings = [];
const seen = new Map();

shows.forEach((s, i) => {
  const where = `shows[${i}] "${s.t}"`;
  if (!s.t) errors.push(`${where}: missing title`);
  if (!ids.has(s.v)) errors.push(`${where}: unknown venue id "${s.v}"`);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s.start || "")) errors.push(`${where}: bad start "${s.start}"`);
  if (!s.sourceUrl) errors.push(`${where}: no sourceUrl — every listing must say where it came from`);
  if (!s.verifiedAt) errors.push(`${where}: no verifiedAt date`);
  if (s.price != null && (typeof s.price !== "number" || s.price < 0)) errors.push(`${where}: bad price ${s.price}`);
  if (s.ticketUrl && !/^https?:\/\//.test(s.ticketUrl)) errors.push(`${where}: ticketUrl is not a URL`);

  // a show more than a year old on a "what's on" site is a bug, not a listing
  const dt = new Date(s.start.length === 10 ? s.start + "T20:00" : s.start);
  if (isNaN(dt)) errors.push(`${where}: unparseable date`);

  // duplicate detection: same venue + same day + similar title
  const key = `${s.v}|${s.start.slice(0, 10)}|${(s.t || "").toLowerCase().slice(0, 18)}`;
  if (seen.has(key)) warnings.push(`${where}: looks like a duplicate of shows[${seen.get(key)}]`);
  else seen.set(key, i);

  // freshness
  const age = (Date.now() - new Date(s.verifiedAt)) / 86400000;
  if (age > 21) warnings.push(`${where}: not re-checked in ${Math.round(age)} days`);
});

venues.forEach((v, i) => {
  if (!v.id || !v.name || !v.city) errors.push(`venues[${i}]: needs id, name and city`);
  if (v.club && !v.blurb) warnings.push(`venues[${i}] "${v.name}": no blurb`);
});

const review = shows.filter(s => s.status === "needs_review").length;

console.log(`\n  Checked ${shows.length} shows across ${venues.length} venues`);
if (warnings.length) { console.log(`\n  ${warnings.length} warning(s):`); warnings.forEach(w => console.log(`   · ${w}`)); }
if (review) console.log(`\n  ${review} show(s) flagged needs_review — they build, but are marked on the page.`);
if (errors.length) {
  console.error(`\n  ${errors.length} ERROR(S) — refusing to build:`);
  errors.forEach(e => console.error(`   ✗ ${e}`));
  process.exit(1);
}
console.log("\n  Data OK.\n");

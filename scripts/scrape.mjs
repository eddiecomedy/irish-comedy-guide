#!/usr/bin/env node
/* ============================================================================
   Irish Comedy Guide — listings collector
   ----------------------------------------------------------------------------
   Reads each venue's own site, extracts upcoming shows, and merges them into
   data/shows.json. Anything it isn't sure about is written with
   status:"needs_review" rather than published silently.

     node scripts/scrape.mjs                 all sources
     node scripts/scrape.mjs --only dolans   one source
     node scripts/scrape.mjs --dry-run       report only, write nothing
     node scripts/scrape.mjs --fixtures      run adapters against saved HTML

   DESIGN NOTES (these come from actually looking at all twelve venue sites):

   1. Most venue sites render their listings with JavaScript. A plain fetch()
      sees an empty shell. Those sources are marked `needs:"browser"` and are
      handled by Playwright, which is installed in CI only.

   2. NEVER let a language model summarise a page into listings unverified.
      During research an LLM-summarised fetch invented a compere's name on a
      Craic Den listing. Extraction here is deliberately mechanical — JSON-LD
      first, then narrow regex — and anything that can't be parsed mechanically
      goes to the review queue for a human, not to the site.

   3. Every row must carry sourceUrl + verifiedAt. scripts/check.mjs enforces it.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FIXTURES = args.includes("--fixtures");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const TODAY = new Date().toISOString().slice(0, 10);
const UA = "IrishComedyGuideBot/1.0 (+https://www.irishcomedyguide.ie/about; listings aggregator; contact hello@irishcomedyguide.ie)";

/* ------------------------------------------------------------------ utils */
const clean = s => String(s || "").replace(/\s+/g, " ").replace(/&amp;/g, "&")
  .replace(/&#8217;|&rsquo;/g, "’").replace(/&nbsp;/g, " ").trim();

async function getHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Pull every application/ld+json blob out of a page and flatten @graph. */
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      for (const node of [].concat(parsed["@graph"] || parsed)) out.push(node);
    } catch { /* malformed blobs are common and not worth failing over */ }
  }
  return out;
}

/** JSON-LD Event -> our show shape. Returns null when required fields are absent. */
function eventFromLd(node, venueId, sourceUrl) {
  if (!node || (node["@type"] !== "Event" && !String(node["@type"]).includes("Event"))) return null;
  if (!node.name || !node.startDate) return null;
  const start = node.startDate.length > 10 ? node.startDate.slice(0, 16) : node.startDate.slice(0, 10);
  const offer = [].concat(node.offers || [])[0];
  const price = offer && offer.price != null && offer.price !== "" ? Number(offer.price) : null;
  return {
    v: venueId,
    t: clean(node.name),
    type: "Club night",
    start,
    price: Number.isFinite(price) ? price : null,
    currency: offer?.priceCurrency || undefined,
    lineup: [].concat(node.performer || []).map(p => clean(p.name)).filter(Boolean),
    ticketUrl: offer?.url || node.url || undefined,
    sourceUrl,
    verifiedAt: TODAY,
    status: "published",
    soldOut: offer?.availability?.includes("SoldOut") || undefined
  };
}

/* ---------------------------------------------------------------- adapters */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const ADAPTERS = {
  /* Dolan's publishes clean server-rendered HTML — the best-behaved of the twelve.
     Titles, dates and Yapsody links are all in the markup. Times and prices are
     not, so every row lands with timeConfirmed:false. */
  dolans: {
    venue: "dolans",
    url: "https://www.dolans.ie/comedy",
    needs: "fetch",
    parse(html, url) {
      const shows = [];
      const re = /<a[^>]+href="(https?:\/\/[^"]*yapsody[^"]*|https?:\/\/www\.dolans\.ie\/gigs-events[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/gi;
      for (const m of html.matchAll(re)) {
        const [, href, inner] = m;
        const text = clean(inner.replace(/<[^>]+>/g, " "));
        const d = text.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})/i)
          || href.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
        if (!d) continue;
        const start = d.length === 4 && MONTHS[d[2]?.toLowerCase().slice(0, 3)]
          ? `${d[3]}-${String(MONTHS[d[2].toLowerCase().slice(0, 3)]).padStart(2, "0")}-${String(d[1]).padStart(2, "0")}`
          : `${d[1]}-${String(d[2]).padStart(2, "0")}-${String(d[3]).padStart(2, "0")}`;
        const title = clean(text.replace(/\d{1,2}\s+\w+\s+\d{4}/i, "").replace(/^[\s·|-]+/, ""));
        if (!title || title.length < 3) continue;
        shows.push({
          v: "dolans", t: title, type: "Tour show", start, price: null,
          lineup: [title.split(":")[0].trim()], ticketUrl: href, sourceUrl: url,
          verifiedAt: TODAY, status: "published", timeConfirmed: false, priceConfirmed: false
        });
      }
      return shows;
    }
  },

  /* CoCo sells everything through Eventbrite, whose event pages carry proper
     JSON-LD. Scrape the organiser page for links, then each event page. */
  coco: {
    venue: "coco",
    url: "https://www.eventbrite.ie/o/coco-comedy-club-37252111113",
    needs: "browser",
    async parseAsync(html, url, fetchPage) {
      const links = [...new Set([...html.matchAll(/https:\/\/www\.eventbrite\.[a-z.]+\/e\/[a-z0-9-]+-tickets-\d+/gi)].map(m => m[0]))];
      const shows = [];
      for (const link of links.slice(0, 40)) {
        try {
          const ev = jsonLd(await fetchPage(link)).map(n => eventFromLd(n, "coco", link)).find(Boolean);
          if (ev) shows.push(ev);
        } catch (e) { console.warn(`   ! ${link}: ${e.message}`); }
      }
      return shows;
    }
  },

  /* The Empire's individual event pages are server-rendered and consistent.
     The overview grid is a JS plugin, so collect event URLs with a browser. */
  empire: {
    venue: "empire",
    url: "https://www.thebelfastempire.com/music-hall/",
    needs: "browser",
    async parseAsync(html, url, fetchPage) {
      const links = [...new Set([...html.matchAll(/https:\/\/www\.thebelfastempire\.com\/music-hall\/[a-z0-9-]*laughs-back[a-z0-9-]*\//gi)].map(m => m[0]))];
      const shows = [];
      for (const link of links.slice(0, 20)) {
        const page = await fetchPage(link);
        const ld = jsonLd(page).map(n => eventFromLd(n, "empire", link)).find(Boolean);
        if (ld) { shows.push({ ...ld, currency: "GBP" }); continue; }
        const d = page.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
        if (!d) continue;
        const mth = String(Object.keys(MONTHS).indexOf(d[2].toLowerCase().slice(0, 3)) + 1).padStart(2, "0");
        shows.push({
          v: "empire", t: "The Empire Laughs Back", type: "Club night",
          start: `${d[3]}-${mth}-${String(d[1]).padStart(2, "0")}T21:00`,
          price: 12, currency: "GBP", lineup: [],
          ticketUrl: "https://www.empirelaughsback.com/", sourceUrl: link,
          verifiedAt: TODAY, status: "needs_review",
          notes: "Auto-collected without structured data — line-up not confirmed."
        });
      }
      return shows;
    }
  }
};

/* --------------------------------------------------------------- browser */
async function makeBrowserFetch() {
  let pw;
  try { pw = await import("playwright"); }
  catch {
    console.warn("  Playwright not installed — JavaScript-rendered sources will be skipped.");
    console.warn("  Install with:  npm i -D playwright && npx playwright install chromium\n");
    return null;
  }
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA });
  const get = async url => {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1200);
      return await page.content();
    } finally { await page.close(); }
  };
  get.close = () => browser.close();
  return get;
}

/* ------------------------------------------------------------------ merge */
function merge(existing, incoming) {
  const key = s => `${s.v}|${s.start.slice(0, 10)}|${(s.t || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)}`;
  const byKey = new Map(existing.map(s => [key(s), s]));
  let added = 0, updated = 0;
  for (const s of incoming) {
    const k = key(s);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, s); added++; continue; }
    // keep any human edits; only refresh volatile fields and the freshness stamp
    const next = { ...prev, verifiedAt: s.verifiedAt };
    for (const f of ["price", "ticketUrl", "soldOut"]) if (prev[f] == null && s[f] != null) next[f] = s[f];
    if (JSON.stringify(next) !== JSON.stringify(prev)) updated++;
    byKey.set(k, next);
  }
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const kept = [...byKey.values()].filter(s => s.start.slice(0, 10) >= cutoff);
  const dropped = byKey.size - kept.length;
  kept.sort((a, b) => a.start.localeCompare(b.start));
  return { shows: kept, added, updated, dropped };
}

/* -------------------------------------------------------------------- run */
async function main() {
  const showsPath = join(ROOT, "data", "shows.json");
  const existing = JSON.parse(readFileSync(showsPath, "utf8"));
  const names = Object.keys(ADAPTERS).filter(n => !ONLY || n === ONLY);
  let browserFetch = null;
  const collected = [];

  console.log(`\n  Irish Comedy Guide — collecting listings (${TODAY})`);
  console.log(`  Sources: ${names.join(", ")}${DRY ? "  [dry run]" : ""}\n`);

  for (const name of names) {
    const a = ADAPTERS[name];
    try {
      let html;
      if (FIXTURES) {
        const f = join(ROOT, "scripts", "fixtures", `${name}.html`);
        if (!existsSync(f)) { console.log(`  – ${name}: no fixture, skipped`); continue; }
        html = readFileSync(f, "utf8");
      } else if (a.needs === "browser") {
        browserFetch ||= await makeBrowserFetch();
        if (!browserFetch) { console.log(`  – ${name}: needs a browser, skipped`); continue; }
        html = await browserFetch(a.url);
      } else {
        html = await getHtml(a.url);
      }
      const pageFetch = FIXTURES ? async () => "" : (browserFetch || getHtml);
      const found = a.parseAsync ? await a.parseAsync(html, a.url, pageFetch) : a.parse(html, a.url);
      console.log(`  ✓ ${name}: ${found.length} show${found.length === 1 ? "" : "s"}`);
      collected.push(...found);
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  if (browserFetch?.close) await browserFetch.close();

  const { shows, added, updated, dropped } = merge(existing, collected);
  console.log(`\n  ${added} new · ${updated} refreshed · ${dropped} past show${dropped === 1 ? "" : "s"} archived`);
  const review = shows.filter(s => s.status === "needs_review");
  if (review.length) console.log(`  ${review.length} awaiting review`);

  if (DRY) { console.log("\n  Dry run — nothing written.\n"); return; }
  writeFileSync(showsPath, JSON.stringify(shows, null, 2) + "\n");
  console.log(`\n  Wrote ${shows.length} shows to data/shows.json\n`);
}

main().catch(e => { console.error(e); process.exit(1); });

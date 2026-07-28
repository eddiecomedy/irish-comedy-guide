#!/usr/bin/env node
/* ============================================================================
   Irish Comedy Guide — listings collector
   ----------------------------------------------------------------------------
   Reads each venue's own site, extracts upcoming shows, and merges them into
   data/shows.json. Anything it isn't sure about is written with
   status:"needs_review" rather than published silently.

     node scripts/scrape.mjs                all sources
     node scripts/scrape.mjs --only dolans  one source
     node scripts/scrape.mjs --dry-run      report only, write nothing
     node scripts/scrape.mjs --fixtures     run adapters against saved HTML

   DESIGN NOTES (these come from actually looking at all twelve venue sites):

   1. Most venue sites render their listings with JavaScript. A plain fetch()
      sees an empty shell. Those sources are marked `needs:"browser"` and are
      handled by Playwright, which is installed in CI only.

   2. NEVER let a language model summarise a page into listings unverified.
      During research an LLM-summarised fetch invented a compere's name on a
      Craic Den listing. Extraction here is deliberately mechanical — JSON-LD
      first, then narrow regex or a DOM query — and anything that can't be
      parsed mechanically goes to the review queue for a human, not to the site.

   3. Every row must carry sourceUrl + verifiedAt. scripts/check.mjs enforces it.

   4. SILENCE IS A FAILURE. Added 28 July 2026 after the Craic Den incident:
      the club with the most listings of the twelve showed one show on the site,
      because nothing was collecting it and nothing said so. A source that
      returns zero rows now fails the run loudly. An empty venue and a broken
      adapter look identical from the outside, so we treat both as broken.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

/* Line-up slots on some venue cards are labels, not people. These must never
   become comedian pages. Matched case-insensitively against the whole slot. */
const NOT_A_PERSON = [
  /^secret special guest/i,
  /^plus special guests/i,
  /^special guests?!?$/i,
  /^tbc$/i,
  /^battle of the bits$/i,
  /^craic den showcase show$/i,
  /^more (acts )?tba$/i
];
const isPerson = name => name && name.length > 1 && !NOT_A_PERSON.some(re => re.test(name.trim()));

const ADAPTERS = {
  /* Craic Den. The domain matters: craicdencomedy.ie does NOT resolve
     (NXDOMAIN) — the live site is craicdencomedyclub.com. /all-events/ renders
     its grid client-side and paginates behind a "Load More" button, eight cards
     at a time, to roughly 107. The button stays in the DOM after the last page,
     so we loop until the card count stops growing, not until the button goes.

     Page JSON-LD is only BreadcrumbList + Organization, so extraction is a DOM
     query over the cards. Per-show URLs use auto-generated slugs
     (…-2-2-3-2-…) that cannot be safely paired to cards by index, so the
     listing page itself is the honest sourceUrl. */
  craicden: {
    venue: "craicden",
    url: "https://craicdencomedyclub.com/all-events/",
    needs: "browser",
    loadMore: { selector: "button.defaultButton", maxRounds: 30, settleMs: 2000 },
    collectInPage() {
      // Runs inside the page. Mechanical only — no interpretation.
      const raw = document.body.innerText;
      const start = raw.indexOf("Our comedians have been seen on");
      const body = start >= 0 ? raw.slice(start) : raw;
      return body.split("TICKETS / INFO").slice(0, -1).map(chunk => {
        const lines = chunk.split("\n").map(s => s.trim()).filter(Boolean);
        const di = lines.findIndex(l => /^\d{2}\/\d{2}\/\d{4}$/.test(l));
        if (di < 0) return null;
        const time = [lines[di + 1], lines[di + 2]].find(l => /^\d{2}:\d{2}$/.test(l || "")) || null;
        const priceLine = lines.find(l => l.startsWith("Price Starts from:"));
        const locLine = lines.find(l => l.startsWith("Location:"));
        const pi = lines.indexOf(priceLine);
        if (pi < 1) return null;
        return {
          dmy: lines[di],
          time,
          title: lines[pi - 1],
          price: priceLine.replace("Price Starts from:", "").trim(),
          loc: locLine ? locLine.replace("Location:", "").trim() : "",
          perf: lines.slice(0, pi - 1).filter(l => !/^(ALL|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/.test(l) && !l.includes("Our comedians"))
        };
      }).filter(Boolean);
    },
    fromRows(rows, url) {
      const seen = new Set();
      const shows = [];
      for (const r of rows) {
        const [dd, mm, yyyy] = r.dmy.split("/");
        const date = `${yyyy}-${mm}-${dd}`;
        // The card title repeats the date ("The Big Friday Show – Jul 31 – 8:30PM").
        const title = clean(String(r.title).split(" – ")[0]);
        if (!title) continue;
        const key = `${date}|${r.time}|${title.toLowerCase()}`;
        if (seen.has(key)) continue;            // the site lists at least one show twice
        seen.add(key);
        const lineup = [...new Set(r.perf.map(clean))].filter(isPerson);
        const price = Number(String(r.price).replace(/[^\d.]/g, ""));
        shows.push({
          v: "craicden",
          t: title,
          type: "Club night",
          start: r.time ? `${date}T${r.time}` : date,
          price: Number.isFinite(price) && price > 0 ? price : null,
          currency: "EUR",
          lineup,
          venueNote: r.loc || undefined,   // label is inconsistent across cards
          ticketUrl: url,
          sourceUrl: url,
          verifiedAt: TODAY,
          status: r.time ? "published" : "needs_review",
          notes: r.time ? undefined : "Start time not published on the listing card."
        });
      }
      return shows;
    }
  },

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
          lineup: [title.split(":")[0].trim()].filter(isPerson), ticketUrl: href, sourceUrl: url,
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
          if (ev) shows.push({ ...ev, lineup: (ev.lineup || []).filter(isPerson) });
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
        if (ld) { shows.push({ ...ld, currency: "GBP", lineup: (ld.lineup || []).filter(isPerson) }); continue; }
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
async function makeBrowser() {
  let pw;
  try { pw = await import("playwright"); }
  catch {
    console.warn("   Playwright not installed — JavaScript-rendered sources will be skipped.");
    console.warn("   Install with: npm i -D playwright && npx playwright install chromium\n");
    return null;
  }
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA });

  /** Fetch a page's HTML. */
  const get = async url => {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1200);
      return await page.content();
    } finally { await page.close(); }
  };

  /**
   * Open a page, click through its "Load More" until the content stops
   * growing, then run the adapter's in-page collector. Returns plain data.
   */
  get.collect = async (url, { loadMore, collectInPage }) => {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(1500);
      if (loadMore) {
        let last = -1;
        for (let i = 0; i < loadMore.maxRounds; i++) {
          const count = await page.evaluate(fn => new Function(`return (${fn})()`)().length,
            collectInPage.toString()).catch(() => -1);
          if (count === last) break;            // button may persist past the last page
          last = count;
          const btn = await page.$(loadMore.selector);
          if (!btn) break;
          await btn.click().catch(() => {});
          await page.waitForTimeout(loadMore.settleMs);
        }
      }
      return await page.evaluate(fn => new Function(`return (${fn})()`)(), collectInPage.toString());
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
    if (prev.lineup?.length === 0 && s.lineup?.length) next.lineup = s.lineup;
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
  let browser = null;
  const collected = [];
  const report = [];      // { name, count, error }

  console.log(`\n  Irish Comedy Guide — collecting listings (${TODAY})`);
  console.log(`  Sources: ${names.join(", ")}${DRY ? "  [dry run]" : ""}\n`);

  for (const name of names) {
    const a = ADAPTERS[name];
    try {
      let found;
      if (FIXTURES) {
        const f = join(ROOT, "scripts", "fixtures", `${name}.html`);
        if (!existsSync(f)) { report.push({ name, count: 0, error: "no fixture", skipped: true }); console.log(`   – ${name}: no fixture, skipped`); continue; }
        const html = readFileSync(f, "utf8");
        found = a.parseAsync ? await a.parseAsync(html, a.url, async () => "") : (a.parse ? a.parse(html, a.url) : []);
      } else if (a.collectInPage) {
        browser ||= await makeBrowser();
        if (!browser) { report.push({ name, count: 0, error: "needs a browser", skipped: true }); console.log(`   – ${name}: needs a browser, skipped`); continue; }
        const rows = await browser.collect(a.url, a);
        found = a.fromRows(rows, a.url);
      } else if (a.needs === "browser") {
        browser ||= await makeBrowser();
        if (!browser) { report.push({ name, count: 0, error: "needs a browser", skipped: true }); console.log(`   – ${name}: needs a browser, skipped`); continue; }
        const html = await browser(a.url);
        found = a.parseAsync ? await a.parseAsync(html, a.url, browser) : a.parse(html, a.url);
      } else {
        const html = await getHtml(a.url);
        found = a.parseAsync ? await a.parseAsync(html, a.url, getHtml) : a.parse(html, a.url);
      }
      report.push({ name, count: found.length });
      console.log(`   ${found.length ? "✓" : "✗"} ${name}: ${found.length} show${found.length === 1 ? "" : "s"}`);
      collected.push(...found);
    } catch (e) {
      report.push({ name, count: 0, error: e.message });
      console.log(`   ✗ ${name}: ${e.message}`);
    }
  }
  if (browser?.close) await browser.close();

  const { shows, added, updated, dropped } = merge(existing, collected);
  console.log(`\n  ${added} new · ${updated} refreshed · ${dropped} past show${dropped === 1 ? "" : "s"} archived`);
  const review = shows.filter(s => s.status === "needs_review");
  if (review.length) console.log(`  ${review.length} awaiting review`);

  /* ---- silence is a failure -------------------------------------------
     Every venue in ADAPTERS runs a regular comedy programme. If one of them
     comes back with nothing, the adapter is broken, the site has changed, or
     the domain has moved — not "there is no comedy this month". Say so, and
     make the run fail, so it lands in the Actions log as red rather than as a
     quiet pull request with a venue silently missing. */
  const silent = report.filter(r => !r.skipped && r.count === 0);

  if (!DRY) {
    writeFileSync(showsPath, JSON.stringify(shows, null, 2) + "\n");
    console.log(`\n  Wrote ${shows.length} shows to data/shows.json`);
  } else {
    console.log("\n  Dry run — nothing written.");
  }

  if (silent.length) {
    console.error(`\n  ${silent.length} source${silent.length === 1 ? "" : "s"} returned nothing:`);
    for (const r of silent) console.error(`    ${r.name} — ${r.error || "fetched the page, found zero shows"}`);
    console.error("  A source with no shows is treated as broken. Check the adapter and the site.\n");
    process.exit(1);
  }
  console.log("");
}

main().catch(e => { console.error(e); process.exit(1); });

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
      returns zero rows is reported as broken. An empty venue and a broken
      adapter look identical from the outside, so we treat both as broken.

      But reporting must not suppress. The first version of this guard called
      process.exit(1), which killed the job before the pull-request step — so
      one dead source withheld the good listings from every other source, and
      turned "one venue is stale" into "tonight's update silently didn't
      happen". Exactly the failure it was written to prevent.

      So: this script exits 0 even when a source is silent. It writes the
      problem into the pull-request body and drops a marker file, and the
      workflow fails the run *after* the pull request is open. Loud and
      non-blocking, in that order.
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
/* We identify ourselves — a venue that objects should be able to find us rather
   than just block us. But the bare "IrishComedyGuideBot/1.0 (…)" form was being
   served different content by Squarespace-hosted sites: Dolan's and The Empire
   both returned pages with none of their event links in them, silently, while
   the same URLs fetched from a normal browser were full of them.

   So: the conventional `Mozilla/5.0 (compatible; Bot/version; +url)` form. It
   is no less honest — name, homepage and contact address are all still in
   there — it just isn't rejected by naive user-agent filters. */
const UA = "Mozilla/5.0 (compatible; IrishComedyGuideBot/1.0; +https://www.irishcomedyguide.ie/about; listings aggregator; contact hello@irishcomedyguide.ie)";

/* ------------------------------------------------------------------ utils */
const clean = s => String(s || "").replace(/\s+/g, " ").replace(/&amp;/g, "&")
  .replace(/&#8217;|&rsquo;/g, "’").replace(/&nbsp;/g, " ").trim();

async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-IE,en;q=0.9"
    },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/* When a listing page yields no event links, "found zero shows" is true but
   useless. Say what actually came back, so the next person can tell a blocked
   fetch from a redesigned page without re-running anything. */
function reportEmptyListing(name, html, marker) {
  const bytes = html ? html.length : 0;
  const seen = html && marker ? html.includes(marker) : false;
  console.warn(`   ! ${name}: listing page produced no event links — ${bytes} bytes fetched, ` +
    `marker ${JSON.stringify(marker)} ${seen ? "present (page changed?)" : "absent (blocked or wrong page?)"}`);
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

/* Some venues print a date with no year — The Empire renders "Tue 4 Aug". The
   weekday is the disambiguator: 4 Aug is a Tuesday in 2026 but a Monday in 2025
   and a Wednesday in 2027, so the printed day name identifies the year on its
   own. Returns null when nothing matches rather than assuming "this year",
   because a wrong year is a punter at a locked door twelve months early. */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function resolveYearByWeekday(day, month, weekday, fromYear) {
  const want = DAYS.indexOf(String(weekday).toLowerCase().slice(0, 3));
  if (want < 0) return null;
  for (const y of [fromYear, fromYear + 1]) {
    const d = new Date(Date.UTC(y, month - 1, day));
    if (d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d.getUTCDay() === want) return y;
  }
  return null;
}

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
    loadMore: { selector: "button.defaultButton", maxRounds: 40, settleMs: 3500 },
    // Must be a function *expression*, not object-method shorthand: this gets
    // serialised and re-parsed inside the browser, and `collectInPage() {…}`
    // is not a valid standalone expression on the other side.
    collectInPage: function () {
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

  /* Dolan's, Limerick.

     The old adapter here returned zero and nobody noticed until the silence
     guard existed. The reason: /comedy is a Squarespace page of image blocks.
     Every event link wraps a picture, so there is no anchor text to read — the
     regex only ever matched the "BOOK TICKETS HERE" buttons, which carry
     neither a title nor a date.

     The event pages, however, publish a clean JSON-LD Event including a real
     start time, which the old adapter never had (it wrote timeConfirmed:false
     on everything). So: harvest the dated event paths off the listing page,
     then read each event page properly. */
  dolans: {
    venue: "dolans",
    url: "https://www.dolans.ie/comedy",
    needs: "fetch",
    async parseAsync(html, url, fetchPage) {
      const paths = [...new Set(
        [...html.matchAll(/\/gigs-events-live-music-listings\/\d{4}\/\d{1,2}\/\d{1,2}\/[a-z0-9-]+/gi)]
          .map(m => m[0])
      )];
      if (!paths.length) reportEmptyListing("dolans", html, "gigs-events-live-music-listings");
      const shows = [];
      for (const path of paths.slice(0, 40)) {
        const link = `https://www.dolans.ie${path}`;
        try {
          const ev = jsonLd(await fetchPage(link)).map(n => eventFromLd(n, "dolans", link)).find(Boolean);
          if (!ev) continue;
          shows.push({
            ...ev,
            // JSON-LD name repeats the venue: "Neil Delamere (comedy) — Dolan's …"
            t: clean(ev.t.replace(/\s*[—–-]\s*Dolan'?s.*$/i, "")),
            type: "Tour show",
            currency: "EUR",
            // Dolan's publishes no performer list. The act is the title, but
            // deriving a person's name from it guesses wrong on show titles
            // like "Sheer Luck Holmes", so we leave it empty rather than
            // inventing comedian pages.
            lineup: [],
            ticketUrl: ev.ticketUrl || link,
            priceConfirmed: false
          });
        } catch (e) { console.warn(`   ! ${link}: ${e.message}`); }
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

  /* The Empire, Belfast.

     The overview grid is a JS plugin, so event URLs need a browser. The links
     were never the problem — the event pages were.

     The old adapter looked for "4 August 2026" and hardcoded a 21:00 start.
     The pages actually render "Tue 4 Aug" — abbreviated, and with no year at
     all — and carry no JSON-LD whatsoever, so it matched nothing and silently
     returned zero. The year comes from the weekday (see resolveYearByWeekday).

     What the page does publish is a DOORS time, not a stage time. Printing
     doors as the start would be a plain factual error, so the row carries the
     date only, with doors in the notes, and goes to review. GBP throughout. */
  empire: {
    venue: "empire",
    url: "https://www.thebelfastempire.com/music-hall/",
    needs: "browser",
    async parseAsync(html, url, fetchPage) {
      const links = [...new Set([...html.matchAll(/https:\/\/www\.thebelfastempire\.com\/music-hall\/[a-z0-9-]*laughs-back[a-z0-9-]*\//gi)].map(m => m[0]))];
      if (!links.length) reportEmptyListing("empire", html, "laughs-back");
      const shows = [];
      const thisYear = Number(TODAY.slice(0, 4));
      for (const link of links.slice(0, 30)) {
        let page;
        try { page = await fetchPage(link); }
        catch (e) { console.warn(`   ! ${link}: ${e.message}`); continue; }

        const ld = jsonLd(page).map(n => eventFromLd(n, "empire", link)).find(Boolean);
        if (ld) { shows.push({ ...ld, currency: "GBP", lineup: (ld.lineup || []).filter(isPerson) }); continue; }

        const text = clean(page.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
        const d = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i);
        if (!d) continue;
        const month = MONTHS[d[3].toLowerCase().slice(0, 3)];
        const day = Number(d[2]);
        const year = resolveYearByWeekday(day, month, d[1], thisYear);
        if (!year) continue;   // weekday and date disagree — don't guess

        const title = clean((page.match(/<title[^>]*>([\s\S]{0,160}?)<\/title>/i) || [])[1] || "")
          .replace(/\s*\|\s*The Belfast Empire.*$/i, "") || "The Empire Laughs Back";
        const doors = text.match(/Doors\s+(\d{1,2})[.:](\d{2})\s*(am|pm)/i);
        const price = text.match(/£\s?(\d+(?:\.\d{2})?)/);

        shows.push({
          v: "empire",
          t: title,
          type: "Club night",
          start: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
          price: price ? Number(price[1]) : null,
          currency: "GBP",
          lineup: [],
          ticketUrl: link,
          sourceUrl: link,
          verifiedAt: TODAY,
          status: "needs_review",
          notes: `Venue publishes doors${doors ? ` (${doors[1]}.${doors[2]}${doors[3].toLowerCase()})` : ""}, not stage time; year inferred from the printed weekday. Line-up not published.`
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
        // The button stays in the DOM after the final page — confirmed on Craic
        // Den — so we stop when the count stops growing, not when it goes away.
        //
        // But "unchanged once" is not "finished": a slow AJAX page can miss a
        // settle window and look done while there is more to come. The first
        // CI run stopped at 86 of 107 rows for exactly that reason. So require
        // two consecutive rounds with no growth before believing it.
        let last = -1, quiet = 0;
        for (let i = 0; i < loadMore.maxRounds; i++) {
          const count = await page.evaluate(collectInPage).then(r => r.length).catch(() => -1);
          if (count === last) {
            if (++quiet >= 2) break;
          } else {
            quiet = 0;
            last = count;
          }
          const btn = await page.$(loadMore.selector);
          if (!btn) break;
          await btn.click().catch(() => {});
          await page.waitForTimeout(loadMore.settleMs);
        }
      }
      return await page.evaluate(collectInPage);
    } finally { await page.close(); }
  };

  get.close = () => browser.close();
  return get;
}

/* ------------------------------------------------------------------ merge */
function merge(existing, incoming) {
  /* The key MUST include the start time, not just the date.
     It used to be date-only, and that silently ate every double-header: Craic
     Den runs 7.30pm and 9.30pm shows on Fridays and Saturdays under the same
     title, and the two collapsed into one row. The collector fetched 171 Craic
     Den shows and only 137 reached the file — 34 real, ticketed, on-sale shows
     vanished between collection and disk, with nothing reporting it.
     A duplicate row is visible in the pull request and costs a human ten
     seconds. A dropped row is invisible and costs a punter their evening. */
  const key = s => `${s.v}|${s.start}|${(s.t || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)}`;
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

  /* ---- silence is a failure, but it must not be a blockage --------------
     Every venue in ADAPTERS runs a regular comedy programme. If one comes back
     with nothing, the adapter is broken, the site has changed, or the domain
     has moved — not "there is no comedy this month". We say so loudly. We do
     not stop the other venues' listings from reaching the pull request. */
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
    console.error("  A source with no shows is treated as broken. Check the adapter and the site.");
    // Surface each one as a GitHub Actions annotation too.
    for (const r of silent) {
      console.log(`::error title=${r.name} collected nothing::${r.error || "Fetched the page and found zero shows. Treated as a broken adapter."}`);
    }
  }

  writeHandoff({ report, silent, shows, added, updated, dropped, review: review.length });
  console.log("");
}

/* Hand the run's outcome to the workflow: the pull-request title and body, and
   a marker file the final step checks so it can go red *after* the PR exists.
   Written to RUNNER_TEMP so none of it is ever committed to the repo. */
function writeHandoff({ report, silent, shows, added, updated, dropped, review }) {
  const tmp = process.env.RUNNER_TEMP;
  if (!tmp || DRY) return;

  const ok = report.filter(r => !r.skipped && r.count > 0);
  const lines = [];

  if (silent.length) {
    lines.push(`> [!WARNING]`);
    lines.push(`> **${silent.length} source${silent.length === 1 ? "" : "s"} returned no listings.** These venues all run regular`);
    lines.push(`> programmes, so zero rows means a broken adapter or a changed site, not a quiet month.`);
    lines.push(`> The listings below are still worth merging — they are just missing these venues.`);
    lines.push(">");   // stays inside the alert block; a bare blank line ends it
    for (const r of silent) lines.push(`> - **${r.name}** — ${r.error || "fetched the page, found zero shows"}`);
    lines.push("");
  }

  lines.push("Automatic listings collection.", "");
  lines.push(`**${shows.length} shows** · ${added} new · ${updated} refreshed · ${dropped} past show${dropped === 1 ? "" : "s"} archived · ${review} awaiting review`, "");
  lines.push("| Source | Shows |", "|---|---|");
  for (const r of ok) lines.push(`| ${r.name} | ${r.count} |`);
  for (const r of silent) lines.push(`| ${r.name} | **0 — broken** |`);
  lines.push("");
  lines.push("Review before merging. Anything the collector wasn't confident about is marked");
  lines.push('`"status": "needs_review"` in `data/shows.json` and shows a warning banner on its');
  lines.push("page until you clear it. Check especially:", "");
  lines.push("- new shows with a `needs_review` status");
  lines.push("- prices or times that changed");
  lines.push("- anything from a third-party source rather than the venue's own site");

  writeFileSync(join(tmp, "pr-body.md"), lines.join("\n") + "\n");
  writeFileSync(join(tmp, "pr-title.txt"),
    `${silent.length ? "⚠ " : ""}Listings update — ${shows.length} shows${silent.length ? `, ${silent.length} source${silent.length === 1 ? "" : "s"} broken` : ""}\n`);
  if (silent.length) {
    writeFileSync(join(tmp, "collector-silent"), silent.map(r => `${r.name}: ${r.error || "zero shows"}`).join("\n") + "\n");
  }
}

main().catch(e => { console.error(e); process.exit(1); });

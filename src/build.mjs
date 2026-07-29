#!/usr/bin/env node
/* ============================================================================
   Irish Comedy Guide — static site generator
   ----------------------------------------------------------------------------
   Zero dependencies. Reads /data/*.json, writes /dist.

     node src/build.mjs

   Output:
     dist/index.html                the app (listings, filters, map, everything)
     dist/shows/<slug>/index.html   one page per show, with Event structured data
     dist/clubs/<id>/index.html     one page per venue
     dist/comedians/<slug>/index.html
     dist/assets/{styles.css,app.js}
     dist/data/shows.json           the data, published so anyone can reuse it
     dist/sitemap.xml, dist/robots.txt
   ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SITE = process.env.SITE_URL || "https://www.irishcomedyguide.ie";

/* Search-engine visibility.
   Indexing is OFF unless ALLOW_INDEX=1 is set in the environment. While the
   site is in development we do not want half-built pages, a temporary
   kinsta.page hostname, or listings still being tuned turning up in Google —
   and a stray index is far harder to undo than to prevent.
   To go public: set ALLOW_INDEX=1 in Sevalla and redeploy. The build prints
   which mode it ran in, so this cannot quietly stay off at launch. */
const ALLOW_INDEX = process.env.ALLOW_INDEX === "1" || process.env.ALLOW_INDEX === "true";
const robotsMeta = ALLOW_INDEX ? "" : '<meta name="robots" content="noindex, nofollow">\n  ';

const read = p => readFileSync(join(ROOT, p), "utf8");
const readJson = p => JSON.parse(read(p));
const write = (rel, body) => {
  const full = join(DIST, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};

/* ---------------------------------------------------------------- helpers */
const slugify = s => String(s).toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const IE = "en-IE";
const fmtLong = d => d.toLocaleDateString(IE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = d => d.toLocaleDateString(IE, { weekday: "short", day: "numeric", month: "short" });
const fmtTime = d => d.toLocaleTimeString(IE, { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");

/* ------------------------------------------------------------------- data */
const venues = readJson("data/venues.json");
const comedians = readJson("data/comedians.json");
const rawShows = readJson("data/shows.json");
const site = readJson("data/site.json");

const venueById = Object.fromEntries(venues.map(v => [v.id, v]));

const shows = rawShows.map(s => {
  const venue = venueById[s.v];
  if (!venue) throw new Error(`Show "${s.t}" references unknown venue id "${s.v}"`);
  const dateOnly = s.start.length === 10;
  const dt = new Date(dateOnly ? `${s.start}T20:00:00` : `${s.start}:00`);
  const slug = `${slugify(s.t)}-${slugify(venue.name)}-${s.start.slice(0, 10)}`;
  const currency = s.currency || venue.currency || "EUR";
  return { ...s, venue, dt, slug, currency, timeConfirmed: s.timeConfirmed !== false && !dateOnly };
}).sort((a, b) => a.dt - b.dt);

const now = new Date();
const upcoming = shows.filter(s => s.dt >= new Date(now - 6 * 3600e3));
const published = upcoming.filter(s => s.status !== "needs_review");

const symbol = c => (c === "GBP" ? "\u00a3" : "\u20ac");
const price = s => s.price === 0 ? "Free" : s.price == null ? "Price TBC" : symbol(s.currency) + s.price;
const showsFor = name => upcoming.filter(s =>
  (s.lineup || []).some(n => n.replace(/\s*\(MC\)\s*/, "").trim() === name));

/* --------------------------------------------------------------- template */
function page({ title, description, canonical, body, jsonld, ogType = "website" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robotsMeta}<link rel="canonical" href="${SITE}${canonical}">
<meta property="og:site_name" content="Irish Comedy Guide">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${canonical}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/styles.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
${body}
</body>
</html>
`;
}

const header = active => `
<div class="topstrip"><div class="wrap">
  <span class="live"><span class="dot"></span> Updated Everyday<span class="tscount"> · ${published.length} shows listed</span></span>
  <span class="rt"><a href="/submit/">Add your gig — free</a><a href="/resources/">For comedians</a></span>
</div></div>
<header id="hdr"><div class="hwrap">
  <a class="brand" href="/">
    <svg class="mark" viewBox="-4 0 104 130" aria-label="Irish Comedy Guide"><use href="#icgMark"/></svg>
    <span class="bword"><span class="l1">IRISH <span class="g">COMEDY</span> GUIDE</span>
    <span class="l2">Live comedy · All 32 counties</span></span>
  </a>
  <nav>
    <button class="${active === "shows" ? "active" : ""}" onclick="location.href='/'">Comedy Shows</button>
    <button class="${active === "comedians" ? "active" : ""}" onclick="location.href='/comedians/'">Comedians</button>
    <button class="${active === "clubs" ? "active" : ""}" onclick="location.href='/clubs/'">Comedy Clubs</button>
    <a class="btn btn-orange btn-sm navcta" href="/submit/">Add a show</a>
  </nav>
</div></header>`;

const footer = `
<footer><div class="wrap">
  <div class="fbot">
    <span>© ${new Date().getFullYear()} Irish Comedy Guide · <a href="/">Home</a> · <a href="/clubs/">Comedy Clubs</a> · <a href="/comedians/">Comedians</a></span>
    <span>Listings gathered from venues' own sites. Always check with the venue before travelling.</span>
  </div>
</div></footer>`;

const MARK = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<linearGradient id="isleGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2FA96B"/><stop offset="1" stop-color="#0A5C37"/></linearGradient>
<symbol id="icgMark" viewBox="-4 0 104 130">
<path fill="url(#isleGrad)" stroke="rgba(255,255,255,.14)" stroke-width="1.4" stroke-linejoin="round" d="M58 6 L79 11 L85 22 L89 27 L84 29 L91 37 L88 40 L79 46 L76 48 L78 53 L81 65 L78 66 L80 69 L82 77 L79 88 L75 101 L65 103 L61 101 L49 108 L42 111 L37 118 L29 120 L14 122 L19 119 L7 119 L15 114 L4 110 L12 105 L3 103 L13 98 L12 94 L28 90 L11 87 L20 79 L24 72 L29 69 L10 65 L13 58 L18 52 L6 48 L11 38 L14 37 L26 40 L36 37 L43 32 L38 30 L32 26 L38 22 L41 13 L47 11 L53 9 Z"/>
<circle cx="41.5" cy="54" r="4.2" fill="#F26522"/><circle cx="60.5" cy="51.5" r="4.2" fill="#F26522"/>
<path d="M34 65 q16 16 31 3" fill="none" stroke="#F26522" stroke-width="5.8" stroke-linecap="round"/>
</symbol></defs></svg>`;

/* ------------------------------------------------------------ home / app */
function buildApp() {
  const shell = read("src/templates/shell.html");
  const data = {
    venues,
    comedians,
    shows: shows.map(({ venue, dt, ...s }) => s),
    tourNews: site.tourNews,
    news: site.news,
    resources: site.resources
  };
  const body = shell
    .replace("</body>", "")
    .concat(`
<script id="icg-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script src="/assets/app.js"></script>`);

  write("index.html", page({
    title: "Irish Comedy Guide — live comedy listings across Ireland",
    description: "Every live comedy show in Ireland in one place. Club nights, tours, open mics and improv across all 32 counties, updated everyday.",
    canonical: "/",
    body: `${MARK}
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
${body}`,
    jsonld: {
      "@context": "https://schema.org", "@type": "WebSite",
      name: "Irish Comedy Guide", url: SITE,
      potentialAction: { "@type": "SearchAction", target: `${SITE}/?q={search_term_string}`, "query-input": "required name=search_term_string" }
    }
  }));
}

/* -------------------------------------------------------------- show page */
function showPage(s) {
  const v = s.venue;
  const others = upcoming.filter(x => x.v === s.v && x.slug !== s.slug).slice(0, 6);
  const jsonld = {
    "@context": "https://schema.org", "@type": "Event",
    name: s.t,
    startDate: s.timeConfirmed ? s.start : s.start.slice(0, 10),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    description: s.desc || `${s.t} at ${v.name}, ${v.city}.`,
    url: `${SITE}/shows/${s.slug}/`,
    location: {
      "@type": "Place", name: v.name,
      address: { "@type": "PostalAddress", streetAddress: v.address || "", addressLocality: v.city, addressCountry: v.county === "Antrim" ? "GB" : "IE" },
      ...(v.coords ? { geo: { "@type": "GeoCoordinates", latitude: v.coords[0], longitude: v.coords[1] } } : {})
    },
    ...(s.lineup?.length ? { performer: s.lineup.map(n => ({ "@type": "Person", name: n.replace(/\s*\(MC\)\s*/, "").trim() })) } : {}),
    organizer: { "@type": "Organization", name: v.name, url: v.website },
    ...(s.price != null ? {
      offers: {
        "@type": "Offer", price: s.price, priceCurrency: s.currency,
        url: s.ticketUrl || v.website,
        availability: s.soldOut ? "https://schema.org/SoldOut" : "https://schema.org/InStock"
      }
    } : {})
  };

  const body = `${MARK}${header("shows")}
<article class="detail">
  <a class="back" href="/">← All comedy shows</a>
  <h1>${esc(s.t)}</h1>
  <p class="meta">${fmtLong(s.dt)}${s.timeConfirmed ? ` · ${fmtTime(s.dt)}` : " · time to be confirmed"} · ${esc(v.name)}, ${esc(v.city)}</p>
  ${s.status === "needs_review" ? `<div class="reviewflag"><b>Awaiting confirmation.</b> ${esc(s.notes || "These details came from a third-party listing rather than the venue's own site.")} Please check with the venue before travelling.</div>` : ""}
  ${s.desc ? `<p class="lead">${esc(s.desc)}</p>` : ""}
  <div class="facts"><dl>
    <dt>When</dt><dd>${fmtLong(s.dt)}${s.timeConfirmed ? `, ${fmtTime(s.dt)}` : ""}</dd>
    <dt>Where</dt><dd>${esc(v.name)}${v.address ? `<br>${esc(v.address)}` : ""}</dd>
    <dt>Type</dt><dd>${esc(s.type)}</dd>
    <dt>Price</dt><dd>${price(s)}${s.priceConfirmed === false ? " <span style=\"color:var(--muted-2)\">(to be confirmed)</span>" : ""}${s.soldOut ? " — sold out" : ""}</dd>
    ${s.lineup?.length ? `<dt>Line-up</dt><dd>${s.lineup.map(n => `<a href="/comedians/${slugify(n.replace(/\s*\(MC\)\s*/, "").trim())}/">${esc(n)}</a>`).join(", ")}</dd>` : ""}
  </dl></div>
  <div class="cta">
    ${s.ticketUrl ? `<a class="btn btn-orange btn-lg" href="${esc(s.ticketUrl)}" target="_blank" rel="noopener">${s.soldOut ? "Sold out — check the venue" : "Tickets"}</a>` : ""}
    <a class="btn btn-ghost btn-lg" href="/clubs/${v.id}/">About ${esc(v.name)}</a>
  </div>
  <p class="src">Listing checked ${esc(s.verifiedAt)} against <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">${esc(new URL(s.sourceUrl).hostname)}</a>. Irish Comedy Guide doesn't sell tickets — the link above goes to the venue or its ticket seller.</p>
  ${others.length ? `<div class="also"><h2>More at ${esc(v.name)}</h2>
  ${others.map(o => `<div class="srow" onclick="location.href='/shows/${o.slug}/'">
    <div class="dtile"><div class="mo">${o.dt.toLocaleDateString(IE, { month: "short" })}</div><div class="dd">${o.dt.getDate()}</div><div class="dw">${o.dt.toLocaleDateString(IE, { weekday: "short" })}</div></div>
    <div class="sbody"><div class="t">${esc(o.t)}</div><div class="v">${o.timeConfirmed ? fmtTime(o.dt) : "Time TBC"} · ${esc(o.venue.city)}</div></div>
    <div class="sright"><div class="pr">${price(o)}</div></div></div>`).join("")}</div>` : ""}
</article>${footer}`;

  write(`shows/${s.slug}/index.html`, page({
    title: `${s.t} — ${v.name}, ${v.city} — ${fmtShort(s.dt)}`,
    description: `${s.t} at ${v.name}, ${v.city} on ${fmtLong(s.dt)}. ${price(s)}. Live comedy listings from Irish Comedy Guide.`,
    canonical: `/shows/${s.slug}/`, body, jsonld, ogType: "event"
  }));
}

/* ------------------------------------------------------------- club pages */
function clubPage(v) {
  const list = upcoming.filter(s => s.v === v.id);
  const jsonld = {
    "@context": "https://schema.org", "@type": "ComedyClub",
    name: v.name, url: `${SITE}/clubs/${v.id}/`, sameAs: v.website ? [v.website] : undefined,
    description: v.blurb,
    address: { "@type": "PostalAddress", streetAddress: v.address || "", addressLocality: v.city, addressCountry: v.county === "Antrim" ? "GB" : "IE" },
    ...(v.coords ? { geo: { "@type": "GeoCoordinates", latitude: v.coords[0], longitude: v.coords[1] } } : {})
  };
  const body = `${MARK}${header("clubs")}
<article class="detail">
  <a class="back" href="/clubs/">← All comedy clubs</a>
  <h1>${esc(v.name)}</h1>
  <p class="meta">${esc(v.city)} · ${esc(v.nights)}</p>
  <p class="lead">${esc(v.blurb)}</p>
  <div class="facts"><dl>
    <dt>Address</dt><dd>${esc(v.address || "—")}</dd>
    <dt>Comedy nights</dt><dd>${esc(v.nights)}</dd>
    ${v.residencies?.length ? `<dt>Regular shows</dt><dd>${v.residencies.map(r => `${esc(r.night)} — ${esc(r.name)}${r.price != null ? ` (${r.price === 0 ? "free" : symbol(v.currency || "EUR") + r.price})` : ""}`).join("<br>")}</dd>` : ""}
    <dt>Tickets</dt><dd>${esc({ eventbrite: "Eventbrite", "own-store": "The venue's own site", yapsody: "Yapsody", none: "No tickets — free entry, turn up early" }[v.ticketing] || "See the venue")}</dd>
    ${v.website ? `<dt>Website</dt><dd><a href="${esc(v.website)}" target="_blank" rel="noopener">${esc(new URL(v.website).hostname)}</a></dd>` : ""}
  </dl></div>
  <div class="also"><h2>${list.length} upcoming show${list.length === 1 ? "" : "s"}</h2>
  ${list.map(o => `<div class="srow${v.featured ? " feat" : ""}" onclick="location.href='/shows/${o.slug}/'">
    <div class="dtile"><div class="mo">${o.dt.toLocaleDateString(IE, { month: "short" })}</div><div class="dd">${o.dt.getDate()}</div><div class="dw">${o.dt.toLocaleDateString(IE, { weekday: "short" })}</div></div>
    <div class="sbody"><div class="t">${esc(o.t)}</div><div class="v">${o.timeConfirmed ? fmtTime(o.dt) : "Time TBC"} · ${esc(o.type)}</div></div>
    <div class="sright"><div class="pr">${price(o)}</div></div></div>`).join("") || "<p style=\"color:var(--muted)\">Nothing listed right now. This club runs regular nights — check its own site for the latest.</p>"}
  </div>
</article>${footer}`;
  write(`clubs/${v.id}/index.html`, page({
    title: `${v.name}, ${v.city} — listings, address and what's on`,
    description: `${v.blurb.slice(0, 150)}`,
    canonical: `/clubs/${v.id}/`, body, jsonld
  }));
}

/* --------------------------------------------------------- comedian pages */
function comedianPage(c) {
  const list = showsFor(c.name);
  const body = `${MARK}${header("comedians")}
<article class="detail">
  <a class="back" href="/comedians/">← All comedians</a>
  <h1>${esc(c.name)}</h1>
  <p class="meta">${esc(c.from || "Comedian")}${list.length ? ` · ${list.length} upcoming date${list.length === 1 ? "" : "s"}` : ""}</p>
  ${c.bio ? `<p class="lead">${esc(c.bio)}</p>` : ""}
  <div class="also"><h2>Upcoming dates</h2>
  ${list.map(o => `<div class="srow" onclick="location.href='/shows/${o.slug}/'">
    <div class="dtile"><div class="mo">${o.dt.toLocaleDateString(IE, { month: "short" })}</div><div class="dd">${o.dt.getDate()}</div><div class="dw">${o.dt.toLocaleDateString(IE, { weekday: "short" })}</div></div>
    <div class="sbody"><div class="t">${esc(o.t)}</div><div class="v">${esc(o.venue.name)}, ${esc(o.venue.city)}</div></div>
    <div class="sright"><div class="pr">${price(o)}</div></div></div>`).join("") || "<p style=\"color:var(--muted)\">No dates listed at the moment.</p>"}
  </div>
</article>${footer}`;
  write(`comedians/${slugify(c.name)}/index.html`, page({
    title: `${c.name} — tour dates and gigs in Ireland`,
    description: `${c.name}${c.from ? ` (${c.from})` : ""} — upcoming live comedy dates in Ireland. ${c.bio || ""}`.slice(0, 200),
    canonical: `/comedians/${slugify(c.name)}/`, body,
    jsonld: { "@context": "https://schema.org", "@type": "Person", name: c.name, jobTitle: "Comedian", url: `${SITE}/comedians/${slugify(c.name)}/`, ...(c.img ? { image: c.img } : {}) }
  }));
}

/* -------------------------------------------------------------- index pages */
function indexPage(kind, title, intro, cards) {
  write(`${kind}/index.html`, page({
    title, description: intro, canonical: `/${kind}/`,
    body: `${MARK}${header(kind)}
<div class="phead"><div class="wrap"><h1>${esc(title.split(" — ")[0])}</h1><p>${esc(intro)}</p></div></div>
<div class="wrap pbody">${cards}</div>${footer}`
  }));
}

/* -------------------------------------------------------------------- run */
function build() {
  if (existsSync(DIST)) rmSync(DIST, { recursive: true });
  mkdirSync(DIST, { recursive: true });

  buildApp();
  upcoming.forEach(showPage);
  venues.forEach(clubPage);
  comedians.forEach(comedianPage);

  const clubCards = venues.filter(v => v.club).map(v => {
    const n = upcoming.filter(s => s.v === v.id).length;
    return `<div class="clubcard" onclick="location.href='/clubs/${v.id}/'">
      <div class="clubtop" style="background:linear-gradient(135deg,${v.g[0]},${v.g[1]})"><span class="in">${v.name.split(/\s+/).map(w => w[0]).join("").slice(0, 3)}</span>${v.featured ? '<span class="pill pill-orange tag">Featured</span>' : ""}</div>
      <div class="clubbody"><h3>${esc(v.name)}</h3><span class="nights">${esc(v.nights)}</span>
      <div class="n"><span>${n} upcoming show${n === 1 ? "" : "s"}</span><span>→</span></div></div></div>`;
  }).join("");
  indexPage("clubs", "Comedy clubs — every regular comedy room in Ireland",
    "Ireland's regular comedy clubs, with addresses, what's on and how to get tickets.",
    `<div class="clubgrid" style="margin-top:0">${clubCards}</div>`);

  const comCards = comedians.map(c => {
    const n = showsFor(c.name).length;
    return `<div class="ccard" onclick="location.href='/comedians/${slugify(c.name)}/'">
      <div class="cphoto">${c.img ? `<img src="${c.img}" alt="${esc(c.name)}" loading="lazy">` : `<div class="nophoto"><span>${c.name.split(/\s+/).map(w => w[0]).join("").slice(0, 3)}</span></div>`}
      ${n ? `<span class="pill pill-orange badge">${n} date${n === 1 ? "" : "s"}</span>` : ""}
      <div class="over"><div class="n">${esc(c.name)}</div><div class="tn">${esc(c.from || "")}</div></div></div></div>`;
  }).join("");
  indexPage("comedians", "Irish comedians — who's playing where",
    "Comedians with upcoming live dates in Ireland, from arena headliners to the circuit's rising stars.",
    `<div class="tourgrid" style="margin-top:0">${comCards}</div>`);

  write("submit/index.html", page({
    title: "Submit a show — Irish Comedy Guide",
    description: "Running a comedy gig in Ireland? Tell us and we'll list it, free.",
    canonical: "/submit/",
    body: `${MARK}${header("")}<div class="phead"><div class="wrap"><h1>Submit a show</h1>
      <p>Running a gig? Tell us and we'll list it — free, always. Email the details to <a href="mailto:hello@irishcomedyguide.ie" style="color:var(--orange-lt);font-weight:800">hello@irishcomedyguide.ie</a> and we'll have it up, usually the same day.</p></div></div>${footer}`
  }));

  cpSync(join(ROOT, "src/assets"), join(DIST, "assets"), { recursive: true });
  write("data/shows.json", JSON.stringify(rawShows, null, 2));
  write("data/venues.json", JSON.stringify(venues, null, 2));

  const urls = ["/", "/clubs/", "/comedians/", "/submit/",
    ...upcoming.map(s => `/shows/${s.slug}/`),
    ...venues.map(v => `/clubs/${v.id}/`),
    ...comedians.map(c => `/comedians/${slugify(c.name)}/`)];
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${SITE}${u}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>`).join("\n")}
</urlset>`);
  write("robots.txt", ALLOW_INDEX
  ? `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`
  : `User-agent: *\nDisallow: /\n`);

  const review = upcoming.filter(s => s.status === "needs_review");
  console.log(`\n  Irish Comedy Guide — build complete`);
  console.log(ALLOW_INDEX ? "  Search engines: ALLOWED (ALLOW_INDEX is set)" : "  Search engines: BLOCKED — noindex meta + robots.txt Disallow. Set ALLOW_INDEX=1 to publish.");
  console.log(`  ${urls.length} pages · ${published.length} published shows · ${review.length} awaiting review`);
  console.log(`  ${venues.length} venues · ${comedians.length} comedians`);
  if (review.length) {
    console.log(`\n  Needs review before it can be trusted:`);
    review.forEach(s => console.log(`   · ${s.t} — ${s.venue.name}, ${s.start.slice(0, 10)} (${s.notes || "no note"})`));
  }
  console.log("");
}

build();

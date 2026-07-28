# Irish Comedy Guide

Live comedy listings for all 32 counties. A static site with no framework and no
dependencies — the whole thing is plain Node, so it builds in about a second and
there is nothing to keep up to date.

**Live listings data is real.** Every show in `data/shows.json` was read off a
venue's own site or ticket page and carries the URL it came from and the date it
was checked.

---

## Getting it running

You need Node 20 or newer. Nothing else.

```bash
git clone https://github.com/YOUR-USERNAME/irish-comedy-guide.git
cd irish-comedy-guide
npm run dev          # builds, then serves at http://localhost:4321
```

Other commands:

```bash
npm run build        # writes the site to dist/
npm run check        # validates the data — CI runs this before every build
npm run scrape       # collects fresh listings from the venues
npm run scrape:dry   # shows what it would collect, writes nothing
```

## How it fits together

```
data/           the whole site's content — edit these, everything else follows
  venues.json     the clubs and theatres, with addresses and scraping notes
  shows.json      every listing, with sourceUrl + verifiedAt on each one
  comedians.json  acts, photos, bios
  site.json       tour news, resources page, news page
src/
  build.mjs       the generator — reads data/, writes dist/
  templates/      the app shell (the interactive listings page)
  assets/         styles.css and app.js, copied through as-is
scripts/
  scrape.mjs      the listings collector, one adapter per venue
  check.mjs       data integrity gate
  serve.mjs       local preview server
dist/             generated. Not committed.
```

`src/build.mjs` produces:

- `/` — the interactive listings page: filters by city, date, type and price, plus
  the map, comedians, clubs and resources sections
- `/shows/<slug>/` — a real page for every single show, with schema.org `Event`
  structured data so Google can put it in event results
- `/clubs/<id>/` — a page per venue with address, regular nights and what's on
- `/comedians/<slug>/` — a page per act with their upcoming dates
- `sitemap.xml`, `robots.txt`

The per-show pages are the SEO engine. They're why the site is generated rather
than being one file.

## Deploying

The site is static, so hosting is free.

**Sevalla** (Kinsta's sister product, same company):

1. New → Static Site → connect this GitHub repo
2. Build command: `node src/build.mjs`
3. Publish directory: `dist`
4. Environment variable: `SITE_URL = https://www.irishcomedyguide.ie`

Every push to `main` redeploys. Netlify, Vercel and Cloudflare Pages take exactly
the same three settings if Sevalla ever disappoints.

## How listings stay current

`.github/workflows/scrape.yml` runs at 04:10 Irish time every night. It collects
from the venues, runs the integrity check, and **opens a pull request** rather
than pushing to the live site. Nothing goes public until you merge it.

Anything the collector isn't confident about is written with
`"status": "needs_review"`, which puts an amber "awaiting confirmation" banner on
that show's page until a human clears it. That is deliberate — see
[docs/SCRAPING.md](docs/SCRAPING.md) for why, including the one time an
AI-summarised page invented a compere's name during research.

## Adding a show by hand

Add an object to `data/shows.json`:

```json
{
  "v": "craicden",
  "t": "Friday Night Craic",
  "type": "Club night",
  "start": "2026-08-14T20:30",
  "price": 18,
  "lineup": ["Headliner TBA"],
  "ticketUrl": "https://...",
  "sourceUrl": "https://craicdencomedyclub.com/all-events/",
  "verifiedAt": "2026-08-01",
  "status": "published"
}
```

`v` must match a venue `id` in `venues.json`. `sourceUrl` and `verifiedAt` are
required — `npm run check` will refuse to build without them. Use `"start"` with
no time (`"2026-08-14"`) when the time isn't known; the page will say "time to be
confirmed" rather than guessing.

## Licence and credit

Listings link out to the venue or its ticket seller — this site never sells
tickets. Hero photograph by Ryan Spaulding on Unsplash.

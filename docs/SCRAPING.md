# What we learned looking at all twelve venue sites

Field notes from reading every source on 28 July 2026, before a line of the
collector was written. Read this before adding a new source — it will save you a
day.

## The headline finding: most of them are JavaScript

Well over half of Ireland's comedy venues publish their listings through a
client-side widget. Fetch the page with `curl` and you get a shell: navigation,
a filter bar, a "Load More" button, and no events at all. Any scraper built on
plain HTTP requests would quietly return nothing from these sites and look like
it was working.

That single fact shapes the whole design. Sources are tagged `needs: "fetch"` or
`needs: "browser"` in `scripts/scrape.mjs`, and the browser ones run through
Playwright in GitHub Actions.

## Source-by-source

| Venue | Renders | Ticketing | Verdict |
|---|---|---|---|
| **Dolan's**, Limerick | Server HTML | Yapsody | **Best source of the twelve.** Titles, dates and ticket links all in the markup. Times and prices are not on the listing page — needs a second fetch per show. |
| **CoCo Comedy Club**, Cork | Own site server-rendered, listings on Eventbrite | Eventbrite | Very good. Eventbrite event pages carry proper JSON-LD. Scrape the organiser page for links, then each event. |
| **The Empire**, Belfast | Individual pages server-rendered, grid is a JS plugin | Own site | Good. Event URLs are auto-generated slugs like `...laughs-back-2-2-2-2-2-2-3-2/` — match on the date in the page, never on the URL. Prices in **GBP**. |
| **International Comedy Club**, Dublin | Server-rendered WordPress | Eventbrite | Good. Wraps Eventbrite events at `/eventbrite-event/<slug>/`. Note it runs seven different branded nights, one per weekday. |
| **Cherry Comedy**, Dublin | Server-rendered | Own store | Readable, but during research `/tickets/` was showing dates already in the past. Check freshness before trusting it. Whelan's own ticket page is JS-gated. |
| **The Comedy Crunch**, Dublin | Server-rendered | None | Free walk-in night, no bookings, so there are no dated ticketed shows to collect. Model it as a standing residency, not as listings. |
| **Lavery's**, Belfast | Mostly server-rendered | Own site + ti.to | Use `laverys.com`, **not** `laverysbelfast.com`, which was unreachable. The show list itself sits in a JS booking widget. GBP. |
| **Craic Den**, Dublin | **JavaScript** | Eventbrite | The `/all-events/` grid loads by AJAX — a plain fetch sees only the filter UI. Go via the Eventbrite organiser feed instead. `robots.txt` blocks only WooCommerce paths. |
| **Róisín Dubh**, Galway | **JavaScript** | Own store | `/listings/` returns the site template and nothing else. Needs a browser. The homepage does expose a "tonight's show" widget. |
| **Pitchfork Comedy**, Dublin | **JavaScript** | Eventbrite | No standalone website. It's a recurring Eventbrite event and the individual date list is JS-rendered. |
| **Laughter Lounge**, Dublin | Unknown | Own store + Fever | Could not be fetched at all during research. Dated shows live at `/collections/<month-dates-year>`. Needs a direct look. |
| **City Limits**, Cork | **Broken** | Eventbrite | Its own `/gigs/` calendar renders "No events found" and empty placeholder cells. **The club is not closed** — it has shows booked into November — the widget is just broken. Real listings currently only reachable through entertainment.ie and purecork.ie. Worth telling the venue. |

## Why nothing is published without a source URL

During the research pass, an AI-summarised page fetch produced a Craic Den
listing whose compere was given as "Eddie Mullarkey" — the name on the account
running the research. It also carried a "sales have ended" flag on a future date.
Both details were invented by the summarising step, not present on the page.

That is the entire argument for how the collector works:

- **Extraction is mechanical.** JSON-LD first, then narrow regex. No language
  model turns a page into a listing.
- **Every row carries `sourceUrl` and `verifiedAt`.** `scripts/check.mjs` fails
  the build if either is missing, so an unsourced listing cannot reach the site.
- **Uncertainty is visible, not hidden.** Anything the collector can't parse
  cleanly gets `"status": "needs_review"`, which puts an amber banner on the
  page saying so, rather than presenting a guess as fact.
- **A human merges.** The nightly job opens a pull request. It never pushes to
  the live site.

A listings site's only real asset is that people believe it. One invented
line-up costs more than a hundred missing ones.

## Third-party sources

Where a venue's own site is unusable, entertainment.ie and purecork.ie carry
accurate-looking listings. Anything sourced that way is marked `needs_review`
with a note naming the aggregator, because it is one step further from the
venue and could be stale.

The better fix is a phone call. Several of these venues would happily send a
weekly schedule if asked, and a promoter-supplied feed beats any scraper.

## Rate limits and manners

- The collector identifies itself: `IrishComedyGuideBot/1.0` with a contact
  address, so a venue that objects can find us rather than just blocking us.
- One nightly pass. There is no reason to hit these sites more often — comedy
  listings do not change by the hour.
- Ticketing giants prohibit bulk scraping in their terms. We don't scrape them.
  We link out to them for tickets, which sends them buyers.

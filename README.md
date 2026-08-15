# Deal Engine

Two pages and a scraper for buying houses on numbers instead of feel.

| File | What it is |
|---|---|
| `index.html` | **Deal Finder.** Pulls live county appraisal records, filters them to your buy box, ranks every parcel best to worst, and gives you a walk-in offer for each. This is the front door. |
| `calc.html` | **Deal Engine.** Single-property underwriter — flip, rental, BRRRR and wholesale side by side, with a photo-based rehab estimator and a comps/ARV builder. Use it on the deal the Finder puts at the top. |
| `county_scraper.py` | Python 3, standard library only. Runs the same county queries from a computer when a county's server won't answer a browser directly, and builds absentee-owner mailing lists. |
| `docs/` | The McAllen market plan, the week-one execution kit, a setup guide, and the pipeline tracker spreadsheet. |

No build step. No dependencies. No API keys. Every page is a single self-contained HTML file — open one from your desktop and it works offline (minus the live county lookup).

---

## Deploy it

### Render

1. Push this repo to GitHub.
2. Render → **New → Static Site** → pick this repo.
3. Leave **Build Command** empty. Set **Publish Directory** to `.`
4. Create.

`render.yaml` is included, so if you use Render's Blueprint flow instead, it configures itself.

### Anywhere else

Netlify, Cloudflare Pages, GitHub Pages, or an S3 bucket — same story. Publish the repo root. There is nothing to build.

For **GitHub Pages**: Settings → Pages → Source: `main`, folder `/ (root)`. Live in about a minute at `https://<you>.github.io/DEAL-ENGINE/`.

---

## Where the data comes from

The Finder reads the **Hidalgo County Appraisal District 2026 certified roll**, published by the county on ArcGIS Online. 331,344 parcels. Public, no key, no login.

```
https://services9.arcgis.com/dwMDP55HTfoj4n1c/arcgis/rest/services/HCAD_PARCELS_2026/FeatureServer/1/query
```

Fields it uses:

| Purpose | Field |
|---|---|
| Property address | `situs` |
| Owner name | `name` |
| Owner mailing address | `addrDeliveryLine`, `addrCity`, `addrState`, `addrZip` |
| Living square footage | `imprvMainArea` |
| Year built | `imprvActualYearBuilt` |
| County market value | `marketValue` |
| Property class | `stateCd` (`A1` = single family) |
| Exemptions | `exemptions` |
| City filter | `taxingUnits` |

**On the city filter.** Roughly a quarter of `situs` values omit the city and read just `", TX"`, so filtering on the address text silently drops a quarter of the market. The taxing-unit code is exact, so that's what the page filters on:

| Code | City | | Code | City |
|---|---|---|---|---|
| CML | McAllen | | CDN | Donna |
| CEB | Edinburg | | CMC | Mercedes |
| CMS | Mission | | CAO | Alamo |
| CPR | Pharr | | CHD | Hidalgo |
| CWL | Weslaco | | CLJ | La Joya |
| CSJ | San Juan | | CPM | Palmview |
| | | | CAN | Alton |

To wire up a different county, add an entry to the `SRC` object near the bottom of `index.html`. Counties that aren't hand-mapped fall back to automatic discovery through the ArcGIS Hub catalog, which works often enough to be worth trying.


### Aerial photography

Every parcel gets a picture. The county query asks for `returnCentroid=true&outSR=4326`,
which returns one lat/lon point per parcel — far cheaper over the wire than the parcel
polygon, and all the map needs.

Those coordinates are rendered against **Esri World Imagery**, which is public, keyless
and unmetered:

```
https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

It's a *cached* tile service, so there is no "give me a picture centred here" endpoint.
The page computes the Web Mercator pixel position of the centroid, works out which 256px
tiles cover the frame, and offsets them with CSS so the parcel lands dead centre. Thumbnails
render at zoom 18, the opened card at zoom 19. Tiles are `loading="lazy"`, so scrolling a
long list doesn't fetch anything you haven't looked at.

Street View is a link rather than an embed — an embedded panorama needs a Google Maps API
key and a credit card, and a link opens the Maps app on a phone anyway.


### Adding a county yourself

Texas has 254 counties and no statewide source with living square footage, so counties
get wired in one at a time. Two are hand-verified — **Hidalgo** and **Cameron** — and the
app has an **Add a county** panel for the rest: paste a parcel layer's `/query` URL, it
reads the field list, guesses which column is which, you correct anything it got wrong,
test five rows, save. Stored on your phone, not on a server.

The two columns it can't work without are **address** and **living square footage**.
Everything else degrades gracefully — no exemptions column just means absentee owners
stop sorting to the top.

Two traps that a guessed mapping will walk straight into:

- **Class codes are not consistent between counties.** Hidalgo codes single-family `A1`.
  Cameron codes it `A` — asking Cameron for `A1` returns exactly one record countywide.
  Not an error, not an empty result. One house.
- **Situs city text is unreliable.** Cameron's has 200+ misspellings (`BROWNSVIILLE`,
  `SOYTH PADRE ISLAND`). Both hand-mapped counties filter on the taxing-unit code instead,
  which is exact. A county you add yourself falls back to text matching and says so in the
  status line.

### Street-level photos

Off unless you supply a key. Paste a **Google Street View Static API** key into the
*Street photos* panel and every opened property shows a photograph of the house above the
aerial.

```
https://maps.googleapis.com/maps/api/streetview?size=640x336&location=LAT,LON
  &fov=78&pitch=8&radius=70&source=outdoor&return_error_code=true&key=KEY
```

No `heading` is passed on purpose — with none given, Google aims the camera from the
nearest panorama toward the coordinates you asked for, which is the house.
`return_error_code=true` turns a missing panorama into a 404 rather than a grey placeholder,
so the frame removes itself and the aerial stands alone.

**10,000 image loads a month are free** (metadata calls are unlimited and free). Google
still requires a payment method on the Cloud account. Restrict the key two ways — HTTP
referrer to your own domain, and API restriction to Street View Static only — because the
key is visible in the page. Attribution is shown in the corner of the frame, and the
images are hotlinked live rather than re-hosted, which is what Google's terms require.

Zillow, Redfin and Realtor photos are MLS-licensed and off limits. This is the legitimate
way to see the house.

### What it will never touch

Zillow, Redfin, Realtor.com, and the MLS. Their terms forbid scraping and they ban aggressively. Everything here is public county appraisal data, which is exactly what the county publishes it for. If you want listing-side data, buy it from a licensed API — RentCast has a free tier that's enough to start.


---

## Install it as an app

It's a PWA, so it goes on a home screen like any other app — own icon, full
screen, no address bar, opens without a signal. No App Store, no review queue,
no $99 developer account, no Xcode.

**iPhone / iPad** — open the site in Safari, tap **Share**, then **Add to Home
Screen**. (It has to be Safari. Chrome on iOS can't install a PWA.) The site
shows a reminder bar the first time; dismiss it and it stays dismissed.

**Android** — Chrome offers an **Install** button on the same bar, or use menu
→ *Install app*.

**Desktop** — Chrome and Edge show an install icon in the address bar.

What it does offline: the pages, icons and any aerial tiles you've already
looked at are cached, so the app opens and the calculators work with no signal.
Live county lookups obviously need a connection — when there isn't one the app
says so and loads the demo set rather than showing you an empty screen.

The service worker deliberately caches three ways, because the three kinds of
request want opposite things:

| Request | Strategy | Why |
|---|---|---|
| The app itself | Network first, cache as fallback | A new deploy has to show up |
| County records | Network only, never cached | A stale market value is worse than none |
| Aerial tiles | Cache first, 400-tile cap | Imagery from last year is this year's imagery |

Bumping `VERSION` in `sw.js` retires every old cache on the next visit.

---

## How the ranking works

Two offer numbers get computed, and the **lower** one wins:

**The 70% rule** — `ARV × 0.70 − rehab`. Fast, conventional, what the seller's other buyer is probably using.

**Profit-backed** — solve for the purchase price that leaves exactly your target profit after every real cost: selling costs, rehab, holding, points, interest, taxes, insurance.

```
        ARV × (1 − sell%) − rehab − carry − rehabFinanced × k − targetProfit
price = ───────────────────────────────────────────────────────────────────
                     1 + buyClose% + (1 − down%) × k

        where k = points% + (rate%/12) × holdMonths
```

The score out of 100 weighs six things:

| Weight | Factor | Why |
|---:|---|---|
| 28 | Discount needed off the county's value | The single best predictor of whether a seller ever says yes |
| 20 | No homestead exemption | Nobody living in the house is mailing you back |
| 8 | Owner mails to another town | Those are the ones who sell |
| 16 | Dollars of profit vs. your target | |
| 15 | Rehab as a share of finished value | Rehab risk |
| 13 | Rental cash flow | Can you hold it if the flip stalls |

Two multiplicative penalties: rehab over your stated ceiling cuts the score by 45%, and needing more than 55% off cuts it by 65%. Nobody signs that.

**Read the scores as relative, not absolute.** In McAllen almost nothing clears 60, and that isn't a bug in the math — it's a 0.71% rent-to-price ratio against a 1.78% property tax rate. The ranking tells you which doors are worth a stamp, not which ones are layups.

---

## The scraper

```bash
python3 county_scraper.py --help

# absentee-owner list, ready to paste into the Finder's "Paste list" tab
python3 county_scraper.py --list --county hidalgo --city mcallen --out leads.csv

# local proxy, for counties whose servers refuse browser requests
python3 county_scraper.py --serve 8080
```

Python 3.8+. No pip install — standard library only.

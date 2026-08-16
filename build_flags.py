#!/usr/bin/env python3
"""
Build flags.json — the file the Deal Finder reads to mark a parcel FOR SALE or
TAX SALE.

Two sources, for two different reasons.

  RentCast /listings/sale   asking price and days on market. Not an MLS feed —
                            they assemble it from public feeds and directories,
                            so there is no MLS membership to obtain. Their terms
                            permit displaying the price and require no
                            attribution, but they DO require the key stay
                            confidential. That is the whole reason this runs
                            here, in a scheduled job, instead of in the phone.

  PBFCM tax resale PDFs     properties the county is selling for back taxes.
                            Free, no key. Keyed on the CAD Geographic ID with
                            the dashes stripped — NOT on PROP_ID. Joining on the
                            wrong identifier fails silently, which is the single
                            most likely place to ship a bug here.

Output: flags.json at the repo root, keyed both ways so the page can match on
whichever identifier a county happens to expose.

    python3 tools/build_flags.py --cities "McAllen,Edinburg,Mission,Brownsville"

RENTCAST_KEY may be unset — the tax-sale half still runs and still ships.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = "DealFinder/1.0 (+https://github.com/WSS5480/DEAL-ENGINE)"
RENTCAST = "https://api.rentcast.io/v1/listings/sale"

TAX_PDFS = {
    "Hidalgo": "https://pbfcm.com/docs/taxdocs/resales/hidalgotaxresale.pdf",
    "Cameron": "https://www.pbfcm.com/docs/taxdocs/sales/cameroncountytaxresale.pdf",
}

SUFFIX = re.compile(
    r"\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BOULEVARD|BLVD|COURT|CT"
    r"|CIRCLE|CIR|PLACE|PL|HIGHWAY|HWY)\b"
)


def norm_addr(a, z=""):
    """Must match normKey() in index.html character for character."""
    a = re.sub(r"[^A-Z0-9 ]", " ", str(a or "").upper())
    a = SUFFIX.sub("", a)
    a = re.sub(r"\s+", " ", a).strip()
    return a + ("|" + str(z)[:5] if z else "")


def norm_geo(g):
    return re.sub(r"[^A-Z0-9]", "", str(g or "").upper())


def get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- listings ---
def pull_listings(key, cities, state, limit=500):
    """One call per city. 500 records each, which covers a Valley city in one
    request. Only 200s are billed, so a miss costs nothing."""
    out, calls = {}, 0
    for city in cities:
        params = {
            "city": city.strip(),
            "state": state,
            "status": "Active",
            "limit": str(limit),
        }
        url = RENTCAST + "?" + urllib.parse.urlencode(params)
        try:
            body = get(url, {"X-Api-Key": key, "Accept": "application/json"})
            calls += 1
            rows = json.loads(body)
        except urllib.error.HTTPError as e:
            print(f"  {city}: HTTP {e.code} — {e.read()[:200]!r}", file=sys.stderr)
            continue
        except Exception as e:                                   # noqa: BLE001
            print(f"  {city}: {e}", file=sys.stderr)
            continue

        if not isinstance(rows, list):
            rows = rows.get("listings", []) if isinstance(rows, dict) else []

        for r in rows:
            addr = r.get("addressLine1") or r.get("formattedAddress") or ""
            zc = r.get("zipCode") or ""
            price = r.get("price")
            if not addr or not price:
                continue
            rec = {
                "sale": {
                    "price": int(price),
                    "days": r.get("daysOnMarket"),
                    "status": r.get("status") or "Active",
                    "listed": (r.get("listedDate") or "")[:10],
                    "mls": r.get("mlsNumber") or "",
                }
            }
            # both keyed forms: many county records carry no property ZIP at all,
            # so the page has to be able to match on the bare street too
            out[norm_addr(addr, zc)] = rec
            out.setdefault(norm_addr(addr, ""), rec)
        print(f"  {city}: {len(rows)} listings")
    return out, calls


# ---------------------------------------------------------------- tax sale ---
ACCT = re.compile(r"\b([A-Z]?\d[\dA-Z]{9,})\b")
MONEY = re.compile(r"\$?\s?([\d,]+\.\d{2}|[\d,]{4,})")


def parse_tax_pdf(url, county):
    """The PBFCM sheets are a fixed-column table. Pull the account number and
    the minimum bid off each line; skip anything that doesn't carry both."""
    try:
        raw = get(url)
    except Exception as e:                                       # noqa: BLE001
        print(f"  {county}: could not fetch — {e}", file=sys.stderr)
        return {}

    text = ""
    try:
        import pdfplumber                                        # noqa: PLC0415
        import io
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    except ImportError:
        print(f"  {county}: pdfplumber not installed — skipping", file=sys.stderr)
        return {}
    except Exception as e:                                       # noqa: BLE001
        print(f"  {county}: PDF unreadable — {e}", file=sys.stderr)
        return {}

    out = {}
    for line in text.splitlines():
        m = ACCT.search(line)
        if not m:
            continue
        acct = norm_geo(m.group(1))
        if len(acct) < 10:
            continue
        amounts = [float(x.replace(",", "")) for x in MONEY.findall(line)]
        amounts = [a for a in amounts if a >= 100]
        cause = ""
        cm = re.search(r"\b([A-Z]{1,3}-?\d{3,}-?[\dA-Z-]*)\b", line)
        if cm and cm.group(1) != m.group(1):
            cause = cm.group(1)
        out[acct] = {
            "tax": {
                "min": int(min(amounts)) if amounts else None,
                "cad": int(max(amounts)) if len(amounts) > 1 else None,
                "cause": cause,
                "county": county,
            }
        }
    print(f"  {county}: {len(out)} on the resale list")
    return out


# -------------------------------------------------------------------- main ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", default="McAllen,Edinburg,Mission,Pharr,Weslaco,"
                                        "Brownsville,Harlingen,San Benito")
    ap.add_argument("--state", default="TX")
    ap.add_argument("--out", default="flags.json")
    a = ap.parse_args()

    by_addr, by_geo, calls = {}, {}, 0

    key = os.environ.get("RENTCAST_KEY", "").strip()
    if key:
        print("Listings (RentCast):")
        by_addr, calls = pull_listings(key, a.cities.split(","), a.state)
    else:
        print("RENTCAST_KEY not set — skipping the for-sale half.")

    print("Tax resale lists (PBFCM):")
    for county, url in TAX_PDFS.items():
        for k, v in parse_tax_pdf(url, county).items():
            by_geo.setdefault(k, {}).update(v)

    doc = {
        "generated": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "apiCalls": calls,
        "byAddr": by_addr,
        "byGeo": by_geo,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))

    print(f"\n{a.out}: {len(by_addr)} for-sale, {len(by_geo)} tax-sale, "
          f"{calls} API calls used.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
county_scraper.py — local backend for Deal Engine.

Three jobs:
  1. /parcel   scrape county appraisal / parcel data from public ArcGIS portals
  2. /proxy    CORS proxy so the browser can call listing APIs (RentCast, ATTOM)
  3. /anthropic  CORS proxy for Claude vision calls on the Rehab tab

Stdlib only. No pip install. Python 3.8+.

    python3 county_scraper.py            # listens on http://localhost:8787
    python3 county_scraper.py --port 9000

Build a lead list instead of serving:

    python3 county_scraper.py --list "TX:Hidalgo" --city McAllen \\
        --absentee-only --no-homestead --out mcallen_leads.csv

Then in the app: Data Pull -> County scraper -> backend URL http://localhost:8787
and Data Pull -> Listing API -> proxy prefix http://localhost:8787/proxy?url=

--------------------------------------------------------------------------
WHAT THIS SCRAPES, AND WHY THAT'S THE RIGHT CHOICE

County appraisal districts and county GIS offices publish parcel data as
public record. Most of them expose it through an ArcGIS REST FeatureServer,
which is a documented, queryable JSON API meant to be consumed by software.
Hitting it is not scraping in the adversarial sense -- it is using the
interface the county built for exactly this.

This tool does NOT scrape Zillow, Redfin, Realtor.com or any MLS. Those sites
detect and ban automated traffic within minutes, restructure their markup
constantly, and forbid it in their terms of use. Anything built on top of
them stops working almost immediately. For listing-side data, use a licensed
API through /proxy instead.
--------------------------------------------------------------------------
"""

import argparse
import json
import re
import socketserver
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

UA = "DealEngine/1.0 (+local research tool)"
TIMEOUT = 25

# ---------------------------------------------------------------------------
# Known county parcel query endpoints. Add your own as you find them --
# the discovery path below finds most counties without any entry here.
# ---------------------------------------------------------------------------
REGISTRY = {
    # Statewide fallback layers (queried when a county has no direct entry)
    "_state:TX": "https://feature.geographic.texas.gov/arcgis/rest/services/"
                 "Parcels/stratmap_land_parcels_48_most_recent/MapServer/0/query",
}

# Field-name patterns -> the key Deal Engine expects.
# County schemas are wildly inconsistent, so we match loosely and take the
# first credible hit.
FIELD_MAP = [
    ("sqft",           [r"^liv.*a?r?ea", r"living.*sq", r"bldg.*sq", r"tot.*liv",
                        r"^sqft$", r"sq_?ft", r"^gla$", r"heated.*a?r?ea", r"finished.*a?r?ea"]),
    ("yearBuilt",      [r"y(ea)?r_?_?bl?t", r"y(ea)?r.*buil?t", r"buil?t.*y(ea)?r",
                        r"^yearbuilt$", r"eff.*y(ea)?r", r"act.*y(ea)?r"]),
    ("appraisedValue", [r"tot.*(mkt|market|appr|assess).*va?l", r"(mkt|market|appr|assess).*tot.*va?l",
                        r"^totalvalue$", r"^apprtot", r"^market_?value$", r"^just_?value$",
                        r"^assessed_?value$", r"^tot_?val$", r"^totval"]),
    ("annualTax",      [r"tax.*amt", r"tax.*amount", r"^taxes?$", r"annual.*tax", r"^tax_?due"]),
    ("beds",           [r"^bed", r"bed.*(rooms?|cnt|count|no)"]),
    ("baths",          [r"^bath", r"bath.*(rooms?|cnt|count|no)", r"full.*bath"]),
    ("lotSqft",        [r"lot.*(sq|size|area)", r"land.*sq", r"^acre", r"deeded.*acre"]),
    ("ownerName",      [r"^owner", r"own.*name", r"^name1?$"]),
    ("landUse",        [r"land.*use", r"^use.*(code|desc)", r"prop.*(class|type|use)"]),
    ("legalDesc",      [r"legal", r"^subdiv"]),
    ("situsAddress",   [r"situs", r"^prop.*addr", r"^site.*addr", r"^address", r"^full.*addr"]),
    ("parcelId",       [r"^parcel", r"^pin$", r"^apn$", r"^prop_?id$", r"account", r"^geo_?id"]),
]

ADDRESS_FIELDS = [
    "SITUS_ADDR", "SITUSADDR", "SITUS_ADDRESS", "PROP_ADDR", "PROPADDR",
    "SITEADDRESS", "SITE_ADDR", "FULL_ADDR", "ADDRESS", "PHYSADDR",
    "SITUS", "LOCATION", "PROPERTY_ADDRESS", "STR_ADDRESS", "ADDR",
]


def http_json(url, headers=None, data=None, method="GET"):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
        raw = r.read()
    return json.loads(raw.decode("utf-8", "replace"))


# ---------------------------------------------------------------------------
# Discovery: find a county's parcel layer on ArcGIS Hub
# ---------------------------------------------------------------------------
def discover_layer(state, county):
    """Ask ArcGIS Hub which dataset holds this county's parcels, return a
    /query URL or None."""
    q = f"{county} County {state} parcels"
    url = ("https://hub.arcgis.com/api/v3/datasets?"
           + urllib.parse.urlencode({"q": q, "page[size]": 12}))
    try:
        j = http_json(url)
    except Exception as e:
        print(f"  hub search failed: {e}", file=sys.stderr)
        return None

    best = None
    for d in j.get("data", []):
        a = d.get("attributes", {})
        name = (a.get("name") or "").lower()
        src = a.get("url") or a.get("serviceUrl") or ""
        if not src:
            continue
        score = 0
        if "parcel" in name:
            score += 3
        if county.lower() in name or county.lower() in (a.get("orgName") or "").lower():
            score += 2
        if any(w in name for w in ("tax", "appraisal", "property", "cad", "assessor")):
            score += 1
        if "FeatureServer" in src or "MapServer" in src:
            score += 1
        if score > (best[0] if best else 0):
            best = (score, src)

    if not best:
        return None
    src = best[1].rstrip("/")
    if not re.search(r"/\d+$", src):
        src += "/0"
    return src + "/query"


def build_where(address, city, zipcode, fields):
    """Build an ArcGIS WHERE clause against whichever address-ish field exists."""
    upper = {f.upper(): f for f in fields}
    target = None
    for cand in ADDRESS_FIELDS:
        if cand in upper:
            target = upper[cand]
            break
    if target is None:
        for f in fields:
            if re.search(r"addr|situs|site", f, re.I):
                target = f
                break
    if target is None or not address:
        return None, None

    # Normalize: strip unit numbers, uppercase, collapse whitespace.
    a = re.sub(r"\s+", " ", address.strip().upper())
    a = re.sub(r"\s+(APT|UNIT|STE|#).*$", "", a)
    a = a.replace("'", "''")
    return f"UPPER({target}) LIKE '%{a}%'", target


def layer_fields(query_url):
    meta_url = query_url.rsplit("/query", 1)[0] + "?f=json"
    try:
        j = http_json(meta_url)
        return [f["name"] for f in j.get("fields", [])]
    except Exception:
        return []


def normalize(attrs):
    """Map a county's raw attribute bag onto Deal Engine's field names."""
    out = {}
    keys = list(attrs.keys())
    for target, pats in FIELD_MAP:
        for pat in pats:
            hit = next((k for k in keys if re.search(pat, k, re.I)), None)
            if hit is None:
                continue
            v = attrs.get(hit)
            if v in (None, "", " "):
                continue
            if target in ("sqft", "yearBuilt", "appraisedValue", "annualTax",
                          "beds", "baths", "lotSqft"):
                try:
                    v = float(re.sub(r"[^\d.\-]", "", str(v)) or 0)
                except ValueError:
                    continue
                if v <= 0:
                    continue
                # acres -> sqft
                if target == "lotSqft" and re.search(r"acre", hit, re.I) and v < 200:
                    v = round(v * 43560)
                v = round(v, 2)
            out[target] = v
            break
    out["_raw"] = attrs
    return out


def scrape_parcel(state, county, address, city, zipcode):
    tried = []
    candidates = []
    key = f"{state}|{county}"
    if key in REGISTRY:
        candidates.append(REGISTRY[key])
    disc = discover_layer(state, county)
    if disc:
        candidates.append(disc)
    if f"_state:{state}" in REGISTRY:
        candidates.append(REGISTRY[f"_state:{state}"])

    if not candidates:
        raise RuntimeError(
            f"No parcel layer found for {county} County, {state}. "
            f"Find your county's ArcGIS open-data portal, copy the parcel layer's "
            f"/query URL, and add it to REGISTRY as \"{state}|{county}\"."
        )

    for qurl in candidates:
        tried.append(qurl)
        fields = layer_fields(qurl)
        where, addr_field = build_where(address, city, zipcode, fields)
        if not where:
            where = "1=1"
        params = {
            "where": where, "outFields": "*", "returnGeometry": "false",
            "resultRecordCount": "5", "f": "json",
        }
        try:
            j = http_json(qurl + "?" + urllib.parse.urlencode(params))
        except Exception as e:
            print(f"  query failed {qurl}: {e}", file=sys.stderr)
            continue
        feats = j.get("features") or []
        if not feats:
            continue
        res = normalize(feats[0].get("attributes", {}))
        res["_source"] = qurl
        res["_matchField"] = addr_field
        res["_matches"] = len(feats)
        return res

    raise RuntimeError(
        f"Queried {len(tried)} layer(s) for {county} County, {state} but found no "
        f"parcel matching '{address}'. Try just the street number and name "
        f"(no suffix), or paste the record manually. Layers tried: "
        + "; ".join(tried)
    )


# ---------------------------------------------------------------------------
# LIST BUILDER — the absentee-owner pull.
#
# This is the part that actually makes money. The calculator tells you what a
# house is worth; this tells you which 900 doors to knock on. It queries the
# county parcel layer, keeps the houses that fit a buy box, works out which
# ones are owned by somebody who does not live there, and prices an offer for
# every single one so you can sort by spread and start at the top.
# ---------------------------------------------------------------------------

MAIL_FIELDS = [
    "MAIL_ADDR", "MAILADDR", "MAIL_ADDRESS", "MAILING_ADDRESS", "OWNER_ADDR",
    "OWNERADDR", "OWNER_ADDRESS", "OWN_ADDR", "MAIL_LINE1", "MAIL_ADDR1",
    "ADDR_LINE1", "OWNER_MAIL_ADDR", "MAILADDR1", "MAIL_STREET",
]
MAIL_CITY_FIELDS = ["MAIL_CITY", "MAILCITY", "OWNER_CITY", "OWN_CITY", "MAIL_CITY_STATE"]
MAIL_ZIP_FIELDS = ["MAIL_ZIP", "MAILZIP", "OWNER_ZIP", "OWN_ZIP", "MAIL_ZIPCODE"]

STREET_ABBR = {
    "STREET": "ST", "AVENUE": "AVE", "BOULEVARD": "BLVD", "DRIVE": "DR",
    "ROAD": "RD", "LANE": "LN", "COURT": "CT", "CIRCLE": "CIR", "PLACE": "PL",
    "TERRACE": "TER", "PARKWAY": "PKWY", "HIGHWAY": "HWY", "TRAIL": "TRL",
    "NORTH": "N", "SOUTH": "S", "EAST": "E", "WEST": "W",
    "NORTHEAST": "NE", "NORTHWEST": "NW", "SOUTHEAST": "SE", "SOUTHWEST": "SW",
}


def norm_addr(v):
    """Squash an address to a comparable core: no punctuation, no unit, USPS
    abbreviations, no trailing directionals. '1806 Ash Avenue #B' -> '1806 ASH AVE'."""
    if not v:
        return ""
    a = str(v).upper()
    a = re.sub(r"#\s*\S+", " ", a)          # "#B", "# 204" -> gone
    a = re.sub(r"[.,]", " ", a)
    a = re.sub(r"\s+(APT|UNIT|STE|SUITE|LOT|BLDG|TRLR|SPC)\b.*$", "", a)
    a = re.sub(r"\bP\s*O\s+BOX\b", "POBOX", a)
    parts = [STREET_ABBR.get(w, w) for w in a.split()]
    return " ".join(parts).strip()


def pick(fields, names, regex=None):
    """First field whose name matches one of `names` exactly, else by regex."""
    up = {f.upper(): f for f in fields}
    for n in names:
        if n in up:
            return up[n]
    if regex:
        for f in fields:
            if re.search(regex, f, re.I):
                return f
    return None


def query_page(qurl, where, offset, count, out_fields="*"):
    params = {
        "where": where, "outFields": out_fields, "returnGeometry": "false",
        "resultOffset": str(offset), "resultRecordCount": str(count), "f": "json",
    }
    j = http_json(qurl + "?" + urllib.parse.urlencode(params))
    if "error" in j:
        raise RuntimeError(str(j["error"])[:300])
    return j.get("features", []), bool(j.get("exceededTransferLimit"))


def mao(arv, rehab, tax, o):
    """Same offer math the app uses, so the list and the calculator agree.

    Two numbers, take the lower:
      - the rule of thumb:  ARV x rule% - rehab
      - profit-backed: solved in closed form for the purchase price that leaves
        exactly `target` profit after points, interest, both closings and carry.
        The loan depends on the price we are solving for, hence the algebra.
    """
    sc, bc, dp = o.sell_cost / 100, o.buy_cost / 100, o.down / 100
    k = o.points / 100 + (o.rate / 100 / 12) * o.hold
    rf = rehab if o.finance_rehab else 0.0
    carry = (o.carry + tax / 12) * o.hold
    num = arv * (1 - sc) - rehab - carry - rf * k - o.target
    den = 1 + bc + (1 - dp) * k
    profit_backed = num / den if den > 0 else 0.0
    rule = arv * (o.rule / 100) - rehab
    return min(rule, profit_backed), rule, profit_backed


def build_list(state, county, o):
    qurl = REGISTRY.get(f"{state}|{county}") or discover_layer(state, county)
    if not qurl:
        raise RuntimeError(
            f"No parcel layer found for {county} County, {state}. Open the county's "
            f"GIS portal, copy the parcel layer's /query URL, and add it to REGISTRY "
            f"as \"{state}|{county}\"."
        )
    print(f"  layer: {qurl}", file=sys.stderr)

    fields = layer_fields(qurl)
    if not fields:
        raise RuntimeError(f"Could not read the field list from {qurl}")

    f_sqft = pick(fields, [], r"liv.*a?r?ea|living.*sq|bldg.*sq|^gla$|heated.*a?r?ea|^sqft$|sq_?ft")
    f_year = pick(fields, [], r"y(ea)?r_?_?bl?t|y(ea)?r.*buil?t|buil?t.*y(ea)?r")
    f_val = pick(fields, [], r"tot.*(mkt|market|appr|assess).*va?l|^just_?value$|^market_?value$|^tot_?val")
    f_situs = pick(fields, ADDRESS_FIELDS, r"situs|site.*addr|prop.*addr|full.*addr|^address")
    f_mail = pick(fields, MAIL_FIELDS, r"mail.*(addr|street)|own.*addr")
    f_mcity = pick(fields, MAIL_CITY_FIELDS, r"mail.*city|own.*city")
    f_mzip = pick(fields, MAIL_ZIP_FIELDS, r"mail.*zip|own.*zip")
    f_owner = pick(fields, [], r"^owner|own.*name|^name1?$")
    f_pid = pick(fields, [], r"^parcel|^pin$|^apn$|^prop_?id$|account|^geo_?id")
    f_city = pick(fields, ["SITUS_CITY", "PROP_CITY", "CITY"], r"situs.*city|prop.*city|^city")
    f_zip = pick(fields, ["SITUS_ZIP", "PROP_ZIP", "ZIP"], r"situs.*zip|prop.*zip|^zip")
    f_hs = pick(fields, [], r"homestead|hs_?exempt|exempt.*hs|^hstd")
    f_use = pick(fields, [], r"land.*use|^use.*(code|desc)|state.*cd|prop.*(class|type)")

    if not f_situs:
        raise RuntimeError(f"That layer has no address field. Fields: {', '.join(fields[:25])}")
    print(f"  mapped: sqft={f_sqft} year={f_year} value={f_val} situs={f_situs} "
          f"mail={f_mail} owner={f_owner} homestead={f_hs}", file=sys.stderr)
    if not f_mail:
        print("  ! no owner-mailing field on this layer — absentee flag will be blank.\n"
              "    Every row still gets scored; you just can't filter on absentee.", file=sys.stderr)

    clauses = []
    if f_year and o.year_min:
        clauses.append(f"{f_year} >= {o.year_min}")
    if f_year and o.year_max:
        clauses.append(f"{f_year} <= {o.year_max}")
    if f_sqft and o.sqft_min:
        clauses.append(f"{f_sqft} >= {o.sqft_min}")
    if f_sqft and o.sqft_max:
        clauses.append(f"{f_sqft} <= {o.sqft_max}")
    if f_city and o.city:
        clauses.append(f"UPPER({f_city}) LIKE '%{o.city.upper()}%'")
    where = " AND ".join(clauses) if clauses else "1=1"
    print(f"  where: {where}", file=sys.stderr)

    rows, offset, page = [], 0, 1000
    while offset < o.limit:
        feats, more = query_page(qurl, where, offset, min(page, o.limit - offset))
        if not feats:
            break
        for ft in feats:
            a = ft.get("attributes", {})
            situs = str(a.get(f_situs) or "").strip()
            if not situs:
                continue
            mail = str(a.get(f_mail) or "").strip() if f_mail else ""
            ns, nm = norm_addr(situs), norm_addr(mail)
            absentee = "" if not f_mail or not nm else ("Y" if ns != nm else "N")
            if o.absentee_only and absentee != "Y":
                continue

            hs_raw = a.get(f_hs) if f_hs else None
            homestead = ""
            if f_hs and hs_raw not in (None, ""):
                homestead = "N" if str(hs_raw).strip().upper() in ("0", "N", "NO", "FALSE", "NONE") else "Y"
            if o.no_homestead and homestead == "Y":
                continue

            def num(field):
                if not field:
                    return 0.0
                try:
                    return float(re.sub(r"[^\d.\-]", "", str(a.get(field) or 0)) or 0)
                except ValueError:
                    return 0.0

            sqft, year, val = num(f_sqft), num(f_year), num(f_val)
            if sqft <= 0:
                continue
            arv = o.arv_psf * sqft
            if o.arv_min and arv < o.arv_min:
                continue
            if o.arv_max and arv > o.arv_max:
                continue
            rehab = o.rehab_psf * sqft
            tax = val * o.tax_rate if val else arv * 0.6 * o.tax_rate
            offer, rule, backed = mao(arv, rehab, tax, o)
            anchor = val or arv * 0.75
            rows.append({
                "max_offer": round(offer), "spread": round(anchor - offer),
                "cut_vs_appraised": round((anchor - offer) / anchor, 3) if anchor else 0,
                "address": situs, "city": str(a.get(f_city) or o.city or "").strip(),
                "state": state, "zip": str(a.get(f_zip) or "").strip(),
                "sqft": int(sqft), "year": int(year) if year else "",
                "cad": round(val), "arv": round(arv), "rehab": round(rehab),
                "rent": round(sqft * o.rent_psf / 25) * 25,
                "absentee": absentee, "homestead": homestead,
                "owner": str(a.get(f_owner) or "").strip() if f_owner else "",
                "mail_address": mail,
                "mail_city": str(a.get(f_mcity) or "").strip() if f_mcity else "",
                "mail_zip": str(a.get(f_mzip) or "").strip() if f_mzip else "",
                "parcel_id": str(a.get(f_pid) or "").strip() if f_pid else "",
                "use": str(a.get(f_use) or "").strip() if f_use else "",
                "rule70": round(rule), "profit_backed": round(backed),
            })
        offset += len(feats)
        print(f"  ...{offset} parcels scanned, {len(rows)} kept", file=sys.stderr)
        if not more and len(feats) < page:
            break

    rows.sort(key=lambda r: -r["spread"])
    return rows


def write_csv(rows, path):
    import csv
    # These first columns are exactly what Deal Engine's CSV tab expects, so the
    # file pastes straight in and batch-scores with no editing.
    cols = ["address", "city", "state", "zip", "sqft", "year", "list", "cad",
            "rent", "rehab", "arv", "max_offer", "spread", "cut_vs_appraised",
            "absentee", "homestead", "owner", "mail_address", "mail_city",
            "mail_zip", "parcel_id", "use", "rule70", "profit_backed"]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            r = dict(r)
            r["list"] = r["cad"]   # off-market: the appraised value is the anchor
            w.writerow(r)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "DealEngine/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, fmt, *a):
        sys.stderr.write("  %s\n" % (fmt % a))

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}

        if u.path == "/health":
            return self._send(200, {"ok": True, "service": "county_scraper",
                                    "counties_registered": len(REGISTRY)})

        if u.path == "/parcel":
            state = q.get("state", "").upper()
            county = q.get("county", "")
            if not state or not county:
                return self._send(400, {"error": "state and county are required"})
            print(f"[parcel] {q.get('address','')} — {county} County, {state}")
            try:
                return self._send(200, scrape_parcel(
                    state, county, q.get("address", ""), q.get("city", ""), q.get("zip", "")))
            except Exception as e:
                return self._send(404, {"error": str(e)})

        if u.path == "/proxy":
            target = q.get("url")
            if not target:
                return self._send(400, {"error": "url parameter required"})
            if not target.startswith(("http://", "https://")):
                return self._send(400, {"error": "url must be http(s)"})
            hdrs = {}
            for h in ("X-Api-Key", "Authorization", "apikey", "Accept"):
                if self.headers.get(h):
                    hdrs[h] = self.headers.get(h)
            print(f"[proxy] {target[:110]}")
            try:
                req = urllib.request.Request(target)
                req.add_header("User-Agent", UA)
                for k, v in hdrs.items():
                    req.add_header(k, v)
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    body = r.read()
                    ct = r.headers.get("Content-Type", "application/json")
                return self._send(200, body, ct)
            except urllib.error.HTTPError as e:
                return self._send(e.code, e.read(), "application/json")
            except Exception as e:
                return self._send(502, {"error": str(e)})

        return self._send(404, {"error": "unknown route",
                                "routes": ["/health", "/parcel", "/proxy", "/anthropic"]})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)

        if u.path == "/anthropic":
            key = self.headers.get("x-api-key") or ""
            if not key:
                return self._send(401, {"error": "x-api-key header required"})
            print(f"[anthropic] forwarding {n} bytes")
            try:
                req = urllib.request.Request(
                    "https://api.anthropic.com/v1/messages", data=body, method="POST")
                req.add_header("content-type", "application/json")
                req.add_header("x-api-key", key)
                req.add_header("anthropic-version",
                               self.headers.get("anthropic-version") or "2023-06-01")
                with urllib.request.urlopen(req, timeout=180) as r:
                    return self._send(200, r.read())
            except urllib.error.HTTPError as e:
                return self._send(e.code, e.read())
            except Exception as e:
                return self._send(502, {"error": str(e)})

        if u.path == "/proxy":
            target = urllib.parse.parse_qs(u.query).get("url", [None])[0]
            if not target:
                return self._send(400, {"error": "url required"})
            try:
                req = urllib.request.Request(target, data=body, method="POST")
                req.add_header("Content-Type",
                               self.headers.get("Content-Type") or "application/json")
                for h in ("X-Api-Key", "Authorization"):
                    if self.headers.get(h):
                        req.add_header(h, self.headers.get(h))
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    return self._send(200, r.read())
            except urllib.error.HTTPError as e:
                return self._send(e.code, e.read())
            except Exception as e:
                return self._send(502, {"error": str(e)})

        return self._send(404, {"error": "unknown route"})


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description="Deal Engine county scraper + CORS proxy")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--test", metavar="STATE:COUNTY:ADDRESS",
                    help='one-shot scrape, e.g. --test "TX:Tarrant:1420 Maple St"')

    g = ap.add_argument_group("list builder")
    g.add_argument("--list", metavar="STATE:COUNTY",
                   help='build a lead list, e.g. --list "TX:Hidalgo"')
    g.add_argument("--out", default="leads.csv", help="output CSV (default leads.csv)")
    g.add_argument("--city", default="", help="restrict to one city, e.g. McAllen")
    g.add_argument("--sqft-min", type=int, default=1250)
    g.add_argument("--sqft-max", type=int, default=1700)
    g.add_argument("--year-min", type=int, default=1965)
    g.add_argument("--year-max", type=int, default=1995)
    g.add_argument("--arv-psf", type=float, default=145.0, help="renovated $/sqft")
    g.add_argument("--rehab-psf", type=float, default=36.0, help="rehab $/sqft")
    g.add_argument("--rent-psf", type=float, default=1.15, help="market rent $/sqft/mo")
    g.add_argument("--arv-min", type=float, default=185000)
    g.add_argument("--arv-max", type=float, default=240000)
    g.add_argument("--tax-rate", type=float, default=0.0178)
    g.add_argument("--absentee-only", action="store_true",
                   help="keep only owners whose mailing address differs from the house")
    g.add_argument("--no-homestead", action="store_true",
                   help="drop anything carrying a homestead exemption")
    g.add_argument("--limit", type=int, default=8000, help="max parcels to scan")
    g.add_argument("--rule", type=float, default=70.0)
    g.add_argument("--target", type=float, default=35000)
    g.add_argument("--rate", type=float, default=11.5)
    g.add_argument("--points", type=float, default=2.0)
    g.add_argument("--down", type=float, default=15.0)
    g.add_argument("--hold", type=float, default=6.0)
    g.add_argument("--carry", type=float, default=380.0)
    g.add_argument("--buy-cost", type=float, default=2.0)
    g.add_argument("--sell-cost", type=float, default=8.0)
    g.add_argument("--finance-rehab", type=int, default=1)
    a = ap.parse_args()

    if a.list:
        st, co = (a.list.split(":", 1) + [""])[:2]
        st = st.upper()
        print(f"\n  Building lead list — {co} County, {st}")
        print(f"  Buy box: {a.sqft_min}-{a.sqft_max} sqft, built {a.year_min}-{a.year_max}, "
              f"ARV ${a.arv_min:,.0f}-${a.arv_max:,.0f}"
              + (f", {a.city} only" if a.city else "")
              + (", absentee only" if a.absentee_only else "")
              + (", no homestead" if a.no_homestead else "") + "\n")
        try:
            rows = build_list(st, co, a)
        except Exception as e:
            print(f"\n  FAILED: {e}\n")
            return
        if not rows:
            print("\n  No parcels matched. Widen the buy box (--sqft-min / --year-min) "
                  "or drop --absentee-only.\n")
            return
        write_csv(rows, a.out)
        pos = [r for r in rows if r["max_offer"] > 0]
        abs_n = sum(1 for r in rows if r["absentee"] == "Y")
        print(f"\n  {len(rows)} leads written to {a.out}")
        print(f"  {abs_n} absentee-owned · {len(pos)} with a positive max offer")
        print(f"\n  Top 10 by spread (appraised value minus what you can pay):\n")
        print(f"  {'ADDRESS':<30}{'SQFT':>6}{'YR':>6}{'CAD':>11}{'ARV':>11}{'MAX OFFER':>12}{'SPREAD':>11}  ABS")
        print("  " + "-" * 94)
        for r in rows[:10]:
            print(f"  {r['address'][:29]:<30}{r['sqft']:>6}{r['year']:>6}"
                  f"{r['cad']:>11,}{r['arv']:>11,}{r['max_offer']:>12,}{r['spread']:>11,}"
                  f"   {r['absentee']}")
        print(f"\n  Next: open Deal Engine -> Data Pull -> CSV / MLS, paste {a.out}, "
              f"hit Score every row.\n")
        return

    if a.test:
        st, co, addr = (a.test.split(":", 2) + ["", ""])[:3]
        try:
            print(json.dumps(scrape_parcel(st.upper(), co, addr, "", ""), indent=2)[:4000])
        except Exception as e:
            print("ERROR:", e)
        return

    print(f"""
  Deal Engine backend
  -------------------
  listening   http://{a.host}:{a.port}
  parcel      /parcel?state=TX&county=Tarrant&address=1420+Maple+St
  api proxy   /proxy?url=<encoded url>      (pass X-Api-Key through)
  claude      /anthropic  (POST, x-api-key header)

  In the app:  County scraper -> http://{a.host}:{a.port}
               Listing API    -> proxy prefix http://{a.host}:{a.port}/proxy?url=
               AI vision      -> proxy http://{a.host}:{a.port}/anthropic

  Ctrl-C to stop.
""")
    with Server((a.host, a.port), Handler) as s:
        try:
            s.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    main()

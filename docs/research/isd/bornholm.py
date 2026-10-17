"""Nomads weather research: the island's sky, wind, air and climate from Bornholm.

python3 bornholm.py hammer   Hammer Odde Fyr (NOAA ISD 06193, SYNOP on the hour, 2015-2024): the sky's turns, the wind,
                             its rose, the cloud and the daylight through it, the cloud base
python3 bornholm.py ronne    Rønne airport (ISD 06190, METAR at :50, 2015-2024): the day's range of the air, rain's
                             warmth, the air's water, the day-to-day swing of the day's mean air
python3 bornholm.py pool     air.ts pooled() averaged over the island's own weather, by season (climate.ts POOL_C)
python3 bornholm.py dmi      DMI's normals 1991-2020: Rønne's mean air, Bornholm's rain and its shares, the 10 km grid's
                             coast and interior, Tejn harbour's water, the days snow lies
python3 bornholm.py upper    the moist layer over the wet hours: Greifswald's and Łeba's radiosondes (NOAA IGRA2, 2015-2024)
                             at 850 hPa at 00 and 12 UTC when Hammer Odde reports rain or snow falling, by season
python3 bornholm.py          all of them

Seasons are the game's (src/sim/sky.ts): each a quarter of the year centred on an equinox or a solstice, spring from
4 February to 5 May (day of year 34 to 125), summer to 4 August, autumn to 4 November, winter to 3 February.

Sky states: clear = dry with 2 oktas or less (Hammer Odde: the SYNOP's total cover, else its largest layer; Rønne: the
largest METAR layer, none reported counted as none); cloudy = any other dry hour; rain = automated present weather 40-89
(precipitation) under a gale (17.2 m/s); storm = the same at a gale or more. Runs and transitions break at missing hours.
The yearly ISD CSVs are fetched into ISD_CACHE (default /tmp/nm/isdb), DMI's series into DMI_CACHE (default /tmp/nm/gen),
IGRA2's soundings into IGRA_CACHE (default /tmp/nm/igra), on first use.
"""
import glob, json, math, os, sys, urllib.request
import numpy as np, pandas as pd

HERE = os.environ.get("ISD_CACHE", "/tmp/nm/isdb")
DMI = os.environ.get("DMI_CACHE", "/tmp/nm/gen")
IGRA = os.environ.get("IGRA_CACHE", "/tmp/nm/igra")
SONDES = {"Greifswald": "GMM00010184", "Leba": "PLM00012120"}
IDS = {"hammer": "06193099999", "ronne": "06190099999"}
STATES = ["clear", "cloudy", "rain", "storm"]
SEASONS = ["spring", "summer", "autumn", "winter"]
GALE = 17.2
LAT, LON = 55.1, 14.8
HEAD = math.log(2 / 0.03) / math.log(10 / 0.03)  # air.ts: 10 m wind to head height over open ground


def gseason_doy(doy):
    """The game's season (0 spring .. 3 winter) of a day of the year, spring centred on the March equinox (day 79)."""
    return (np.floor(((np.asarray(doy) - 79 + 365.25 / 8) % 365.25) / (365.25 / 4))).astype(int)


def season(idx):
    return pd.Series(np.array(SEASONS)[gseason_doy(idx.dayofyear.values)], index=idx)


def esat(t):
    return 0.6108 * np.exp(17.27 * t / (t + 237.3))


def load(station):
    os.makedirs(HERE, exist_ok=True)
    for y in range(2015, 2025):
        f = f"{HERE}/{station}_{y}.csv"
        if not os.path.exists(f):
            urllib.request.urlretrieve(f"https://noaa-global-hourly-pds.s3.amazonaws.com/{y}/{IDS[station]}.csv", f)
    fs = sorted(glob.glob(f"{HERE}/{station}_20*.csv"))
    want = {"DATE", "REPORT_TYPE", "WND", "TMP", "DEW", "AW1", "GA1", "GA2", "GA3", "GF1", "VIS"}
    x = pd.concat([pd.read_csv(f, low_memory=False, usecols=lambda c: c in want) for f in fs])
    x = x[x.REPORT_TYPE.str.strip() == ("FM-15" if station == "ronne" else "FM-12")].copy()
    x["t"] = pd.to_datetime(x.DATE)
    x = x[x.t.dt.minute == (50 if station == "ronne" else 0)].copy()
    x["t"] = x.t.dt.floor("h")
    x = x.drop_duplicates("t").set_index("t").sort_index()
    w = x.WND.str.split(",", expand=True)
    spd = pd.to_numeric(w[3], errors="coerce") / 10
    ok = w[4].isin(["1", "5"]) & (spd < 900)
    x["u"] = spd.where(ok)
    d = pd.to_numeric(w[0], errors="coerce")
    x["dir"] = d.where(ok & (d <= 360) & (w[2] != "C"))

    def num(col):
        s = x[col].str.split(",", expand=True)
        v = pd.to_numeric(s[0], errors="coerce")
        return (v / 10).where(s[1].isin(["1", "5"]) & (v.abs() < 9000))

    x["T"], x["Td"] = num("TMP"), num("DEW")
    x["aw"] = pd.to_numeric(x.AW1.str.split(",").str[0], errors="coerce") if "AW1" in x else np.nan
    layers = [pd.to_numeric(x[c].str.split(",").str[0], errors="coerce").where(lambda v: v <= 8) for c in ("GA1", "GA2", "GA3") if c in x]
    okta = pd.concat(layers, axis=1).max(axis=1)
    if "GF1" in x:
        g = x.GF1.str.split(",", expand=True)
        total = pd.to_numeric(g[0], errors="coerce").where(lambda v: v <= 8)
        base = pd.to_numeric(g[7], errors="coerce").where(lambda v: v < 99999)
    else:
        total, base = okta * np.nan, okta * np.nan
    if station == "ronne":
        x["okta"] = okta.fillna(0)  # no cloud group: METAR NSC/CAVOK/NCD, no cloud detected
    else:
        x["okta"] = total.where(total.notna(), okta)  # the SYNOP's total cover, else its largest layer; else unknown
    x["base"] = base
    v = x.VIS.str.split(",", expand=True)
    x["vis"] = pd.to_numeric(v[0], errors="coerce").where(lambda s: s < 999999)
    return x[["u", "dir", "T", "Td", "aw", "okta", "base", "vis"]].asfreq("h")


def classify(x):
    wet = x.aw.between(40, 89)
    st = pd.Series(np.select([wet & (x.u >= GALE), wet, x.okta <= 2, x.okta > 2], ["storm", "rain", "clear", "cloudy"], ""), index=x.index)
    return st.where(x.u.notna() & (st != ""))


def runs(s):
    g = (s != s.shift()).cumsum()
    r = pd.DataFrame({"s": s, "g": g}).dropna().groupby("g").agg(s=("s", "first"), n=("s", "size"))
    return r.groupby("s").n.mean().reindex(STATES)


def transitions(s):
    a, b = s, s.shift(-1)
    m = a.notna() & b.notna()
    ct = pd.crosstab(a[m], b[m]).reindex(index=STATES, columns=STATES, fill_value=0)
    return ct.div(ct.sum(axis=1).replace(0, np.nan), axis=0).fillna(0), ct


def acf(v, lag):
    a, b = np.asarray(v, float), np.asarray(pd.Series(v).shift(-lag), float)
    m = ~np.isnan(a) & ~np.isnan(b)
    return np.corrcoef(a[m], b[m])[0, 1]


def sun_el(idx):
    """The sun's elevation (radians) at each UTC hour's middle, at Bornholm, ignoring the equation of time."""
    doy = idx.dayofyear.values
    hr = idx.hour.values + 0.5
    dec = np.radians(23.44) * np.sin(2 * np.pi * (doy - 81) / 365.25)
    ha = np.radians(15 * (hr - (12 - LON / 15)))
    lat = np.radians(LAT)
    return np.arcsin(np.sin(lat) * np.sin(dec) + np.cos(lat) * np.cos(dec) * np.cos(ha))


def after_sunset(idx):
    """Hours since the sun set (NaN by day), at Bornholm, ignoring the equation of time."""
    doy = idx.dayofyear.values
    hr = idx.hour.values + idx.minute.values / 60
    dec = np.radians(23.44) * np.sin(2 * np.pi * (doy - 81) / 365.25)
    half = np.degrees(np.arccos(np.clip(-np.tan(np.radians(LAT)) * np.tan(dec), -1, 1))) / 15
    noon = 12 - LON / 15
    set_, rise = noon + half, noon - half
    return np.where(hr >= set_, hr - set_, np.where(hr < rise, hr + 24 - set_, np.nan))


def r(v, n=3):
    return [round(float(a), n) for a in v]


def hammer():
    x = load("hammer")
    s = classify(x)
    sea = season(x.index)
    print(f"Hammer Odde hours {len(x)}, missing {s.isna().mean():.3f}")
    print("shares all", r(s.value_counts(normalize=True).reindex(STATES), 4), "runs", r(runs(s), 2))
    P, C = transitions(s)
    print("storm row pooled", r(P.loc["storm"], 4), "n", int(C.loc["storm"].sum()))
    for q in SEASONS:
        ss = s.where(sea == q)
        P, C = transitions(ss)
        u = x.u.where(sea == q).groupby(ss).agg(["mean", "std"]).reindex(STATES)
        print(q, "share", r(ss.value_counts(normalize=True).reindex(STATES).fillna(0), 4), "runs", r(runs(ss), 2))
        print("  P", [r(row, 4) for row in P.values], "n", C.sum(axis=1).tolist())
        print("  u", r(u["mean"], 2), "sd", r(u["std"], 2))
    # the wind's anomaly in spreads, and how much of it an hour keeps
    g = pd.DataFrame({"u": x.u, "s": s, "q": sea})
    st = g.groupby(["q", "s"]).u.agg(["mean", "std"])
    key = pd.MultiIndex.from_arrays([g.q, g.s])
    z = pd.Series((g.u.values - st["mean"].reindex(key).values) / st["std"].reindex(key).values, index=g.index)
    print("wind mean 10 m", round(x.u.mean(), 2), "head height", round(x.u.mean() * HEAD, 2), "anomaly lag1", round(acf(z, 1), 3), "lag6", round(acf(z, 6), 3), "lag24", round(acf(z, 24), 3))
    # the way it blows: the mean resultant by season, and how each part keeps its departure an hour
    th = np.radians(x.dir.where(x.u >= 1))
    cx, sx = np.cos(th), np.sin(th)
    print("dir R", round(float(np.hypot(cx.mean(), sx.mean())), 3), "from", round(float((np.degrees(np.arctan2(sx.mean(), cx.mean())) + 360) % 360)),
          "lag1", round(acf(cx - cx.mean(), 1), 3), round(acf(sx - sx.mean(), 1), 3), "sd", round(float(cx.std()), 3), round(float(sx.std()), 3))
    print("  R by season", [round(float(np.hypot(cx.where(sea == q).mean(), sx.where(sea == q).mean())), 3) for q in SEASONS])
    print("okta/8 by state", r(x.okta.groupby(s).mean().reindex(STATES) / 8, 3))
    wet = s.isin(["rain", "storm"])
    print("wet share by season", [round(float(wet[sea == q].sum() / s[sea == q].notna().sum()), 4) for q in SEASONS])
    print("wet-hour wind 10 m by season", [round(float(x.u[(sea == q) & wet].mean()), 2) for q in SEASONS])

    # the rose: the share of hours the wind comes from each of 16 sectors, from north clockwise
    def rose(d):
        d = d.dropna().values % 360
        k = np.floor(((d + 11.25) % 360) / 22.5).astype(int)
        return np.bincount(k, minlength=16) / len(k)

    blowing = x.dir.where(x.u > 0)
    print("rose16 all", r(rose(blowing)))
    print("rose16 wet", r(rose(blowing.where(wet))))
    # daylight through the cloud: Kasten and Czeplak's global G/Gclear = 1 - 0.71 (N/8)^3.4 and their diffuse share
    # D/G = 0.3 + 0.7 (N/8)^2, so the beam against a clear sky's (D/G 0.3) and the glow against a clear sky's, averaged
    # over the hours the sun is up, weighted by the sine of its height
    n = x.okta / 8
    G = 1 - 0.71 * n ** 3.4
    dg = 0.3 + 0.7 * n ** 2
    beam, glow = G * (1 - dg) / 0.7, G * dg / 0.3
    w = pd.Series(np.maximum(0, np.sin(sun_el(x.index))), index=x.index).where(n.notna())
    wm = lambda v, q: float((v * w)[sea == q].sum() / w[sea == q].sum())
    print("mean N/8 by day", [round(wm(n, q), 3) for q in SEASONS])
    print("KC global", [round(wm(G, q), 3) for q in SEASONS], "beam", [round(wm(beam, q), 3) for q in SEASONS], "glow", [round(wm(glow, q), 3) for q in SEASONS])
    # inside cloud at a height above the sea: a ceiling (5 oktas or more of total cover) based at or below it, the
    # station standing 9 m up, or fog at the station (visibility under 1 km)
    for h in (0, 25, 50, 100, 150, 200, 300, 500):
        inside = ((x.base + 9 <= h) & (x.okta >= 5)) | (x.vis < 1000)
        valid = x.base.notna() | x.vis.notna()
        print(f"in cloud at {h} m", [round(float(inside[valid & (sea == q)].mean()), 4) for q in SEASONS])
    return x, s


def ronne():
    x = load("ronne")
    s = classify(x)
    sea = season(x.index)
    print(f"Rønne hours {len(x)}, missing {s.isna().mean():.3f}")
    # days: the range of the air by season and kind of day (the day's mean okta, its wet hours)
    day = pd.DataFrame({"T": x["T"], "okta": x.okta, "wet": s.isin(["rain", "storm"]), "n": x["T"].notna()}).resample("D").agg({"T": ["max", "min", "mean"], "okta": "mean", "wet": "sum", "n": "sum"})
    day.columns = ["tx", "tn", "tm", "okta", "wet", "n"]
    day = day[day.n >= 20]
    day["dtr"] = day.tx - day.tn
    day["q"] = season(day.index).values
    day["kind"] = np.select([(day.wet == 0) & (day.okta <= 1), (day.wet == 0) & (day.okta >= 6), day.wet >= 2], ["clear", "cloudy", "rain"], "")
    tab = day[day.kind != ""].groupby(["kind", "q"]).dtr.agg(["mean", "count"]).round(2)
    print("DTR by kind and season:\n", tab.unstack("q").reindex(columns=SEASONS, level=1).to_string())
    # rain hours against dry hours at the same month and hour
    h = pd.DataFrame({"T": x["T"], "s": s, "m": x.index.month, "hr": x.index.hour, "q": sea})
    dry = h[h.s.isin(["clear", "cloudy"])].groupby(["m", "hr"]).T.mean()
    rain = h[h.s.isin(["rain", "storm"])].copy()
    rain["d"] = rain["T"].values - dry.reindex(pd.MultiIndex.from_arrays([rain.m, rain.hr])).values
    print("rain minus dry by season", r(rain.groupby("q").d.mean().reindex(SEASONS), 2), "n", rain.groupby("q").d.count().reindex(SEASONS).tolist())
    # the air's water: its mean vapour pressure against what air of the season's mean warmth holds
    e = esat(x.Td)
    print("T by season", r([x["T"][sea == q].mean() for q in SEASONS], 2), "humid0", r([e[sea == q].mean() / esat(x["T"][sea == q].mean()) for q in SEASONS]))
    # the day's mean air against its time of year: a mean year of three harmonics fitted to the days' means, the anomaly
    # each day stands from it, its spread by season, and how much of itself a day keeps to the next, in spreads
    dm = day.tm.asfreq("D")
    ph = 2 * np.pi * dm.index.dayofyear.values / 365.25
    A = np.column_stack([np.ones_like(ph)] + [f(k * ph) for k in (1, 2, 3) for f in (np.cos, np.sin)])
    ok = dm.notna().values
    coef, *_ = np.linalg.lstsq(A[ok], dm.values[ok], rcond=None)
    anom = dm - A @ coef
    q = season(dm.index)
    sd = anom.groupby(q).std().reindex(SEASONS)
    z = anom / q.map(sd)
    r1 = acf(z, 1)
    print("day's mean anomaly sd by season", r(sd, 2), "lag1 in spreads", round(r1, 3), "lag2", round(acf(z, 2), 3), "lag5", round(acf(z, 5), 3),
          "by season", [round(acf(z.where(q == k), 1), 3) for k in SEASONS], "days", int(ok.sum()))

    # The same as an hourly AR(1) (air.ts): the hour's keep phi whose 24-hour means correlate r1 from one day to the next,
    # and the hourly spread whose 24-hour means spread as the days' do.
    def daymean(phi):
        i = np.arange(24)
        c0 = (phi ** np.abs(i[:, None] - i[None, :])).mean()
        c1 = (phi ** np.abs(24 + i[None, :] - i[:, None])).mean()
        return c0, c1 / c0

    lo, hi = 0.5, 0.99999
    for _ in range(80):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if daymean(mid)[1] < r1 else (lo, mid)
    phi = (lo + hi) / 2
    c0 = daymean(phi)[0]
    print("hourly keep", round(phi, 5), "hourly spread", r(sd / math.sqrt(c0), 2), "(day-mean variance share", round(c0, 3), ")")
    return x


def pool(x=None, s=None, cloud=None):
    """air.ts pooled() (fire-constants sec. 33, R480, R481) through the island's own hours: Hammer Odde's sky and its
    wind brought to head height (the game's weather), the sky's cloud as air.ts's CLOUD has each state, Rønne's dew point
    for the air's water, and the night's hours since sunset at 55.1 N."""
    if x is None:
        x, s = hammer()
    rn = load("ronne")
    cloud = cloud or x.okta.groupby(s).mean().reindex(STATES).div(8).to_dict()
    e = esat(rn.Td).reindex(x.index)
    speed = HEAD * x.u
    calm = np.clip((6 - speed) / 3, 0, 1)
    c = s.map(cloud)
    sunny = (0.25 + 0.5 * (1 - c)) / 0.75
    back = 1 - (0.34 - 0.14 * np.sqrt(e)) * (1.35 * sunny - 0.35)
    still = np.clip((0.93 - back) / (0.93 - 0.8), 0, 1)
    after = pd.Series(after_sunset(x.index), index=x.index)
    pooled = (4.3 * (1 - np.exp(np.log(1 - 1.9 / 4.3) * after)) * calm * still).where(after.notna(), 0)
    ok = calm.notna() & still.notna()
    sea = season(x.index)
    print("POOL_C by season", [round(float(pooled[ok & (sea == q)].mean()), 3) for q in SEASONS],
          "share of hours pooling", [round(float((pooled[ok & (sea == q)] > 0).mean()), 3) for q in SEASONS], "hours", int(ok.sum()))


def dmi_get(name, url):
    f = f"{DMI}/{name}.json"
    if not os.path.exists(f):
        os.makedirs(DMI, exist_ok=True)
        urllib.request.urlretrieve(url, f)
    return json.load(open(f))["features"]


API = "https://opendataapi.dmi.dk/v2/climateData/collections"
SPAN = "datetime=1991-01-01T00:00:00Z/2021-01-01T00:00:00Z&limit=10000"


def monthly(features):
    """1991-2020 monthly values by the month they start in (local time) -> a mean for each calendar month."""
    df = pd.DataFrame([(p["properties"]["from"][:7], p["properties"]["value"]) for p in features], columns=["m", "v"])
    df = df[(df.m >= "1991-01") & (df.m <= "2020-12")]
    df["mon"] = df.m.str[5:].astype(int)
    return df.groupby("mon").v.mean(), len(df)


def to_game(mon, total):
    """Calendar months -> the game's seasons: means interpolated daily between mid-months, totals spread evenly over a
    month's days, then averaged (or summed) over each game season's days."""
    doy = np.arange(1, 366)
    mids = np.array([15.5, 45, 74.5, 105, 135.5, 166, 196.5, 227.5, 258, 288.5, 319, 349.5])
    ml = np.array([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    month = (pd.Timestamp("2001-01-01") + pd.to_timedelta(doy - 1, "D")).month
    if total:
        daily = np.array([mon[m] / ml[m - 1] for m in month])
    else:
        daily = np.interp(doy, np.r_[mids - 365, mids, mids + 365], np.r_[mon.values, mon.values, mon.values])
    k = gseason_doy(doy)
    return [float(daily[k == j].sum() if total else daily[k == j].mean()) for j in range(4)]


def dmi():
    t, n = monthly(dmi_get("dmi_06190_mean_temp", f"{API}/stationValue/items?stationId=06190&parameterId=mean_temp&timeResolution=month&{SPAN}"))
    print("Rønne 06190 mean_temp 1991-2020, game seasons", r(to_game(t, False), 2), "annual", round(t.mean(), 2), "months", n)
    tm, n = monthly(dmi_get("mun_mean_temp", f"{API}/municipalityValue/items?municipalityId=0400&parameterId=mean_temp&timeResolution=month&{SPAN}"))
    print("Bornholm 0400 mean_temp, game seasons", r(to_game(tm, False), 2), "annual", round(tm.mean(), 2), "months", n)
    p, n = monthly(dmi_get("mun_acc_precip", f"{API}/municipalityValue/items?municipalityId=0400&parameterId=acc_precip&timeResolution=month&{SPAN}"))
    g = to_game(p, True)
    print("Bornholm 0400 acc_precip, game seasons", r(g, 1), "annual", round(sum(g), 1), "shares", r(np.array(g) / sum(g)), "months", n)
    # the 10 km grid's yearly precipitation: the island's coastal cells and its four interior ones
    cells = dmi_get("g10", f"{API}/10kmGridValue/items?parameterId=acc_precip&timeResolution=year&bbox=14.6,54.95,15.3,55.35&limit=2000")
    df = pd.DataFrame([(c["properties"]["cellId"], c["properties"]["from"][:4], c["properties"]["value"]) for c in cells], columns=["c", "y", "v"])
    df = df[(df.y >= "1991") & (df.y <= "2020")]
    by = df.groupby("c").v.mean()
    inner = ["10km_612_87", "10km_612_88", "10km_613_87", "10km_613_88"]
    print("10 km cells 1991-2020", {k: round(v) for k, v in by.items()}, "years", sorted(df.y.unique())[0], "-", sorted(df.y.unique())[-1])
    print("coast mean", round(by.drop(inner).mean(), 1), "range", round(by.drop(inner).min()), "-", round(by.drop(inner).max()), "interior mean", round(by[inner].mean(), 1),
          "excess", round(by[inner].mean() - by.drop(inner).mean(), 1))
    # the sea: Tejn harbour's water temperature, 2005-2024, by game season and the day of the year's mean
    rows = []
    for y in range(2005, 2025):
        fs = dmi_get(f"tejn{y}", f"https://opendataapi.dmi.dk/v2/oceanObs/collections/observation/items?stationId=32048&parameterId=tw&datetime={y}-01-01T00:00:00Z/{y + 1}-01-01T00:00:00Z&limit=300000")
        rows += [(f["properties"]["observed"], f["properties"]["value"]) for f in fs]
    w = pd.DataFrame(rows, columns=["t", "v"])
    w["t"] = pd.to_datetime(w.t)
    dly = w.set_index("t").v.resample("D").mean().dropna()
    dly = dly[(dly > -2) & (dly < 30)]
    clim = dly.groupby(dly.index.dayofyear).mean()
    print("Tejn water by game season", r([dly[season(dly.index) == q].mean() for q in SEASONS], 2), "annual", round(dly.mean(), 2), "days", len(dly),
          "coldest", round(clim.rolling(15, center=True).mean().min(), 1), "warmest", round(clim.rolling(15, center=True).mean().max(), 1))
    # the days snow lies: Bornholm's daily snow depth (cm, DMI from 2011), a day of 1 cm or more counted, by winter
    fs = dmi_get("mun_snow_depth_day", f"{API}/municipalityValue/items?municipalityId=0400&parameterId=snow_depth&timeResolution=day&datetime=2011-01-01T00:00:00Z/2025-07-01T00:00:00Z&limit=20000")
    sd = pd.Series({pd.Timestamp(f["properties"]["from"][:10]): f["properties"]["value"] for f in fs}).sort_index()
    winter = sd.index.year - (sd.index.month < 7)
    days = (sd >= 1).groupby(winter).sum()
    full = days[(days.index >= 2011) & (days.index <= 2023)]
    print("snow days (>= 1 cm) by winter", full.to_dict(), "mean", round(full.mean(), 1), "median", float(full.median()))
    print("  by game season (share of the season's days)", r([(sd >= 1)[season(sd.index) == q].sum() / max(1, len(full)) / (365.25 / 4) for q in SEASONS]))


def sondes(name):
    """850 hPa from a station's IGRA2 soundings at 00 and 12 UTC, 2015-2024: time (UTC), T, RH, wind direction and speed."""
    sid = SONDES[name]
    f = f"{IGRA}/{sid}-data.txt"
    if not os.path.exists(f):
        os.makedirs(IGRA, exist_ok=True)
        z = f + ".zip"
        urllib.request.urlretrieve(f"https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/data-por/{sid}-data.txt.zip", z)
        import zipfile
        zipfile.ZipFile(z).extractall(IGRA)
    rows, when = [], None
    num = lambda s: (lambda v: np.nan if v in (-9999, -8888) else v)(int(s))
    with open(f, encoding="latin-1") as fh:
        for line in fh:
            if line[0] == "#":
                y, hr = int(line[13:17]), int(line[24:26])
                when = pd.Timestamp(y, int(line[18:20]), int(line[21:23]), hr) if 2015 <= y <= 2024 and hr in (0, 12) else None
                continue
            if when is None or line[9:15].strip() != "85000":
                continue
            t, rh, dp, wd, ws = num(line[22:27]) / 10, num(line[28:33]) / 10, num(line[34:39]) / 10, num(line[40:45]), num(line[46:51]) / 10
            if np.isnan(rh) and not np.isnan(dp):
                rh = 100 * esat(t - dp) / esat(t)
            rows.append((when, t, rh / 100, wd, ws))
    return pd.DataFrame(rows, columns=["t", "T", "rh", "dir", "u"]).drop_duplicates("t").set_index("t")


def upper():
    x = load("hammer")
    wet = classify(x).isin(["rain", "storm"]) & classify(x).notna()
    both = {"u": [], "rh": [], "rose": []}
    for name in SONDES:
        s = sondes(name)
        s["wet"] = wet.reindex(s.index).fillna(False).values
        s["q"] = season(s.index).values
        w = s[s.wet]
        u, rh = [float(w.u[w.q == q].mean()) for q in SEASONS], [float(w.rh[w.q == q].mean()) for q in SEASONS]
        print(f"{name} 850 hPa: soundings {len(s)}, in Hammer Odde's wet hours {len(w)}")
        print("  wind all hours", [round(float(s.u[s.q == q].mean()), 2) for q in SEASONS], "wet hours", r(u, 2), "n", [int((w.q == q).sum()) for q in SEASONS])
        print("  RH wet hours", r(rh), "all", [round(float(s.rh[s.q == q].mean()), 3) for q in SEASONS], "T wet", [round(float(w["T"][w.q == q].mean()), 2) for q in SEASONS])
        d = w.dir.where(w.u > 0).dropna().values % 360
        k = np.floor(((d + 11.25) % 360) / 22.5).astype(int)
        rose = np.bincount(k, minlength=16) / len(k)
        print("  rose16 wet (from N clockwise)", r(rose), "n", len(k))
        both["u"].append(u); both["rh"].append(rh); both["rose"].append(rose)
    # Bornholm lies between the two, Greifswald 150 km to the southwest and Łeba 170 km to the east: their mean
    print("mean of the two: wet-hour wind", r(np.mean(both["u"], axis=0), 2), "RH", r(np.mean(both["rh"], axis=0)), "rose16 wet", r(np.mean(both["rose"], axis=0), 4))


def vis():
    """Hammer Odde's horizontal visibility by sky state: the median, and Koschmieder's extinction 3.912 / V averaged over
    the hours (the mean of what thins a contrast over a metre)."""
    x = load("hammer")
    s = classify(x)
    for q in STATES:
        v = x.vis[(s == q) & x.vis.notna() & (x.vis > 0)]
        print(f"{q}: hours {len(v)}, median visibility {float(v.median()):.0f} m, mean extinction {float((3.912 / v).mean()) * 1000:.4f} per km (as V {3.912 / float((3.912 / v).mean()):.0f} m), quartiles {[float(v.quantile(p)) for p in (0.25, 0.75)]}")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("hammer", "all", "pool"):
        hx, hs = hammer()
    if what in ("ronne", "all"):
        ronne()
    if what in ("pool", "all"):
        pool(hx, hs)
    if what in ("dmi", "all"):
        dmi()
    if what in ("upper", "all"):
        upper()
    if what == "vis":
        vis()

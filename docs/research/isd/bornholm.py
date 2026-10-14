"""Nomads weather research: the island's sky, wind and air from Bornholm (NOAA ISD hourly, 2015-2024).

python3 bornholm.py hammer   Hammer Odde Fyr (06193, SYNOP on the hour): the sky's turns, the wind, the cloud
python3 bornholm.py ronne    Rønne airport (06190, METAR at :50): the day's range of the air and rain's warmth

States: clear = dry with 2 oktas or less (Hammer Odde: the SYNOP's total cover, else its largest layer; Rønne: the largest
METAR layer, none reported counted as none); cloudy = any other dry hour; rain = automated present weather 40-89
(precipitation) under a gale (17.2 m/s); storm = the same at a gale or more. Runs and transitions break at missing hours.
The yearly CSVs are fetched into ISD_CACHE (default /tmp/nm/isdb) on first use.
"""
import glob, os, sys, urllib.request
import numpy as np, pandas as pd

HERE = os.environ.get("ISD_CACHE", "/tmp/nm/isdb")
IDS = {"hammer": "06193099999", "ronne": "06190099999"}
STATES = ["clear", "cloudy", "rain", "storm"]
SEASONS = ["MAM", "JJA", "SON", "DJF"]
GALE = 17.2


STATION = sys.argv[1] if len(sys.argv) > 1 else "hammer"


def load():
    os.makedirs(HERE, exist_ok=True)
    for y in range(2015, 2025):
        f = f"{HERE}/{STATION}_{y}.csv"
        if not os.path.exists(f):
            urllib.request.urlretrieve(f"https://noaa-global-hourly-pds.s3.amazonaws.com/{y}/{IDS[STATION]}.csv", f)
    fs = sorted(glob.glob(f"{HERE}/{STATION}_*.csv"))
    want = {"DATE", "REPORT_TYPE", "WND", "TMP", "DEW", "AW1", "GA1", "GA2", "GA3", "GF1"}
    x = pd.concat([pd.read_csv(f, low_memory=False, usecols=lambda c: c in want) for f in fs])
    x = x[x.REPORT_TYPE.str.strip() == ("FM-15" if STATION == "ronne" else "FM-12")].copy()
    x["t"] = pd.to_datetime(x.DATE)
    x = x[x.t.dt.minute == (50 if STATION == "ronne" else 0)].copy()
    x["t"] = x.t.dt.floor("h")
    x = x.drop_duplicates("t").set_index("t").sort_index()
    w = x.WND.str.split(",", expand=True)
    spd = pd.to_numeric(w[3], errors="coerce") / 10
    ok = w[4].isin(["1", "5"]) & (spd < 900)
    x["u"] = spd.where(ok)
    d = pd.to_numeric(w[0], errors="coerce")
    x["dir"] = d.where(ok & (d <= 360) & (w[2] != "C"))
    tm = x.TMP.str.split(",", expand=True)
    x["T"] = (pd.to_numeric(tm[0], errors="coerce") / 10).where(tm[1].isin(["1", "5"]) & (pd.to_numeric(tm[0], errors="coerce") < 900))
    x["aw"] = pd.to_numeric(x.AW1.str.split(",").str[0], errors="coerce") if "AW1" in x else np.nan
    layers = [pd.to_numeric(x[c].str.split(",").str[0], errors="coerce").where(lambda v: v <= 8) for c in ("GA1", "GA2", "GA3") if c in x]
    okta = pd.concat(layers, axis=1).max(axis=1)
    total = pd.to_numeric(x.GF1.str.split(",").str[0], errors="coerce").where(lambda v: v <= 8) if "GF1" in x else okta * np.nan
    if STATION == "ronne":
        x["okta"] = okta.where(okta.notna(), np.where(total == 0, 0, np.nan))
        x["okta"] = x.okta.fillna(0)  # no cloud group: METAR NSC/CAVOK/NCD, no cloud detected
    else:
        x["okta"] = total.where(total.notna(), okta)  # the SYNOP's total cover, else its largest layer; else unknown
    return x[["u", "dir", "T", "aw", "okta"]].asfreq("h")


def season(idx):
    m = idx.month
    return pd.Series(np.select([np.isin(m, [12, 1, 2]), np.isin(m, [3, 4, 5]), np.isin(m, [6, 7, 8])], ["DJF", "MAM", "JJA"], "SON"), index=idx)


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
    a, b = v.values, v.shift(-lag).values
    m = ~np.isnan(a) & ~np.isnan(b)
    return np.corrcoef(a[m], b[m])[0, 1]


def main():
    x = load()
    s = classify(x)
    sea = season(x.index)
    print(f"hours {len(x)}, missing {s.isna().mean():.3f}")
    print("shares all", s.value_counts(normalize=True).reindex(STATES).round(4).tolist(), "runs", runs(s).round(2).tolist())
    P, C = transitions(s)
    print("storm row pooled", P.loc["storm"].round(4).tolist(), "n", int(C.loc["storm"].sum()))
    for q in SEASONS:
        ss = s.where(sea == q)
        P, C = transitions(ss)
        u = x.u.where(sea == q).groupby(ss).agg(["mean", "std"]).reindex(STATES)
        print(q, "share", ss.value_counts(normalize=True).reindex(STATES).fillna(0).round(4).tolist(), "runs", runs(ss).round(2).tolist())
        print("  P", P.round(4).values.tolist(), "n", C.sum(axis=1).tolist())
        print("  u", u["mean"].round(2).tolist(), "sd", u["std"].round(2).tolist())
    # wind anomaly persistence
    g = pd.DataFrame({"u": x.u, "s": s, "q": sea})
    st = g.groupby(["q", "s"]).u.agg(["mean", "std"])
    key = pd.MultiIndex.from_arrays([g.q, g.s])
    z = pd.Series((g.u.values - st["mean"].reindex(key).values) / st["std"].reindex(key).values, index=g.index)
    print("wind mean", round(x.u.mean(), 2), "anomaly lag1", round(acf(z, 1), 3), "lag6", round(acf(z, 6), 3), "lag24", round(acf(z, 24), 3))
    # direction
    th = np.radians(x.dir.where(x.u >= 1))
    cx, sx = np.cos(th), np.sin(th)
    print("dir R", round(float(np.hypot(cx.mean(), sx.mean())), 3), "from", round(float((np.degrees(np.arctan2(sx.mean(), cx.mean())) + 360) % 360)), "lag1", round(acf(cx - cx.mean(), 1), 3), round(acf(sx - sx.mean(), 1), 3), "lag24", round(acf(cx - cx.mean(), 24), 3), round(acf(sx - sx.mean(), 24), 3), "sd", round(float(cx.std()), 3), round(float(sx.std()), 3))
    for q in SEASONS:
        m = sea == q
        c2, s2 = cx.where(m), sx.where(m)
        print("  ", q, "R", round(float(np.hypot(c2.mean(), s2.mean())), 3), "from", round(float((np.degrees(np.arctan2(s2.mean(), c2.mean())) + 360) % 360)))
    print("okta by state", x.okta.groupby(s).mean().reindex(STATES).round(2).tolist())
    # days: range of the day's air by season and kind of day (daily mean okta, wet hours)
    day = pd.DataFrame({"T": x["T"], "okta": x.okta, "wet": s.isin(["rain", "storm"]), "n": x["T"].notna()}).resample("D").agg({"T": ["max", "min"], "okta": "mean", "wet": "sum", "n": "sum"})
    day.columns = ["tx", "tn", "okta", "wet", "n"]
    day = day[day.n >= 20]
    day["dtr"] = day.tx - day.tn
    day["q"] = season(day.index).values
    kind = np.select([(day.wet == 0) & (day.okta <= 1), (day.wet == 0) & (day.okta >= 6), day.wet >= 2], ["clear", "cloudy", "rain"], "")
    day["kind"] = kind
    tab = day[day.kind != ""].groupby(["kind", "q"]).dtr.agg(["mean", "count"]).round(2)
    print("DTR by kind and season:\n", tab.unstack("q").reindex(columns=SEASONS, level=1).to_string())
    # rain hours against dry hours at the same month and hour
    h = pd.DataFrame({"T": x["T"], "s": s, "m": x.index.month, "hr": x.index.hour, "q": sea})
    dry = h[h.s.isin(["clear", "cloudy"])].groupby(["m", "hr"]).T.mean()
    rain = h[h.s.isin(["rain", "storm"])].copy()
    rain["d"] = rain["T"].values - dry.reindex(pd.MultiIndex.from_arrays([rain.m, rain.hr])).values
    print("rain minus dry by season", rain.groupby("q").d.mean().reindex(SEASONS).round(2).tolist(), "n", rain.groupby("q").d.count().reindex(SEASONS).tolist())
    print("wet share by season", [round(float(s.where(sea == q).isin(["rain", "storm"]).sum() / s.where(sea == q).notna().sum()), 4) for q in SEASONS])


if __name__ == "__main__":
    main()

"""Nomads weather research: NOAA ISD hourly SYNOP analysis for Irish coastal stations.

Data: NOAA NCEI Integrated Surface Database (global-hourly CSV), AWS open-data mirror
  https://noaa-global-hourly-pds.s3.amazonaws.com/{year}/{station}.csv
Stations: Malin Head 03980099999, Belmullet 03976099999, Valentia 03953099999; 2015-2024.

Usage: python3 /tmp/nm/isd.py   (downloads missing CSVs into /tmp/nm/isd/, then prints report)
Requires: pandas, numpy, scipy.
"""
import glob
import os
import urllib.request

import numpy as np
import pandas as pd
from scipy import stats

CACHE = "/tmp/nm/isd"
YEARS = range(2015, 2025)
STATIONS = {"03980099999": "Malin Head", "03976099999": "Belmullet", "03953099999": "Valentia"}
GALE = 17.2  # m/s, Beaufort 8 lower bound
STATES = ["clear", "cloudy", "rain", "storm"]
SEASONS = ["MAM", "JJA", "SON", "DJF"]


def download():
    os.makedirs(CACHE, exist_ok=True)
    for st in STATIONS:
        for y in YEARS:
            path = f"{CACHE}/isd_{st}_{y}.csv"
            if not os.path.exists(path):
                urllib.request.urlretrieve(f"https://noaa-global-hourly-pds.s3.amazonaws.com/{y}/{st}.csv", path)


def season(idx):
    m = idx.month
    return pd.Series(np.select([np.isin(m, [12, 1, 2]), np.isin(m, [3, 4, 5]), np.isin(m, [6, 7, 8])],
                               ["DJF", "MAM", "JJA"], "SON"), index=idx)


def load(st):
    """Hourly (on-the-hour FM-12 SYNOP) frame on a complete hourly index; gaps are NaN."""
    want = {"DATE", "REPORT_TYPE", "WND", "AW1", "GA1", "GA2", "GA3"}
    fs = sorted(glob.glob(f"{CACHE}/isd_{st}_*.csv"))
    x = pd.concat([pd.read_csv(f, low_memory=False, usecols=lambda c: c in want) for f in fs])
    x = x[x.REPORT_TYPE.str.strip() == "FM-12"].copy()
    x["t"] = pd.to_datetime(x.DATE)
    x = x[x.t.dt.minute == 0].drop_duplicates("t").set_index("t").sort_index()
    # WND = dir,dir_qc,type,speed*10,speed_qc
    w = x.WND.str.split(",", expand=True)
    dirn = pd.to_numeric(w[0], errors="coerce")
    spd = pd.to_numeric(w[3], errors="coerce") / 10
    ok = w[4].isin(["1", "5"]) & (spd < 900)
    x["u"] = spd.where(ok)
    x["dir"] = dirn.where(ok & (dirn <= 360) & (w[2] != "C"))
    # AW1 = automatic present weather (WMO 4680); absent => no significant weather reported
    x["aw"] = pd.to_numeric(x.AW1.str.split(",").str[0], errors="coerce") if "AW1" in x else np.nan
    cov = [pd.to_numeric(x[c].str.split(",").str[0], errors="coerce").where(lambda v: v <= 8)
           for c in ("GA1", "GA2", "GA3") if c in x]
    x["okta"] = pd.concat(cov, axis=1).max(axis=1)  # max layer amount; NaN = no cloud group
    x = x[["u", "dir", "aw", "okta"]].asfreq("h")  # insert missing hours as NaN rows
    return x


def classify(x):
    wet = x.aw.between(40, 89)
    dry = ~wet
    st = pd.Series(np.select(
        [wet & (x.u >= GALE), wet & (x.u < GALE), dry & (x.okta <= 2), dry],
        ["storm", "rain", "clear", "cloudy"], ""), index=x.index)
    # missing hour (no speed => cannot split rain/storm, and treat whole row as gap)
    st[x.u.isna()] = np.nan
    st = st.replace("", np.nan)
    return st


def runs(s):
    """Mean run length per state; runs are broken at NaN (missing hours)."""
    grp = (s != s.shift()).cumsum()
    r = pd.DataFrame({"s": s, "g": grp}).dropna().groupby("g").agg(s=("s", "first"), n=("s", "size"))
    return r.groupby("s").n.mean().reindex(STATES)


def transitions(s):
    a, b = s, s.shift(-1)
    m = a.notna() & b.notna()
    ct = pd.crosstab(a[m], b[m]).reindex(index=STATES, columns=STATES, fill_value=0)
    return ct.div(ct.sum(axis=1), axis=0)


def acf(v, lag):
    a, b = v.values, v.shift(-lag).values
    m = ~np.isnan(a) & ~np.isnan(b)
    return np.corrcoef(a[m], b[m])[0, 1]


def report():
    pd.set_option("display.width", 200)
    for st, name in STATIONS.items():
        x = load(st)
        s = classify(x)
        sea = season(x.index)
        print(f"\n===== {name} ({st}) hours={len(x)} missing={s.isna().sum()} ({s.isna().mean():.2%})")
        # sensitivity: dry hours with no cloud group
        nocg = (s == "cloudy") & x.okta.isna()
        print(f"dry hours with no cloud group (classed cloudy): {nocg.mean():.3f} of all hours, mean u {x.u[nocg].mean():.2f}")
        for label, mask in [("ALL", pd.Series(True, index=x.index))] + [(q, sea == q) for q in SEASONS]:
            ss = s.where(mask)
            share = ss.value_counts(normalize=True).reindex(STATES).fillna(0)
            rl = runs(ss)
            uu = x.u.where(mask).groupby(ss).agg(["mean", "std"]).reindex(STATES)
            print(f"\n-- {label}")
            print(pd.DataFrame({"share": share.round(4), "mean_run_h": rl.round(2),
                                "u_mean": uu["mean"].round(2), "u_sd": uu["std"].round(2)}))
            # transitions counted only where both hours are in this season (t and t+1 valid)
            print("P(row -> col):")
            print(transitions(ss).round(4))
        ok = x.okta.groupby(s).agg(["mean", "std"]).reindex(STATES)
        nog = x.okta.isna().groupby(s).mean().reindex(STATES)
        print("\nokta by state (hours with a cloud group; no_cloud_group_frac = hours without one):")
        print(pd.DataFrame({"okta_mean": ok["mean"].round(2), "okta_sd": ok["std"].round(2),
                            "no_cloud_group_frac": nog.round(3)}))
        # sensitivity: dry hours with no cloud group counted as clear (ceilometer "no cloud detected")
        alt = s.copy()
        alt[(s == "cloudy") & x.okta.isna()] = "clear"
        print("\nSENSITIVITY (dry & no cloud group -> clear), all seasons:")
        print(pd.DataFrame({"share": alt.value_counts(normalize=True).reindex(STATES).round(4),
                            "mean_run_h": runs(alt).round(2),
                            "u_mean": x.u.groupby(alt).mean().reindex(STATES).round(2)}))
        print(transitions(alt).round(4))
        # weibull + direction
        k, _, c = stats.weibull_min.fit(x.u[x.u > 0].dropna(), floc=0)
        print(f"\nWeibull MLE k={k:.2f} c={c:.2f}")
        th = np.radians(x.dir.where(x.u >= 1))
        cx, sx = np.cos(th), np.sin(th)
        mc, ms = cx.mean(), sx.mean()
        R = np.hypot(mc, ms)
        mdir = (np.degrees(np.arctan2(ms, mc)) + 360) % 360  # direction wind blows FROM
        print(f"dir: n={th.notna().sum()} R={R:.3f} mean_from={mdir:.0f} deg; mean cos={mc:.3f} sin={ms:.3f}")
        for lag in (1, 24):
            print(f"  lag{lag}: r(cos)={acf(cx - mc, lag):.3f} r(sin)={acf(sx - ms, lag):.3f}")
        print(f"  anomaly SD: cos {cx.std():.3f} sin {sx.std():.3f}")
        for q in SEASONS:
            m = sea == q
            c2, s2 = cx.where(m), sx.where(m)
            print(f"  {q}: R={np.hypot(c2.mean(), s2.mean()):.3f} mean_from={(np.degrees(np.arctan2(s2.mean(), c2.mean())) + 360) % 360:.0f} "
                  f"lag1 cos={acf(c2 - c2.mean(), 1):.3f} sin={acf(s2 - s2.mean(), 1):.3f}")


if __name__ == "__main__":
    download()
    report()

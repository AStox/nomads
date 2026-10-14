import sys; import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
from isd import load, classify, season, transitions, runs, acf, STATES
x = load("03976099999"); s = classify(x); s[(s == "cloudy") & x.okta.isna()] = "clear"
sea = season(x.index)
print("u lag1", round(acf(x.u - x.u.mean(), 1), 3))
for q in ["MAM", "JJA", "SON", "DJF"]:
    ss = s.where(sea == q); P = transitions(ss)
    u = x.u.where(sea == q).groupby(ss).agg(["mean", "std"]).reindex(STATES)
    print(q, "share", ss.value_counts(normalize=True).reindex(STATES).fillna(0).round(4).tolist(), "run", runs(ss).round(2).tolist())
    print("  P", P.round(4).values.tolist())
    print("  u", u["mean"].round(2).tolist(), "sd", u["std"].round(2).tolist())
# standardized within-state, within-season speed anomaly and its lag-1 autocorrelation
g = pd.DataFrame({"u": x.u, "s": s, "q": sea})
st = g.groupby(["q", "s"]).u.agg(["mean", "std"])
z = (g.u - st["mean"].reindex(pd.MultiIndex.from_arrays([g.q, g.s])).values) / st["std"].reindex(pd.MultiIndex.from_arrays([g.q, g.s])).values
z = pd.Series(z, index=g.index)
print("anomaly lag1", round(acf(z, 1), 3), "lag6", round(acf(z, 6), 3), "lag24", round(acf(z, 24), 3), "sd", round(z.std(), 3))

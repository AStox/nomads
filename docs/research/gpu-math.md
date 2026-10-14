# The world's integer arithmetic on the GPU

src/gpu/fixed.ts, src/gpu/rand.ts and their WGSL twins (src/gpu/wgsl/), Phase A Unit 2 of docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md. Every routine a gate kernel uses is integer-only and gives the same bits on the GPU as its TypeScript twin, on both adapters of the dev machine (AMD Radeon Pro 5500M, Intel UHD 630). Floats differ between GPUs from about the sixth digit; integers did not, which is why the world's arithmetic is fixed point (plan: Key Technical Decisions).

Measured on the AMD unless stated; tests are src/gpu/fixed.test.ts and src/gpu/rand.test.ts.

## Files
- **WGSL** is kept in TypeScript string modules, so Bun at runtime and `Bun.build` both import it with no loader:
  - `src/gpu/wgsl/fixed.ts` exports `FIXED`.
  - `src/gpu/wgsl/rand.ts` exports `RAND`, which needs `FIXED` placed before it.
  - Each routine exists once. Tables and constants are computed in the TypeScript twin and pasted into the WGSL.
- **TypeScript twins:** `src/gpu/fixed.ts` and `src/gpu/rand.ts`. They mirror the WGSL line for line using 32-bit operations.
- **Tests:** `src/gpu/fixed.test.ts` and `src/gpu/rand.test.ts`.

## Formats
- **Q16.16 in an i32:** range -32768 to 32767.99998, steps of 2^-16. Results out of range saturate to +-0x7fffffff (never 0x80000000).
- **Q32.32:** a signed 64-bit integer held as two u32 words (lo, hi). Used for intermediates and wide results such as `lgamma32`, which covers every positive Q16.16 input.
- **Q0.32 / Q1.31:** unsigned fractions in one u32; a uniform word is Q0.32.
- **Q8.56:** used only for the binomial sampler's acceptance bounds.
- **224-bit numbers** (7 limbs): used only by that sampler's slow path.

## Error bounds (1 ulp = 2^-16; checked against float64 over dense grids)

| Routine | Bound | Measured worst |
|---|---|---|
| `qadd` | exact (saturating) | exact |
| `qmul`, `qdiv` | 0.5 ulp, ties away from zero | 0.5 ulp |
| `qsqrt` | floored, under 1 ulp | under 1 ulp |
| `qlog2`, `qln` | 0.5 ulp + 2^-26 | 0.500 ulp |
| `qexp` | 0.5 ulp + 2^-29 of the result | 1.27 ulp at 10.37 (about 2^-30.6 relative) |
| `qpow(x, y)` | 0.5 ulp + 2^-28 (1 + abs(y log2 x)) of the result | half the bound |
| `qlgamma(x)` | 0.5 ulp + x 2^-29 | 0.6 ulp at 3,892 |
| `lgamma32(x)` | 2^-28 + x 2^-30 | inside the bound everywhere |
| `qgamma` | 0.5 ulp + 2^-27 of the result | 5.1 ulp at 8.59 (about 2^-28.6 relative) |

- **Saturation:** `qexp` returns exactly 0 below about -12.2 and saturates above 10.4. `qgamma` saturates outside (3.05e-5, 8.6), and `qlgamma` past 4,100.
- **Internal cores:** log2 uses 32 repeated squarings, good to about 2^-30. exp2 uses a 256-entry table plus four series terms, good to about 2^-30 relative. Every table entry sits at least 0.0064 of a step from a rounding boundary, so every JavaScript engine builds the same table.

## Randomness
- **Generator:** Philox4x32-10, keyed by (seed, stream) with counter (id, tick, block, slot). It matches all three Random123 known-answer vectors, in TypeScript and on the GPU.
- **Counter slots:** slot 0 is the plain stream; slot j >= 1 holds lazily read uniforms with unlimited digits; slot 0xffffffff holds the Feistel round keys.
- **Distributions, in fixed point, mean and variance within 5 standard errors over 2^20 draws:**
  - uniform, and exponential as -ln of a uniform word
  - normal, by the Marsaglia polar method
  - Poisson: summed exponential gaps below lambda = 16, Hormann's PTRS from 16 up
  - gamma: Marsaglia-Tsang, with a boost below shape 1
  - lognormal, and the Weibull quantile
- **Exact samplers:**
  - **`binhalf`:** popcount below 4096. Above, the Bringmann et al. 2014 rejection sampler with Karney's exact exponential; its comparisons extend digits as needed, so ties never break exactness.
  - **Slow path (`slowAccept`):** forms Q = 2^k q(a) as an exact rational product and e^-E by series, both in 224-bit arithmetic with proven error terms.
    - It decides correctly whenever the two intervals separate. If they still overlap, which is roughly a 2^-160 of slow-path calls (about a 2^-203 of all proposals, a being the proposal's offset), it rejects and counts a flag.
    - In 736 forced ambiguous cases checked against an independent 640-bit BigInt Newton reference, every decided case matched the reference and the GPU matched TypeScript. All cases that differ from the threshold within 128 bits were decided. 104 cases that differ only beyond bit 128 were left undecided and flagged.
  - **`binom(n, K)`:** the bit-sliced chain (popcount below 4096, rejection above).
  - **`multinom`:** splits only the dyadic nodes that straddle an outcome boundary; up to 16 outcomes.
  - **`geowait`:** an exact geometric wait. It skips blocks with `bernpow` (an exact (1-p)^M test), then draws binary digits with an exact Ber(c/(1+c)) built from fair bits; there are no approximate tables.
  - **`feistel` / `feistelInv`:** Black-Rogaway, 4 rounds, with cycle-walking over any domain size up to 2^32 - 1.

## Test results
- **GPU equals twin:** every routine matches bit for bit over dense grids on the high-performance adapter, and over subsets on the low-power adapter (`openGpu('low-power')`).
- **Uncorrelated keys:** for all 128 single-bit flips of the key, cross-correlation, mean and lag-1 z-scores all stay below 5.
- **Exact binomial, 2^22 samples each:**

| Law | mean z | variance z | chi-squared z |
|---|---|---|---|
| Bin(4097, 1/2) | 1.69 | 0.74 | -1.08 |
| Bin(10^6, 1/2) | 0.15 | 0.90 | -0.88 |
| Bin(10^9, 1/2) | 0.16 | 0.86 | 0.56 |
| Bin(4097, 0x9e3779b9/2^32) | -0.59 | -0.88 | -0.05 |
| Bin(10^6, 0.3) | 0.78 | 2.01 | -0.67 |
| Bin(10^9, 0.003) | -1.03 | -1.39 | 0.38 |

- **Flags and forced slow path:** no flags in normal mode. With every acceptance forced through the slow path, the sampler still passes at 4097, 100,001 and 10^6, and the GPU matches TypeScript.
- **Other samplers:**
  - Multinomial margins and sums pass.
  - Geometric means pass at p = 0.3, 0.01 and 1e-6.
  - Feistel is a bijection, checked exhaustively for every n <= 600 and at 65,536, 65,537 and 2^20, and by 2^20 samples at 10^9 and 2^32 - 1.

## Throughput (AMD Radeon Pro 5500M)

| Routine | Per second |
|---|---|
| Philox words | 2.08e10 |
| qmul | 1.70e10 |
| qexp | 8.5e9 |
| qdiv | 5.1e9 |
| Feistel at n = 10^9 | 4.7e9 |
| qsqrt | 2.5e9 |
| qpow | 2.4e9 |
| qln | 2.1e9 |
| qexpo | 1.8e9 |
| qlgamma | 1.4e9 |
| qgamma | 7e8 |
| qnormal | 1.7e8 |
| qpoisson (lambda 5 and 100) | 1.2e8 to 1.35e8 |
| qgammav(2.5) | 1.1e8 |

| Exact sampler | Draws/s | Fates/s |
|---|---|---|
| binhalf(4097) | 4.6e7 | 1.9e11 |
| binhalf(10^6) | 5.0e7 | 5.0e13 |
| binhalf(10^9) | 5.0e7 | 5.0e16 |
| binom(1e3, 0.3) | 3.8e7 | 3.8e10 |
| binom(1e4, 0.3) | 1.15e7 | 1.15e11 |
| binom(1e6, 0.003) | 4.1e6 | 4.1e12 |
| binom(1e9, 0.003) | 2.15e6 | 2.15e15 |
| multinom(1e6, 5 outcomes) | 1.0e6 | 1.0e12 |
| geowait, p = 0.3 | 5.6e7 | |
| geowait, p = 2^-8 | 2.4e7 | |
| geowait, p = 1e-3 | 8.3e6 | |
| geowait, p = 1e-6 | 2.9e5 | |

## Gap: geometric waits are slow for small p
- **Measured rates:** 5.6e7 draws/s at p = 0.3, 2.4e7 at p = 2^-8 (3.9e-3), 8.3e6 at p = 1e-3, 2.9e5 at p = 1e-6.
- **Why:** each draw takes about B = log2(1/p) + 1 binary digits, and every digit needs one or more exact (1-p)^M tests, each a chain of about log2(1/p) exact Bin(m, 1/2) draws. Cost therefore grows roughly with log2(1/p)^2, and the popcount levels near m = 4096 dominate.
- **Where it is slow:** against the prototype's budget (35.6 ms a simulated day for 5.4e8 individuals with about 2 million candidates a day):
  - p >= 2^-8 is fine: about 0.08 s a day.
  - p = 1e-3 costs about 0.24 s a day.
  - p <= 1e-4 costs seconds a day; at p = 1e-6, 2 million candidates take about 7 s.
- **Recommendation:** event-driven kinds should draw waits at p_max = 2^-8 and thin to the actual hazard, as the prototype did.

## Notes for integrators
- **WGSL `select` runs both arms.** This caused the one twin bug found: a random draw inside `select` was always consumed. Never put a draw inside `select`.
- **Shader compile time:** the geowait kernel took about 4.6 s to compile on first use (once `bernpow` had a single call site); macOS's shader cache makes later runs fast.

## Gates at 13b967b (Phase A)

Phase A changes no law of the world, but awaiting each tick lets the random brain's promise chains move after every tick rather than every fourth, which moves the probe runs. Probes, against a8bf4da, fail eleven: two/real right, exact and caught 1.00 to 0.85 to 0.87 and partly 0.00 to 0.13; seed/real wasted 0.30 to 0.69; unlearn/real wasted 0.32 to 0.49; and the claims that come and go pass by pass (seed/real's, seed/two's and unlearn/real's that nearly all whose tries show the true cause come to rule it out, seed/sparse's that more blame the true cause than anything else, hearsay/real's by the end); two/real wastedEarly improves 0.33 to 0.19. Worlds, against 2258536, pass: worked 0.91 to 0.99, wasted 0.10 to 0.05. Ledger versions were left as they were: what the tiers measure did not change meaning, only when the brain's answers land. Not retuned.

## Sources

- Salmon J.K., Moraes M.A., Dror R.O., Shaw D.E. (2011), Parallel random numbers: as easy as 1, 2, 3, SC11 (Philox4x32-10 and its known-answer vectors). https://www.thesalmons.org/john/random123/papers/random123sc11.pdf
- Bringmann K., Kuhn F., Panagiotou K., Peter U., Thomas H. (2014), Internal DLA: efficient simulation of a physical growth model, ICALP 2014, Appendix A.2 (exact Bin(2N, 1/2) sampling). https://people.mpi-inf.mpg.de/~kbringma/paper/2014ICALP.pdf
- Karney C.F.F. (2016), Sampling exactly from the normal distribution, ACM TOMS 42:3 (Algorithm V, exact exponential by uniform comparisons). https://arxiv.org/abs/1303.6257
- Black J., Rogaway P. (2002), Ciphers with arbitrary finite domains, CT-RSA 2002 (Feistel with cycle-walking). https://www.cs.ucdavis.edu/~rogaway/papers/subset.pdf
- Marsaglia G., Tsang W.W. (2000), A simple method for generating gamma variables, ACM TOMS 26:363.
- Hormann W. (1993), The transformed rejection method for generating Poisson random variables, Insurance: Mathematics and Economics 12:39 (PTRS).

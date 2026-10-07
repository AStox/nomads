---
date: 2026-10-07
topic: fire-physics
---

# Fire from heat, not from steps

Status: discussion draft. The questions at the end decide its shape.

## Short answer

Yes. A spark or a friction ember carries almost no energy: it lights fine, dry tinder, the tinder's flame lights kindling, and the kindling's flames light fuel wood. Nobody has to write that ladder as a rule, because it falls out of how heat moves into fuel of different thickness. Fire size works the same way. A big fire stands up to wind and rain, keeps thick logs burning and lights what's near it, while a small one does none of those things, and that too comes from a heat balance.

## What the sim does today

- **Lighting is all or nothing.** A catching spark makes a whole fire in one tick: hp 50 for a spark, 60 plus a stick's fuel for friction (src/sim/physics.ts 360, 454). Nothing sits between the tinder catching and a lasting fire.
- **A fire is a fuel countdown.** hp is ticks of fuel left. Heat depends only on the setup (open 1.0, ringed 1.3, charcoal 2.0, blown air +0.5), never on how much is burning (physics.ts 28).
- **Feeding always works.** Anything with flammable at least 0.5 adds its kind's fuel (fiber 10, bark 15, stick 40, log 150), whatever state the fire is in (physics.ts 1022; src/sim/materials.ts 41).
- **Going out.** A fire goes out only when hp runs out, or when rain takes 2 hp a tick unless it's ringed. Wind does nothing, and no coals are left behind (src/sim/ecology.ts 223).
- **Spread** is a `scorch` counter tied to no physical quantity (ecology.ts 246).
- **Warmth and light don't depend on size.** Warmth is a flat +0.9 within 4 m, and light is 60 lux times the setup's heat (src/sim/sim.ts 1886; src/sim/light.ts 81).
- **Kinds carry no thickness, mass, density or moisture.** Only held tinder gets wet (src/sim/wetness.ts). A 0.4 m stick and a 1.6 m stick are the same item.

## The physics, from the bottom

1. **Lighting a piece of fuel.** Wood lights when its surface reaches about 350 °C while a flame or glowing spark is there to light the gas it gives off. How long that takes depends on thickness:
   - **Thin pieces heat through as a whole** (a grass blade, a fiber, a shaving): time ≈ ρ·c·(volume/area)·ΔT / q, where q is the net heat flux arriving. In a flame that is a second or two.
   - **Thick pieces heat only their skin**: time ≈ (π/4)·kρc·ΔT² / q². Below a critical flux of about 12 kW/m² they never light at all, because the hot skin sheds heat by radiation and to the air as fast as it gets it. Measured on wood, it takes about 100 s at 25 kW/m² and about 15 s at 50.
   - **Water comes first.** Every kg of water in the fuel has to be heated and boiled off (2.6 MJ), so damp fuel takes far longer to light. Fine fuel wetter than about 30% can't carry a flame at all.
2. **Burning.** A lit piece burns inward from its surface at roughly a millimetre a minute, so how long it lasts goes with its thickness: tinder a few seconds, a twig two or three minutes, a finger-thick stick ten or fifteen, a wrist-thick branch most of an hour, a log hours. It gives off heat at mass-burnt-per-second times 15 to 18 MJ/kg. That is why fine fuel flares big and briefly and a log burns small and long.
3. **Staying alight.** A flame on a piece of fuel survives only while the heat it gets back covers what its surface loses plus what it takes to keep gas coming off. At ordinary scale a lone thick piece can't manage that: a single log goes out, and three logs facing each other burn, because they radiate into one another.
4. **Size sets the flames, and the flames set everything else.**
   - A fire's heat output Q sets its flame height, roughly 0.235·Q^0.4 − 1.02·D metres (Q in kW, D the fire's width).
   - Flames radiate in proportion to how thick they are, as 1 − e^(−κ·depth) with κ about 1 per metre. A 10 cm flame is nearly transparent and gives the fuel under it perhaps 10 to 20 kW/m². Flames a metre thick give 60 or more.
   - That is the ladder in one line: a small fire can't push enough flux into thick wood, or keep doing it for long enough, and a big fire can.
5. **What puts fires out.**
   - **Wind:** a flame blows off when the wind beats a few times its own updraft, which is about √(g·flame height). A tinder flame goes out in a stiff breeze, while a campfire just burns harder because the wind brings it air.
   - **Rain:** every kg of water landing takes 2.6 MJ. 1 mm an hour is about 0.7 kW per m², which a small flame feels and a big bed hardly does. Rain wets the fuel that isn't burning yet more than it cools the fire.
   - **Fuel:** too wet, too far apart (the pieces can't heat each other), or packed too tight (no air).
6. **Coals.** After the flames, about a quarter of the wood is left as char, which glows at 600 to 900 °C. Coals give out little heat but last for hours, and laid-on kindling lights from them (glowing coal radiates tens of kW/m² at contact). That is banking a fire overnight and blowing it back up in the morning.
7. **What a fire lights around it.** Radiant flux at distance r is about 0.3·Q / (4π·r²).
   - A 10 kW campfire gives about 0.25 kW/m² at a metre: warmth, but nowhere near the ~12 kW/m² that lights things. Only what touches its flames catches.
   - A 1 MW blaze gives about 24 kW/m² at a metre and 2.6 at three.
   - Wind leans the flames over what's downwind and carries embers into dry grass. That, not radiation across metres, is how a campfire starts a grass fire.

Here is how the ladder comes out, in rough numbers to be checked against the literature when planning:

| Fuel | Thickness | Lights from a tinder flame (about 30 s) | Lights from burning twigs (a few minutes) | Keeps burning alone | Burns for |
|---|---|---|---|---|---|
| grass, fiber, shavings | under 1 mm | in a second or two | yes | as a flare | seconds |
| twigs | 2 to 5 mm | in 5 to 15 s | yes | briefly | 2 to 4 min |
| finger-thick sticks | 1 to 2 cm | barely or not | yes, in about a minute | only among others | 10 to 15 min |
| wrist-thick branches | 5 to 8 cm | no | only in a bed of sticks | only in a bed | about an hour |
| logs | 15 cm and up | no | no | only in a bed of coals and branches | hours, then coals |

## Ways to put it in the sim

**A. Each fire is a bed of fuel pieces, solved in closed form.**
- A fire holds the pieces laid on it: kind, thickness, mass, moisture, how far burnt, plus its coals.
- Each tick its output Q comes from the burning pieces. Q gives the flame size and the flux reaching each piece not yet alight.
- Every piece lights, burns down, or goes out by the formulas above, and the bed goes out when its feedback can't cover losses to wind, rain and wet fuel.
- A young fire's first minutes run in a handful of short steps inside the tick (or by the formulas' own closed forms), since tinder lives for seconds.
- Warmth, light, cooking heat and what catches nearby all follow from Q.
- Pros: every outcome is a formula of the fuel's properties, and the ladder, the lone log and banked coals all emerge. Fires are few, so it's cheap.
- Cons: kinds need real thickness, density and moisture; items need sizes; a fire carries more state.

**B. Size classes and one intensity (wildland style).**
- A fire holds its fuel mass in a few classes by surface-to-volume ratio, plus one intensity number. Each class lights or doesn't by intensity, ratio and moisture, as Rothermel's spread model does.
- Pros: small state, and a lot of published calibration.
- Cons: the classes are a coarse cut, close to the hardcoded ladder you don't want, and per-piece effects such as the lone log are lost.

**C. Heat on everything near a fire.**
- Every flammable thing within some metres of a fire carries a temperature that rises with the flux it gets and falls with its losses. Anything past its ignition temperature burns.
- Campfires, grass fires, a shelter catching from a blaze and fuel on a fire would all be one mechanism.
- Pros: the most general.
- Cons: per-tick cost on many things, and the most work to keep predictable for formulas.ts.

**D. Time budgets only** (the inverted angle).
- No temperatures at all. Each burning piece offers a flux for as long as it lasts, and each piece not yet alight needs a time to light under that flux. It lights if the second is shorter than the first.
- The ladder comes straight from lighting time growing faster with thickness than a source's burning time does.
- Pros: almost no state, and trivially predictable.
- Cons: rough where several sources preheat a piece together.

**Recommendation:** A, with D's closed forms inside it so a young fire needs no tiny steps, and with C's idea for spread kept to the same flux formula. What lies close to a fire, or downwind of it, catches by the flux it actually gets and by embers, and the scorch counter goes away.

## What it changes around it

- **Making a fire is lighting the tinder and then building on it.** Whether it lasts depends on what they lay on it: tinder alone flares and dies, tinder with twigs makes a small fire, and logs need a bed. Its truth in src/sim/formulas.ts becomes the bed's outcome, not "the spark caught".
- **Feeding can fail.** A log on a dying flame doesn't catch, wet wood can smother a small fire, and fuel laid on coals relights it.
- **Weather acts by physics.** Wind kills small flames and feeds big ones, and rain matters by size and by wetting the fuel. A ring of stones blocks wind and throws heat back in, so its effects follow from that instead of a 1.3 factor.
- **Warmth, light, cooking and forging scale with the fire's output.** A forge needs a big hot bed, not a flag.
- **People learn it the same way they learn everything.** The conditions they can notice would include how thick the fuel was, how big the fire was (coals, a small flame, a fire, a blaze), whether the fuel was damp or soaked (now for all fuel, not just tinder), the wind and the rain, each cut where its formula turns. A theory like "a log on a small flame doesn't take" can then form from their own record.

## Questions

1. Which model: A (pieces, recommended), B (classes), C (heat on everything), or D on its own?
2. Do items get their own sizes (each stick its own thickness and length, as the tree it came from), or do kinds carry typical sizes (twig, stick, branch, log as kinds)? Own sizes are truer; kinds keep stacks simple.
3. Should spread (grass, trees, shelters) move to the same physics now, or come after campfires?
4. Should all fuel get wet and dry as tinder does now (logs left out in the rain, wood drying by the fire)?

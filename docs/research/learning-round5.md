# Round five: what still isn't working, and why

Round five made every outcome a formula of physical properties and judged every probe by those formulas. Its baseline is probes 5 at 0109ff8 (twenty seeds) and worlds 5 at c669c7b (six islands, sixty days): 63 of 82 probe claims hold, recover's retry is unjudged, and both whole-world claims are open. This note explains why. Besides the gate's own numbers, it draws on reruns of the planting probes with every theory event and each person's cases dumped (seed/real seeds 1 to 6, seed/sparse 1 to 3, seed/two 1 to 3, hearsay 1 to 3, unlearn 1 to 3, and blame, two and recover on seed 1), and on a recount of the whole-world runs kept under `data/evals/runs/3vdiylo7ls497/worlds-60d`, which reproduces theory-report.ts's numbers exactly.

## In short

Fire's causes settle every outcome, so everyone learns fire at once and for good. Planting's causes, apart from deep shade, only shift the odds and add up with one another, and that breaks three things: theories that can only say "never" churn and overreach, nested conditions take each other's blame, and several planting claims are out of reach even of someone holding the formula's own causes. Some probes can no longer show what they ask (seed/two, hearsay, recover, choose). In whole worlds there is too little evidence to learn much in sixty days, learning on and off differ mostly by chance, and knowing a spot is bad doesn't keep anyone from planting there. Round three found that the next step is in what a theory can say (that a thing works less often somewhere, not never); with the truth now physical, that is where most of what's left points.

## 1. The fire probes are solved, so they no longer tell builds apart

In blame, confounded, two, except and rare everyone ends right and exact, with acc 1.00 at the midpoint and the end, within 0.3 to 1.2 days. What people can notice settles every case (pure 1.00): a spark catches just when the tinder is drier than damp and no gale is blowing, and the conditions are cut exactly there, so every failure carries its cause and every success lacks it. Each person forms each fire theory once and never drops it (blame: six formations for six people; two: twelve; recover: six of damp, then six of wind). With every number at its ceiling and no spread between seeds, these probes can only catch a regression now, never an improvement.

## 2. Some planting claims ask more than the truth allows

A planting probe's truth for a case is what most of six stretches of weather make of it, and apart from deep shade its causes only lower the odds. On seed/real, seed 1, the sampled cases came up like this:

| Spot | Came up |
|---|---|
| open sky | 100% |
| light shade alone | 94% |
| crowded | 27 to 43% by person |
| crowded and light shade | 10 to 31% |
| deep shade | 0% |

Crowding means very different things from probe to probe, since the condition is cut where crowding starts to hurt and how much it hurts depends on how crowded: in seed/sparse (seed 2) crowded spots came up 86 to 100% alone and 49 to 66% with light shade; in seed/two crowded spots came up 55 to 69%.

So a person holding exactly the formula's causes (not in deep shade, not crowded) is judged like this by the probes' own metrics (seed/real on seeds 1 to 4, the others on seeds 1 and 2):

| Probe | People | Best any per-case call could do (acc) | The true theory's acc | Below 0.9 | Counted wrong (over-cautious somewhere it mostly works) |
|---|---|---|---|---|---|
| seed/real | 24 | 0.934 | 0.922 | 5 | 22 |
| seed/sparse | 12 | 0.936 | 0.872 | 9 | 12 |
| seed/two | 12 | 0.878 | 0.809 | 12 | 12 |
| unlearn/real | 12 | 0.931 | 0.921 | 2 | 10 |

The claim that more blame the true cause than anything else (right above wrong) can't hold when the true theory itself counts as wrong for 56 of 60 people, and acc above nine in ten can't hold in seed/two (whose ceiling is 0.878) or seed/sparse; in seed/real and unlearn a perfect learner would clear it narrowly (0.92). These claims were set when a probe's cause was a rule that always killed; nobody re-based them on the formulas' truth. The learners do fall short of the true theory too (seed/real acc 0.823 against 0.922), for the reasons in 3 and 4.

## 3. Theories of partial causes churn

Across seed/real (seeds 1, 2 and 4) and unlearn/real (seeds 1 to 3), 36 planters over twenty days formed a theory of crowding 233 times and dropped it 186 times, and of shade 110 and 88 times; deep shade, where nothing ever comes up, was formed 35 times and never dropped. One planter (Brenna, seed/real seed 1) formed the crowding theory eight times and dropped it seven. A seed/real run sees 65 to 76 formations among six people; a fire probe sees one a person a cause.

Why: a success where a theory holds drops it whenever the successes there have caught up with the failures it rests on (sim.ts `surprised`), and those failures are counted only where no other theory of theirs holds, while every success counts (beliefs.ts `under`, `weighs`). With deep shade, shade and crowding overlapping, each takes the others' failures and looks weaker than it is, so a crowded seedling that comes up (a third of them do) knocks the crowding theory down until the next failures raise it again. It settles only late, as the record grows. Whether someone counts as right or wrong at the end is largely where they stand in that cycle.

## 4. Light shade takes deep shade's blame

In seed/real (seeds 1 to 6), 14 of 36 planters end up blaming shade on its own, though light shade alone comes up 94% of the time. Their acc ends at 0.68 to 0.75, against 0.89 to 0.96 for those holding only deep shade and crowding.

Why: people judge a condition of the spot all told (beliefs.ts `apart` returns `allTold` for a place condition), so their record of shade carries every deep-shade failure, and the shade theory can't fade on the record (`fades` wants it within ten points of how they do out of the shade). Only a success where it holds and nothing else they blame does can drop it, and they keep their seed out of the shade except to test. The answer key does the opposite: truth.ts judges light shade against open sky, with deep shade set aside (`AFTER`). The weather is judged like for like in people's heads; the spot isn't.

## 5. Evidence people never collect

- **seed/two.** On seed 1 all six planters end up blaming shade. Every light-shade planting they made was also crowded (none of their 5 to 10 came up), and none was in light shade alone, where all 240 sampled cases came up. Their wrong of 0.98 is the want of a try, not a wrong inference.
- **hearsay.** On seed 1 nobody planted in any shade: 105 of the 120 plantings went into crowded spots and the other 15 into open ground, so the four who start without the theory can't learn it from their own tries (evident 0.05), and the two who hold it never use it. Nor can it reach anyone by word: teaching is offered only for a way the learner doesn't know (sim.ts 532, 1652), and talk passes facts and customs, never theories (sim.ts 1566 and 1567). The spreading claim can't hold as the sim stands. Twenty plantings, nearly all in crowded spots that come up less than half the time, also breed false theories: 7 of 18 people on seeds 1 to 3 came to blame the wind.
- **seed/sparse and unlearn/sparse.** A berry a day leaves about twenty plantings in the run, and few people's own tries show the cause beyond chance (evident 0.13 and 0.07), so "most come to blame it" asks for what the evidence doesn't hold.

## 6. Recover no longer tests letting go

On seed 1 all six formed the damp theory within three hours of each other and none ever blamed the rain. After the bags, damp tinder still won't take a spark, so nothing anyone believes has become false, and the retry claim has nobody to judge. The probe now only checks that they find the gale.

## 7. Choose is a one-step script

Of two ways that look alike the planner takes the first it knows (plan.ts `search`), so everyone strikes stone once, finds it slower and switches: first is exactly 0.80 for every person on every seed. It checks that one slow try moves them, not how they weigh two ways.

## 8. Whole worlds: little evidence, noisy comparison, and knowing doesn't keep seed out of bad ground

- **The comparison is mostly two trajectories.** Learning on and off share every draw until someone forms a theory (day 20 to 60; island 6 never does), then the worlds part. Per island the share of late tries wasted swings both ways (island 1: 0.14 on, 0.00 off; island 2: 0.33 and 0.06; island 5: 0.21 and 0.29) on 14 to 85 tries, and 39 of the learners' 45 wasted late tries were made by someone holding no theory that bore on that try.
- **Learning works where it reaches, and it reaches little.** On island 5 late fire tries wasted 2 of 7 with learning on against 15 of 20 off, since the holders of damp and soaked never wasted a fire try after forming them. But only 28 learner tries in sixty days on six islands were touched by any theory, and 23% of late person-days held a true theory that could have been learned.
- **The evidence is thin and slow.** A median of two tries per person per way in sixty days; a planting shows after a median 3.8 days. A theory needs two of one's own failures in a condition, worse than chance: that happened 19 times, 10 became theories, at a median of day 44, and one was taught on six islands. That is why true theories held per person-day are 0.23 against 2.85 known from the start.
- **Knowing doesn't keep plantings out of bad ground.** Every one of the 21 plantings into a hurting condition with theories known from the start was made by someone holding that exact theory. When no spot within 3 m suits their theories, the spot picker takes the first the ground will take (physics.ts `spotNear`), and a theory about the spot never stops a planting the way a theory about the weather stops a try (sim.ts 1409).
- **The key calls conditions that only lower the odds hurting.** On island 1 berries came up 51% of the time in sour soil against 67% out of it; every try in sour soil counts as wasted. Sour was in 21 of the learners' 45 wasted late tries, and they formed a sour theory once (day 37) and a poor one never.
- **Two scoring artifacts.** A planting made as a test is scored as an ordinary try, because its test flag is read from the person's goal when the result shows, days later (sim.ts `testingNow` in `judged`); 2 of the 45 wasted late tries are tests. And 50 of the late tries with theories known from the start were at ways the key never judged, which flatters the ceiling.

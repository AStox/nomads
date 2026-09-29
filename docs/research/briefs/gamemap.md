# Game map (scout report)

Bun server (server.ts) holds one World in memory. loop() calls tick(w) every 500/speed ms, only while clients.size>0 && !paused. After each tick it diffs using the sets physics.changed/removed/newKinds, sim.changedKinds, ecology.pathChanges/iceChanged and groups.groupsChanged, and pushes a `tick` SSE message to every client. Each new client first gets a full `init` message. Agents choose goals with async Jev calls (brain.ts), which are replaced by random answers when NOMADS_BRAIN=random. Ticks don't wait for Jev; agents show thinking=true meanwhile. The terrain comes from src/terrain: generateIsland (128x128 cells of 75 m), then lay(), which gives 64x64 game tiles of 150 m, corner heights, and a packed Terrain for the client. The client (public/app.js with art.js, Canvas 2D) decodes the Terrain and paints a top-down watercolor ground canvas (64*36 px square). It warps that canvas per tile into a cached isometric layer and draws the static Things into it back to front. Each rAF frame it blits the layer scaled by the camera, then draws season/sky/night washes, camp outlines, fires, animals, agents (lerped between ticks), and weather particles. demo/styles/world.js grows the same Island client-side from a seed, but adds its own decorative flora and camp; the isopixel mock renders one static CPU frame from that.

# Nomads island-3d: map for an isopixel renderer

Worktree /root/repos/nomads-island is on branch island-3d (per .git -> /root/repos/nomads/.git/worktrees/nomads-island/HEAD). The live /root/repos/nomads (web-v1) is VERSION 5, has no src/terrain, uses a noise-based newWorld, and its init has no heights, terrain or groups (/root/repos/nomads/server.ts:121). Shipping island-3d means a VERSION change, which starts a new world (server.ts load(): renameSync to world.json.v<N>.bak).

## 1. What the game is, and what the human can do

It's a sim you watch. Five agents (world.ts newWorld, agentCount=5) wake up alone and act on their own: Jev picks goals (brain.ts decide/tinker/respond/reflect/rule) and GOAP-style planning plus physics does the rest. DESIGN.md:14 talks about a chronicle "for the player to read", and DESIGN.md:204 lists "Watchability" as a guardrail. There is no player character, no way to give commands, and no god powers. The index.html canvas aria-label reads: "Drag to pan, pinch or scroll to zoom, tap a person to open their ledger."

Every client input (public/app.js):
- **Canvas pointer:**
  - pointerdown/move/up (489-534): a one-pointer drag pans (after 6 px of movement) and turns follow off. Two pointers pinch-zoom and pan.
  - A mouse hover near a grave shows its name (graveNear).
  - A tap (pointerup with no movement) selects the nearest agent (radius max(24, 0.7*cam.s)), otherwise an animal, otherwise a grave, otherwise clears the selection (tap at 537).
- **Wheel** zooms by exp(-deltaY*0.0015) (535). **Double-click** zooms 2x (536).
- **Topbar buttons:**
  - #play: POST api/control {paused: !paused} (1018).
  - #speed cycles 1, 2, 4, 8, back to 1 via POST api/control {speed} (1019). The server also accepts 16 (server.ts:163).
  - #open-chronicle toggles the sheet. #fit calls fit() (1020).
- **Panel:**
  - The Ledger, Chronicle, Discoveries and Groups tabs, and #close.
  - Dock cards select an agent. The focus card has Ledger and close buttons. The ledger has a Follow toggle.
  - Chronicle filter chips. Clicking a chronicle entry jumps the camera there (jumpTo at 698, cam.s >= 28). "Load older entries" loads more.
  - Links go to history.html, debug.html and api/groups.
- **Keyboard:** none in app.js. Only debug.js:496 handles Enter/Space on table rows.
- **Calls that change the world:** only POST /api/control. It is global: it pauses or speeds up the world for every watcher and isn't persisted. Opening GET /api/stream at all also starts the world ticking (and billing Jev).
- **Read-only fetches the client makes:** api/people, api/agent/:id (polled every 1.5 s while the ledger is open), api/events?agent=&before=, api/knowledge (every 3 s on the Discoveries tab), api/groups (every 3 s on the Groups tab).

## 2. Server, ticking, brain, env vars, running an offline copy

- **Loop** (server.ts:54-75):
  - `if (clients.size && !control.paused) { tick(w); ...send tick... ; if (w.t % 50 === 0) save(); } setTimeout(loop, BASE_MS / control.speed)` with BASE_MS=500.
  - So at 1x the world does 2 ticks/s. One in-game day is 288 ticks (5 in-game minutes each), which is 144 s of real time at 1x.
  - tick() is synchronous. Jev calls are async, so ticks never wait on the network.
- **Control:** control={paused:false, speed:1} lives in memory and resets on restart.
- **Saving:** save() runs every 50 ticks and on SIGINT/SIGTERM. It writes world.json.tmp and then renames it. It trims events to the last 50k.
- **Startup:** load() restores world.json if its version === VERSION and resets thinking, engaged and social progress. Otherwise it backs up the old save and calls newWorld(Math.floor(Math.random()*1e9)).
- **Env vars:**
  - PORT (default 8095, server.ts:11).
  - NOMADS_DATA (default <repo>/data; holds world.json and logs/ with trace.jsonl and jev.jsonl; server.ts:13,17).
  - NOMADS_BRAIN: `random` means no Jev.
  - TYPESAFE_API_KEY is required unless NOMADS_BRAIN=random (server.ts:16 throws).
  - NOMADS_URL is used only by scripts/inspect.ts.
  - The server binds 127.0.0.1 with idleTimeout 0 (server.ts:108-110).
- **Brain:** brain.ts ask(). With NOMADS_BRAIN=random, randomAnswer() leans toward urgent needs (needBias) and makes no network calls. Otherwise it POSTs to ENDPOINT https://api.typesafe.ai/v1/systemone with model jev-latest and a 20 s timeout, and counts w.jev.calls and tokens.
- **Safe offline copy** (from the napkin, matches the code):
  - Run in /root/repos/nomads-island: `PORT=8196 NOMADS_DATA=/tmp/nomads-iso NOMADS_BRAIN=random bun server.ts`.
  - Always set PORT: the default 8095 would collide with the live server.
  - Always set NOMADS_BRAIN=random: if TYPESAFE_API_KEY is in the environment and the brain is left unset, it bills Jev.
  - node_modules (package `math` 0.1.0) is already installed in the worktree.
  - Headless, no server: `NOMADS_BRAIN=random bun scripts/run.ts --ticks 20000 --seed 7`.

## 3. Protocol

The transport is SSE: GET /api/stream with `text/event-stream`. Each message is `data: <json>\n\n`. The client uses relative URLs ("api/stream"), so it works under a path prefix.

### init (server.ts:120-126), sent once per connection
```
{ type:"init", t:number, jev:{calls,tokens,rulings}, control:{paused:boolean,speed:1|2|4|8|16},
  tiles:string,            // W*H chars '0'..'3' = Tile Grass/Forest/Water/Rock, row-major i=y*64+x
  heights:number[],        // (W+1)*(H+1)=4225 corner heights in tile widths (150 m) above waterline, 2 dp; water tiles flat at surface
  terrain:Terrain,         // see section 4
  things:Thing[],          // every thing
  agents:AgentSummary[], animals:AnimalView[], events:Event[] /* last 300 */,
  kinds:Registry, weather:Weather,
  paths:string,            // W*H chars '0'..'9' walking wear
  ice:string,              // W*H chars '0'|'1' frozen
  groups:CampSummary[] }
```
The client hardcodes S.W=64 and computes S.H = tiles.length/64 (app.js:1095). The world seed is not sent. It's only available from /api/debug/state, which returns the whole World.

### tick (server.ts:59-67), sent after every tick
```
{ type:"tick", t, jev, weather:Weather /* every tick */,
  agents:AgentSummary[] /* full list every tick */, animals:AnimalView[] /* full list every tick */,
  events:Event[] /* new since last */,
  things:Thing[] /* full objects changed this tick */, removed:string[] /* thing ids */,
  kinds:Record<string,Kind> /* new or changed */,
  paths:{i:number,v:number}[],
  ice?:number[] /* list of frozen tile indices, only when changed (note: array, unlike init string) */,
  groups?:CampSummary[] /* only when changed */ }
```

### control
`{type:"control", control:{paused,speed}}` is broadcast to all clients on POST /api/control (server.ts:160-166).

### Wire shapes
- **AgentSummary** (sim.ts:1395-1403 plus life.ts:135):
  `{id,name,color,x:int,y:int,status:string,goal:string|null,goalText:string|null,target:string|null,needs:{food,energy,warmth,health,social} (0..100),thinking:bool,down:bool,sick:bool,wearing:string|null (kind name),holding:string|null (weapon name),age:number (years, 1dp),stage:"child"|"adult"|"elder",parents:string[],pregnant:bool}`
- **AnimalView** (server.ts:45): `{id,species:"deer"|"wolf",x:int,y:int,hp,maxHp,state}`. Possible states: wander, graze, flee, hunt, attack, eat, rest, trapped (ecology.ts:314-370).
- **Thing** (world.ts:26-35):
  - Core fields: `{id:"t<n>",kind:ThingKind,x:int,y:int, n?,owner?,hp?,maxHp?,burning?:0..1,contained?,stage?,item?:kindId,parts?:Record<kind,n>,shelter?:{tier:0-3,style,cover,insul,sturdy,flam},until?,born?,burnedBy?,store?:Stack[],name?,died?,cause?,caught?:species,progress?,inside?,scarred?,resin?,bark?,covered?,charcoal?,air?,heat?,shared?,given?}`.
  - ThingKind values: tree, stump, burnt_stump, bush, dead_bush, sapling, mushroom, herb, stick, stone, boulder, reeds, clay, fire, structure, item, ash, pit, trap, well, grave.
  - Structure styles are sticks, reeds, logs, planks, stone, brick, hide or clay. Tiers 0..3 are pile, lean-to, hut/tent, cabin/lodge (app.js TIER/TENT).
  - A fire ring is a tier-0 structure on the fire's tile.
  - Several things can share a tile. The client indexes them in byTile as `"x,y"` mapped to a Set.
- **Weather** (world.ts:41-44): `{season:"spring"|"summer"|"autumn"|"winter",dayOfYear,year,sky:"clear"|"cloudy"|"rain"|"storm",temp:°C,wind:{dx,dy} in -1..1,drought:bool,dryTicks}`.
- **Event** (world.ts:186): `{id,t,kind,who:string[],x,y,text,tag?}`. Lightning events carry x,y; the client flashes a bolt there.
- **CampSummary** (groups.ts:549-553): `{id,name,members:string[],leader:string|null,x,y,store?:thingId,homes:[x,y][]}`.
- **Kind** (materials.ts:9-29): `{id,name,base?,props:Partial<Record<Prop,0..1>>,parts?,made?:{by,t},verb?,...}`.

### REST endpoints (server.ts:131-176)
- **Read:** /api/agent/:id (agentDetail), /api/knowledge, /api/people, /api/history, /api/groups, /api/events?agent=&before=.
- **Write:** POST /api/control.
- **Debug:** /api/debug/{jev,trace,stats,laws,kinds,rulings,state}.
- **Static:** anything else is served from public/, with / mapped to index.html.

## 4. World data (src/sim/world.ts, src/terrain)

- **Constants and tiles:**
  - W=H=64 (world.ts:7-8). DAY=288 ticks of 5 in-game minutes. YEAR_DAYS=40. VERSION=7 (11).
  - Tile enum (14-19): Grass=0, Forest=1, Water=2, Rock=3. tileAt returns Water outside the map.
  - walkable is any non-water tile, or ice. Water covers both sea and lakes; sea(w) tells them apart. Only lakes freeze.
- **Scale:** one tile is 150 m (land.ts:33 TILE_M = CELL*R = 75*2). The generator grid is N=128 cells of 75 m (grid.ts:5-6), 2x2 cells per tile. The island is 9.6 km across.
- **Time:**
  - Start t = round(DAY*0.3) = 86, about 07:10. hour = (t%DAY)/DAY*24.
  - Server isNight is h<5 or h>=20 (427). Client nightAmount (app.js:34) is 1 from 21:00 to 04:00, with ramps over 19-21 and 04-06.
  - Season = floor(dayOfYear/10) (405), so each season lasts 10 days.
  - Weather rerolls the sky every 12 ticks. temp = BASE_TEMP[season] + 5*sin(hour) - 2 if cloudy or - 4 if raining (ecology.ts:22-60).
- **World type** (188-210):
  - `{version, seed, t, tiles:Tile[], heights:number[], terrain:Terrain, paths:number[0..9], things:Thing[], agents:Agent[], animals:Animal[], events:Event[], nextId, jev, kinds:Registry, ice:number[], people:Record<id,{id,name,color,alive,died?,cause?}>, laws, rulings, weather, camps:Camp[], incidents}`.
- **Terrain (the packed wire form)** (land.ts:12-21):
  - `{n:128, tile:150, ground:b64 Uint16 per cell ((elev m+100)*10), water:b64 Uint8 per cell (depth*4, capped at 255), cover:{tree,shrub,grass,marsh,bare,sand,moist: b64 Uint8 per TILE 64x64, 0..255}, rivers:[x,y,q m³/s][][] in tile units source to mouth, wind:[dx,dy], rain:mm/yr}`.
  - art.js readTerrain (69) decodes it.
  - Cover is only sent per tile, not per cell. Exposure, snow, soil, silt, peat, temp, fog, salt, flow and table are not sent at all.
- **Island** (the full generator output, island.ts:93-100, 104): Float32Array[128*128] for height, water, flow, table, soil, silt, sand, peat, moist, tree, shrub, grass, marsh, bare, precip, snow, fog, temp, pet, exposure, salt and seasons, plus rivers (in cells), lakes and wind.
- **Starting things:**
  - stock() (land.ts:99): at most one thing per land tile (tree, stick, mushroom, herb, bush, reeds, clay, stone, boulder, ore as item), drawn from rng(seed^0x5f3759df).
  - The napkin says about 47% of tiles are sea. [INFERENCE] So the initial sim has only a few thousand things at most, far fewer than the demo's 211k trees.
- **Agent** (114-165): id (a lowercased name), name, color (COLORS at 290), x and y as integer tiles, bio, traits, desires, needs, skills, inv:Stack[], wearing, beliefs, facts, sickness, born, parents, children, pregnant, home (structure id), rel, memory, goal, plan:Step[], status, lastDecision, thinking, engaged, down (a tick; the agent is unconscious while down > t), and more.
- **Movement:** agents step one tile (8-neighbour BFS) per tick (sim.ts:157-192). Children step every other tick. A worn path (paths >= 5) gives a 40% chance of a second step.
- **Animals:** Animal (37-40) has integer x,y and species deer or wolf. Two herds of 4 deer and a pack of 3 wolves start the world.

## 5. The current client renderer

It is Canvas 2D only; there is no WebGL in public/.

- **Isometric projection** (art.js:250 isoView):
  - A tile is a 2*HW by 2*HH diamond with HW=26 and HH=13. One unit of height (a tile width) lifts ZH=26 px.
  - `at(u,v,h) = [OX + (u-v)*HW, OY + (u+v)*HH - h*ZH]`, with u = tile x and v = tile y. The orientation is fixed: +x goes screen down-right, +y goes down-left.
  - It limits lift so no slope rises toward the camera, clamping steps to at most 0.475 per corner. Drawing all terrain first and glyphs on top is only correct because of this (napkin guardrail 1).
  - z(u,v) interpolates over two triangles per tile.
- **Ground** (buildBase at 126):
  - Paints an 8 px/tile ImageData from domain-warped tile cover, signed water depth and hillshade from the 128-cell heights.
  - Upscales it to W*T px (T=36) and adds paper grain, rivers (chaikin-smoothed, width by discharge), marching-squares ink contours (forest edge, shoreline, 50/250 m height lines) and a vignette.
  - Also returns an ice overlay and `marks` (tufts, hatching, heather, reeds).
- **Layer cache** (app.js:98-172):
  - `ground` canvas = base + ice + paths.
  - `layer` canvas: drawTile affine-warps each tile's square of `ground` onto its two iso triangles, back to front via eachTile. Then drawSlab (the cut map edge), drawMarks, and every non-fire Thing sorted by u+v and drawn with drawThing (464).
  - Each glyph is jittered inside its tile by thingSpot's hash.
  - Deltas repaint only the affected rects: glyphRect for things, tileRect for paths and ice (paint at 134).
- **Frame loop** (app.js:210-238, requestAnimationFrame):
  1. Follow the selected agent (lerp 0.2).
  2. Clear to #1d1610.
  3. drawImage(layer) scaled by cam.s/T.
  4. tint(): winter, autumn, drought, sky and night washes, clipped to view.outline.
  5. drawCamps: a metaball outline of camp homes, dashed, with a name label.
  6. drawHot: fire glow in screen blend, drawFire, drawFlames, drawSmoke drifting with the wind.
  7. drawAnimals: procedural deer and wolf with facing and gait, or drawTrapped.
  8. drawAgents: drawToken wax seal, radius clamp(0.42*cam.s, 8, 20) (0.7x for children), a walking bob, zzz when down, a thought bubble when thinking, labels when cam.s >= 12, and a dashed line to the goal target.
  9. The grave label.
  10. drawWeather: rain, snow, and a lightning bolt plus screen flash. Skipped under prefers-reduced-motion.
- **Animation between ticks:** lerpPos (205) interpolates each agent and animal from its previous tile to its current tile over tickMs = 500/speed.
- **Camera** (`cam = {x,y,s}` at app.js:18):
  - x,y are a point on the layer in units of T px. s is screen px per T.
  - toScreen(u,v,z) = (toPlane - cam)*s + center. clampCam (458) bounds s between 0.7*fit and 90, and keeps the view on the layer.
  - fit() (481). Selecting someone sets cam.s to at least 24 and turns follow on. The HUD and sheet count as margins.
- **Startup:** it waits for the IM Fell English font before buildLayer, then adds `body.ready`.

## 6. Is the terrain generator the same?

Yes, the island itself is the same.
- Server: newWorld (world.ts:322-324) runs `lay(generateIsland(rng(seed)))`.
- Demo: demo/island.ts re-exports generateIsland from src/terrain/island, CELL and N from src/terrain/grid, and rng, COLORS and NAMES from src/sim/world. scripts/demo.ts bundles it to <out>/island.js.
- demo/styles/world.js:29-30 runs `grow(seed)`, which calls `generateIsland(rng(seed))`, the same call as the server.
- src/terrain uses no Math.random, so for a given seed the Island fields match the server's.

Differences to design around:
1. **Seed:** the live world's seed is random (server.ts load) and isn't in init; only /api/debug/state has it. isopixel reads ?seed= and defaults to 1.
2. **Flora and camp are decorative:**
   - grow() builds its own fine 509x509 grid at 18.75 m (K=4, START = 37.5-4800 = -4762.5 m is cell 0's center), with bicubic heights plus swell and river carving.
   - Its trees, shrubs, rocks, grass and camp (tents, people, woodpile, fire, from, uphill) come from rng(seed^0x51f15e) and are unrelated to the sim's Things, which come from stock(), at most one per tile.
   - The sim cuts trees to stumps, burns them, builds structures and so on, so a renderer has to show sim Things and not just the decorative flora.
3. **Coordinate mapping:** sim tile (tx,ty) covers world.js meters x in [-4800+150*tx, -4800+150*(tx+1)] and z the same for ty. The tile center is (-4725+150*tx, -4725+150*ty). Sim y maps to world.js z. Sim heights[] times 150 gives meters, roughly matching world.js heightAt (which adds swell and river carving).
4. **Fields the renderer needs:**
   - isopixel reads w.isle.height, exposure, snow, bare and wind; w.heightAt, fine, bilinear, cover, wet, moist, river, sky, dry, riverAt; w.rivers; w.trees, shrubs, rocks; w.camp.{at,from,fire,tents,people,woodpile}; w.nearby; w.START, CELL, N, SIZE, STEP. pal.js imports COLORS from ../island.js, which is the same agent palette as the sim.
   - The server's packed Terrain lacks per-cell cover, exposure and snow. So either regrow the Island in the client from the seed, or extend what init sends.
   - [INFERENCE] Risk: Bun runs JavaScriptCore and Chrome runs V8. Their transcendental Math functions can differ in the last bit, which could flip generator thresholds (lakes, river channels, tile class) between the server's tiles and a client regrow. Check tiles and heights against the server's init, or ship the fields from the server.
5. **isopixel renders one static frame** (main.js:1861-1918): no loop and no pan or zoom. View and frame come from the query string.
   - The camera azimuth is data-driven (V.T.from rotates eu/ev), unlike art.js's fixed orientation.
   - Scale: tileM (meters per iso tile) is 18 in valley view and 4 in camp view; island view searches 400 down to 60. So one sim tile (150 m) is about 8 valley iso tiles or 37 camp iso tiles.

## 7. DESIGN.md on player experience, camera, art, renderer

There is almost nothing on camera, art direction or a future renderer.
- Relevant lines: line 14 (an optional LLM chronicle "for the player to read"); line 184 ("Over time the map records where people live": paths, pits, clearings); line 204 (Watchability: laws, named compounds, destructive fires, crashes and first illnesses are major chronicle events); line 265 (Groups UI, including "a faint ink outline of each camp's area on the map"); lines 327-336 (debug and history pages, trace and Jev logs).
- Art direction lives elsewhere:
  - The art.js header: "inked atlas", watercolor on parchment, sepia linework.
  - index.html fonts: IM Fell English, Alegreya Sans.
  - The napkin guardrails. Vary the representation, not just the palette. Stepped or blocky terrain gets rejected: use per-vertex slope lighting, cliffs only on sea headlands, smoothed rock tones, and outcrops merged at far zooms. Cull and use LOD for the 211k, 49k and 59k tree, shrub and rock instances. Headless WebGL is slow.

## Integration facts worth keeping
- Agents and animals are on integer tiles and move at most about one tile per tick. Smooth motion is interpolated on the client.
- Things are integer-tile too, and several can share a tile.
- Every tick carries the full agent and animal lists, so there's no need to diff them.
- Fires and burning things are drawn live every frame (S.hot), not cached in the layer.
- The world advances only while an SSE client is attached, so a dev renderer must point at an offline copy (PORT=8196 NOMADS_DATA=/tmp/... NOMADS_BRAIN=random).
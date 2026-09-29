# Nomads research: terrain, art direction and the playable prototype

Everything researched and decided while building the island generator, choosing an art style and putting it on the live sim. Branch history: island-gen (generator), island-3d (styles and play page).

## Contents
- `generator/`: the physically based island generator write-up (uplift, stream-power erosion, climate, water, soils, cover) with its layer images. Code: src/terrain.
- `artbook/index.html`: the art direction process for "Expedition Morning": brief, reference board, pillars, palette and density exploration, value checks, style guide, critique rounds, finals and loops.
- `briefs/artbook.md`: art direction brief, references and pillars.
- `briefs/styles-brief.md`: the shared brief for the round of from-scratch style mocks (demo/styles/*).
- `briefs/play-brief.md`: contracts for running the sim in the browser under the isopixel renderer.
- `briefs/gamemap.md` and `briefs/isomap.md`: maps of the game (sim, wire shapes, client) and of the isopixel renderer.

## Timeline and decisions
1. Generator: realistic erosion island, then gentled to 250 to 450 m peaks. Unchanged since island-gen.
2. Style search: several rounds of mocks; recolor-only rounds were rejected, so each style changed its representation. The operator picked isometric pixel art (F).
3. Art direction: industry process (brief, references, pillars, exploration grid, grayscale and squint checks, style guide, paintover critiques). Direction: Transport Tycoon clarity, turquoise shallows, low morning sun, a landmark in every view, small SimCity people, no UI.
4. Play page (demo/styles/play): the real sim runs in the browser with the random brain (no server, no Jev cost). Renderer bakes world-anchored chunks in workers, composes live objects at 60 fps, smooth zoom over nine levels, eight-bearing orbit, day and night palette.
5. Real objects: every tree, rock, plant and animal (about 850k things, 500 animals) is a sim object with continuous positions and inspect data; walking is about 2 m per tick.
6. Fidelity: vertical exaggeration from the true slope distribution (1.5; 3.2 made needles); one shared groundClass and waterAt for sim, renderer and inspector; continuous camera with a torture test; memory bounded near 1.3 GB.
7. Look: ground painted from the generator's continuous fields; terrain light owns value with cast shadows, so the landform reads through forests.

## Checks
scripts/play/torture.cjs (camera), consistency.cjs (same world at every zoom), soak.cjs (memory). Lessons live in .claude/napkin.md.

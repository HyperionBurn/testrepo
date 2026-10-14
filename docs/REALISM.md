# Realism pass — "make it feel like New York at night"

Reference photos (study only, NOT shipped; CC BY, Wikimedia Commons):
- `/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/nyc/ref1.jpg` — Midtown at dusk from a rooftop (blue hour).
- `/tmp/claude-0/-home-user-testrepo/626de28a-f1aa-5694-9a01-7b42b28fe62a/scratchpad/nyc/ref2.jpg` — aerial of Manhattan at night from the Empire State.
More references: Wikimedia Commons API, e.g.
`curl -A "Mozilla/5.0 skyline-research" 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=filetype:bitmap%20Times%20Square%20night&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url&iiurlwidth=1280'`
(if it returns empty/HTML, wait 30 s and retry — rate limits). LOOK at references with your Read tool before you start and again to compare against your screenshots.

## What makes the references feel alive (and what our v2 city lacks)
1. **Density** — buildings packed edge to edge, avenues are narrow canyons; mid-rise fill everywhere; a FEW supertall spires; heights come in clusters. Roofs are cluttered: water tanks on stilts, AC units, parapets, antennas, setbacks (wedding-cake tiers), lit crowns.
2. **Colour comes from LIGHT not paint** — facades are dark neutral (brown brick, grey concrete, black/blue glass, limestone). Windows are warm yellow-orange (2400–3200 K) with some cool white and a few TV-blue; ~35–55 % lit in an irregular pattern, floors lit in runs; occasional fully lit floors. NO pastel teal/olive/blue toy colours by default.
3. **Streets are the brightest lines from above** — rivers of sodium-orange light, red/white car streaks, intersections glowing, wet-asphalt reflections, crosswalk stripes, traffic signals cycling, steam from manholes/rooftops lit orange.
4. **The city continues to the horizon** — never a black void: more blocks/lights to the horizon, a river with long vertical light reflections, bridges with lit cables, a carpet of far lights, orange light-pollution haze on the horizon line.
5. **Sky/atmosphere** — blue hour: deep navy zenith to teal to orange/pink horizon band; haze layers lit by the city; bloom/halation around lights; soft depth fog tinted warm near the ground; a few aircraft strobes, helicopters, red aviation beacons on spires.
6. **Life** — cars with white headlights/red tail-lights/yellow cabs, buses, pedestrians as glimmers on sidewalks, LED billboards and neon (Times-Square hotspot) — in Skyline these billboards show LIVE agent activity (agent name, file, $ cost).

## Rules
- Realism is the DEFAULT look ("natural" colour mode). The existing colour modes (area/language/churn/age) become tints on top of the natural look (windows/crowns/plaza glow shift, facade tint amount ≤ 35 %) so the data still reads.
- Keep the Kenney models as an optional "Stylized" building style (store `buildingStyle: 'real' | 'stylized'`, key B toggles) — but default `real`.
- All instanced; budgets: ≤ 150 draw calls, ≤ 4 M triangles for a 20 k-file repo; windows are shader work not geometry.
- Reduced motion → static light only (no traffic/steam/helicopters).
- Compare your screenshots against the reference photos and iterate until they could sit next to them. Be self-critical: if it looks like a toy, it isn't done.

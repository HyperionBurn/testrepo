# Credits

## Photographic kit buildings (CC BY 4.0)

The photographic city kit (`src/renderer/src/city/kit/`) is built from **Low-poly City Buildings** by **smooth998**, licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/).

- Title: Low-poly City Buildings
- Author: smooth998 (https://sketchfab.com/smooth998)
- Source: https://sketchfab.com/3d-models/low-poly-city-buildings-e0209ac5bb684d2d85e5ade96c92d2ff
- Changes: the GLB is unchanged. The facade atlas, ground photo and night-window maps are derived from its textures (see `scripts/kit/build_night.py`). Building styles and tiers are classified in `scripts/kit/inspect_kit.mjs`. Licence note: `src/renderer/src/city/kit/models/LICENSE.txt`.

## Kenney models (CC0)

Skyline's city models and textures come from Kenney's City Kit packs, released under **CC0 1.0 Universal** (public domain dedication). Attribution is not required; we give it anyway.

- Website: https://kenney.nl
- Licence: https://creativecommons.org/publicdomain/zero/1.0/

| Pack | Version | Used for | Source |
|---|---|---|---|
| City Kit Commercial | 2.1 | towers, skyscrapers, low-rise and low-detail buildings, awnings and parasols | https://kenney.nl/assets/city-kit-commercial |
| City Kit Roads | 2.2 | road tiles, street lights, power poles, road signs, construction props, dumpster | https://kenney.nl/assets/city-kit-roads |
| City Kit Suburban | 2.0 | houses (`building-type-*`) | https://kenney.nl/assets/city-kit-suburban |

Files copied into `src/renderer/src/city/assets/` are the GLB exports from these packs. Their colormap atlases are stacked into `textures/colormap.png`, and the UVs are remapped to match (see `scripts/import-kenney.mjs`). The original `License.txt` of each pack follows.

## City Kit Commercial (2.1)

```text
    City Kit Commercial (2.1)

    Created/distributed by Kenney (www.kenney.nl)
    Creation date: 21-07-2025 18:16

            ------------------------------

    License: (Creative Commons Zero, CC0)
    http://creativecommons.org/publicdomain/zero/1.0/

    You can use this content for personal, educational, and commercial purposes.

    Support by crediting 'Kenney' or 'www.kenney.nl' (this is not a requirement)

            ------------------------------

    • Website : www.kenney.nl
    • Donate  : www.kenney.nl/donate

    • Patreon : patreon.com/kenney

    Follow on social media for updates:

    • Twitter:     twitter.com/KenneyNL
    • BlueSky:     kenney.bsky.social
    • Instagram: instagram.com/kenney_nl```

## City Kit Roads (2.2)

```text
    City Kit Roads (2.2)

    Created/distributed by Kenney (www.kenney.nl)
    Creation date: 10-10-2026 12:35

            ------------------------------

    License: (Creative Commons Zero, CC0)
    http://creativecommons.org/publicdomain/zero/1.0/

    You can use this content for personal, educational, and commercial purposes.

    Support by crediting 'Kenney' or 'www.kenney.nl' (this is not a requirement)

            ------------------------------

    • Website : www.kenney.nl
    • Donate  : www.kenney.nl/donate

    • Patreon : patreon.com/kenney

    Follow on social media for updates:

    • Twitter:     twitter.com/KenneyNL
    • BlueSky:     kenney.bsky.social
    • Instagram: instagram.com/kenney_nl```

## City Kit Suburban (2.0)

```text
    City Kit Suburban (2.0)

    Created/distributed by Kenney (www.kenney.nl)
    Creation date: 23-04-2025 20:22

            ------------------------------

    License: (Creative Commons Zero, CC0)
    http://creativecommons.org/publicdomain/zero/1.0/

    You can use this content for personal, educational, and commercial purposes.

    Support by crediting 'Kenney' or 'www.kenney.nl' (this is not a requirement)

            ------------------------------

    • Website : www.kenney.nl
    • Donate  : www.kenney.nl/donate

    • Patreon : patreon.com/kenney

    Follow on social media for updates:

    • Twitter:     twitter.com/KenneyNL
    • BlueSky:     kenney.bsky.social
    • Instagram: instagram.com/kenney_nl```


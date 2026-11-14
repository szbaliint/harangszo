`bell.svg` is the source of every app icon: a church bell (crown, waisted body, flared lip, clapper) in white on ink
`#111111`, the map's own two colours; no red, since red means "the next one" in the app. Full-bleed, and every drawn
point lies within the maskable safe zone (at most 185 px from the centre of 512, the limit is 204.8).
The PNGs (192, 512, maskable 512, Apple touch 180) are rendered from it: `node icons/render.mjs` (uses the global Playwright).
Change the SVG, re-run the script, commit the SVG and the PNGs together.

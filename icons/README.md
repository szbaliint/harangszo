`bell.svg` is the source of every app icon: an original bell, gold `#c9971c` on `#233f8c`, full-bleed, inside the maskable safe zone.
The PNGs (192, 512, maskable 512, Apple touch 180) are rendered from it: `node icons/render.mjs` (uses the global Playwright).
Change the SVG, re-run the script, commit the SVG and the PNGs together.

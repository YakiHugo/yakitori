# Yakitori app icon

`original-b.png` is the approved original-B 1024px crop: oversized cobalt Y on
pale gray. It is the exact source artwork, including transparency; do not redraw,
recolor or recrop it when regenerating packaging assets.

Source SHA-256: `1d77fa3e83a4def188d247d57e30bb1570380e5776a2dc9b8ca2ff5f47098571`.

Run `pnpm icons:generate` using the locked dependencies to regenerate the macOS
ICNS and browser favicon. `pnpm icons:check` checks that the committed outputs
match. The master is embedded unchanged at 1024px; smaller representations use
the existing Sharp dependency with Lanczos3 resampling. No generated design or
new image-processing dependency is required.

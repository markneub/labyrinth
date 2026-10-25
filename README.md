# Labyrinth

A classic wooden tilt-maze in the browser, built with
[three.js](https://threejs.org/). Tilt your phone to roll a steel ball along
the line from **START** to **FINISH** without dropping it into the numbered
holes. The board tilts inside its box on a gimbal, like the real toy.

## Play

- **Phone:** tilt to roll. Whatever angle you hold the phone at when you tap
  Play counts as level; tap the target button to re-level at any time.
  iOS asks for motion permission on the first tap. Phones only give motion
  sensors to pages served over HTTPS, so play the GitHub Pages build.
- **Desktop / no sensor:** arrow keys or WASD, or drag on the board.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173 (desktop browsers treat localhost as secure)
npm run build      # static site in dist/
```

To try tilt controls on a phone against the dev server, it needs HTTPS (for
example `npx vite --host` behind a tunnel), or just push and use the Pages build.

## Deploy

`.github/workflows/pages.yml` builds every push and publishes the default
branch to GitHub Pages. In the repository settings, set **Pages → Source** to
**GitHub Actions** once. `base: './'` in `vite.config.js` keeps asset paths
relative, so the site works from the `/labyrinth/` sub-path.

## Textures

The wood is CC0 from [Poly Haven](https://polyhaven.com), fetched by
`npm run textures` (`tools/fetch_textures.py`, needs Pillow) into
`public/textures/` and committed:

- Board: [white_maple_veneer](https://polyhaven.com/a/white_maple_veneer)
- Blocks, rim, frame and box: [oak_veneer_02](https://polyhaven.com/a/oak_veneer_02)

If they fail to load, the game falls back to procedural wood.

## How it works

| File | Purpose |
| --- | --- |
| `src/maze.js` | Seeded board generation per level: a winding route (deepest branch of a random maze on a coarse grid), with blocks and numbered holes placed around it |
| `src/main.js` | Scene (box, gimbal frame, board, knobs), ball physics (rolling acceleration, block collisions, hole lips), game state, and HUD |
| `src/input.js` | Device orientation → gravity vector → calibrated tilt, with drag and keyboard fallbacks |
| `src/textures.js` | Texture loading, procedural fallback wood, and the printed board markings |
| `src/audio.js` | Synthesized rolling, click, fall, and win sounds |

Later levels get bigger, swap corner stops for holes, and crowd the holes
closer to the line. Progress and best times are saved in `localStorage`.

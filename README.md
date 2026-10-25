# Marble Machine (branch `marble-machine`)

A wooden marble machine in three.js that runs by itself, with twelve glass
marbles. Drag to orbit, pinch to zoom; the button by the sound toggle switches
between real speed and ½× or ¼× slow motion (it starts at ½×).

A paddle-chain lift carries marbles to the top run, which hangs from a beam.
Four flip-flop switches then send them round six routes in turn, like a
binary counter:

- **F1** splits the top run into twin concentric spirals wound round one tower
  (one and a half turns outside, two and a half inside).
- **F2**, at the outer spiral's foot: a steep drop into a **loop-the-loop** and
  a kicker that jumps the marble into the **big funnel**, whose spout drops it
  down a six-level **drop stack** of short ramps with wooden end blocks; or
  **hills** that cross over the loop route and jump into the **funnel
  cascade**, three bowls across the front, each spout throwing marbles on into
  the next.
- **F3**, at the inner spiral's foot: the **chime stack**, eight switchback
  ramps whose end bars are tuned, so each marble plays a falling scale; or a
  two-lap **stadium helix** that jumps into the cascade's middle bowl.
- **F4**, under the last bowl: straight out to the **front collector**, or the
  long way round over a run of **waves**.

Everything merges into the collectors and back run to the lift.

Everything moves by ordinary physics in SI units (a 16 mm glass marble on
wooden dowel rails: gravity along the track, rolling on two rails, rolling
resistance and drag; free flight; rolling freely over the funnel's surface;
marbles bumping into each other). The layout is built by test-rolling a marble
through it, so jumps land in their funnel, drops land on their ramp, every
curve is banked for the speed the marble really has there, and nowhere would
the rails have to pull the marble to keep it on (over a hill's crest, round the
loop's top). Tracks are laid with a turtle (`Turtle` in `path.js`: straights,
turns, spirals, hills, loops, racetrack helices), so pieces always join smoothly.

Checks: `node tools/check_machine.mjs [seconds]` checks track clearances and
supports and runs the machine headless (10 minutes with 12 marbles: ~335 laps,
none lost or stuck); `node tools/plot_machine.mjs out.svg` draws the tracks
from above and the front. `?view=x,y,z,tx,ty,tz` starts the camera at a given
spot; the corner shows the frame rate.

Code: `src/machine/` (`path.js` curves and the turtle, `physics.js`,
`layout.js` the machine's design, `sim.js` the running machine, `supports.js`,
`scene.js` meshes (static wood merged into a few dozen draw calls), `sound.js`,
`main.js`). Woods are CC0 from Poly Haven: maple rails, oak ties and blocks,
walnut posts, bowl and gears, teak base.

---

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

Every push, to any branch, rebuilds and publishes the whole site
(`.github/workflows/pages.yml` runs `tools/build_site.sh`):

- the default branch at https://markneub.github.io/labyrinth/
- every other branch at `/labyrinth/<branch>/`, with slashes turned into
  dashes (`marbles/glass` → `/labyrinth/marbles-glass/`)
- a list of them all at https://markneub.github.io/labyrinth/branches/

Branch builds show their name on the start screen and keep their own saved
progress and best times. Deleting a branch drops it at the next deploy.
`base: './'` in `vite.config.js` keeps asset paths relative, so a build works
from any of these paths.

One-time repository settings: **Pages → Source** set to **GitHub Actions**,
and **Environments → github-pages → Deployment branches** allowing all
branches.

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

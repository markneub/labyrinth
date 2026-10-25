# Labyrinth

A wooden tilt-maze in the browser, built with [three.js](https://threejs.org/).
Tilt your phone to roll a steel ball from **START** to **FINISH** without
dropping it into the holes.

## Play

The game is a static site with no build step. Serve the folder over **HTTPS**
(phones only give motion-sensor access to secure pages), e.g. with GitHub Pages,
then open it on your phone and tap **Play**.

- **Phone:** tilt to roll. Whatever angle you hold the phone at when you tap
  Play counts as level; tap the target button to re-level at any time.
  iOS asks for motion permission on the first tap.
- **Desktop / no sensor:** arrow keys or WASD, or drag on the board.

Locally: `python3 -m http.server`, then open http://localhost:8000. Desktop
browsers treat `localhost` as secure, but a phone on your LAN needs HTTPS.

## How it works

| File | Purpose |
| --- | --- |
| `js/maze.js` | Seeded maze generation per level (recursive backtracker, extra loops on later levels), shortest-path guide line, and hole placement |
| `js/main.js` | Scene, board and wall meshes, ball physics (rolling acceleration, wall collisions, hole lips), game state, and HUD |
| `js/input.js` | Device orientation → gravity vector → calibrated tilt, with drag and keyboard fallbacks |
| `js/textures.js` | Procedural wood grain and the printed board markings |
| `js/audio.js` | Synthesized rolling, click, fall, and win sounds |

Levels get bigger and gain more holes as you progress. Progress and best times
are saved in `localStorage`.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { R, RAIL_R, GAUGE, RIDE } from './physics.js';
import { chainPoint } from './sim.js';
import { POST_R, TIE_DROP } from './supports.js';

// Meshes for the machine. Woods: maple rails and ties, oak paddles, blocks
// and arms, walnut posts, bowls and gears, a teak base.

const UP = new THREE.Vector3(0, 1, 0);

/** Texture set -> a material factory whose grain runs along a part `length` metres long. */
export function woodFactory(set, { tile = 0.25, tint = 1, rough = 1 } = {}) {
  const cache = new Map();
  return (length = tile, across = tile) => {
    const key = `${length.toFixed(3)}:${across.toFixed(3)}`;
    if (cache.has(key)) return cache.get(key);
    const fit = (t) => {
      const c = t.clone();
      c.repeat.set(Math.max(0.05, length / tile), Math.max(0.05, across / tile));
      c.needsUpdate = true;
      return c;
    };
    const m = new THREE.MeshStandardMaterial({
      map: fit(set.albedo),
      normalMap: fit(set.normal),
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: fit(set.rough),
      roughness: rough,
      color: new THREE.Color(tint, tint, tint),
    });
    cache.set(key, m);
    return m;
  };
}

/** A curve through a list of points (straight between them). */
class PolyCurve extends THREE.Curve {
  constructor(points) {
    super();
    this.points = points;
  }
  getPoint(t, out = new THREE.Vector3()) {
    const f = t * (this.points.length - 1), i = Math.min(this.points.length - 2, Math.floor(f));
    return out.lerpVectors(this.points[i], this.points[i + 1], f - i);
  }
}

const basisMatrix = (x, y, z, pos) => new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);

/** A dowel between two points. */
function dowel(a, b, radius, material, segments = 8) {
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, segments), material);
  mesh.position.lerpVectors(a, b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmp.subVectors(b, a).normalize());
  return mesh;
}
const tmp = new THREE.Vector3();

/** A gear outline with n teeth, extruded `thick` deep (along z). */
function gearGeometry(radius, teeth, thick, hole = radius * 0.2) {
  const shape = new THREE.Shape();
  const depth = Math.min(0.006, radius * 0.2);
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2, w = Math.PI / teeth;
    const pts = [[a - w * 0.5, radius - depth], [a - w * 0.25, radius], [a + w * 0.25, radius], [a + w * 0.5, radius - depth]];
    pts.forEach(([ang, r], j) => {
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (i === 0 && j === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const h = new THREE.Path();
  h.absarc(0, 0, hole, 0, Math.PI * 2, true);
  shape.holes.push(h);
  // Spokes: cut-outs between hub and rim.
  if (radius > 0.03) {
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * Math.PI * 2 + 0.22, a1 = ((i + 1) / 5) * Math.PI * 2 - 0.22;
      const r0 = hole + 0.008, r1 = radius - depth - 0.008;
      const c = new THREE.Path();
      c.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0);
      c.absarc(0, 0, r1, a0, a1, false);
      c.lineTo(Math.cos(a1) * r0, Math.sin(a1) * r0);
      c.absarc(0, 0, r0, a1, a0, true);
      shape.holes.push(c);
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -thick / 2);
  return g;
}

/** A swirled glass marble texture. */
function marbleTexture(hue) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 45%, 78%)`;
  ctx.fillRect(0, 0, 256, 128);
  for (let k = 0; k < 4; k++) {
    ctx.strokeStyle = `hsla(${(hue + k * 25) % 360}, 85%, ${34 + k * 6}%, 0.95)`;
    ctx.lineWidth = 10 - k * 1.5;
    ctx.beginPath();
    for (let x = 0; x <= 256; x += 4) {
      const y = 64 + Math.sin((x / 256) * Math.PI * 4 + k * 1.7) * (30 - k * 5);
      if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildMeshes(layout, supports, maps, anisotropy) {
  const group = new THREE.Group();
  const shadow = (m) => { m.castShadow = m.receiveShadow = true; return m; };
  const maple = woodFactory(maps.board, { tile: 0.3 });
  const oak = woodFactory(maps.wood, { tile: 0.25 });
  const walnut = woodFactory(maps.walnut, { tile: 0.3 });
  const teak = woodFactory(maps.teak, { tile: 0.6 });
  for (const set of Object.values(maps)) for (const t of Object.values(set)) t.anisotropy = anisotropy;

  // ---- Base ----
  const base = shadow(new THREE.Mesh(new RoundedBoxGeometry(1.24, 0.03, 0.84, 3, 0.008), teak(1.24, 0.84)));
  base.position.set(0, -0.015, 0);
  group.add(base);

  // ---- Rails, ties and end blocks ----
  const frame = { t: new THREE.Vector3(), l: new THREE.Vector3(), u: new THREE.Vector3() };
  const ties = [];
  const blocks = [];
  const chimeBars = [];
  for (const track of layout.tracks) {
    const { path } = track;
    const left = [], right = [];
    for (let s = 0; s <= path.length + 1e-6; s += 0.008) {
      const p = path.at(Math.min(s, path.length));
      path.frame(Math.min(s, path.length), frame);
      const c = p.clone().addScaledVector(frame.u, -RIDE);
      left.push(c.clone().addScaledVector(frame.l, GAUGE / 2));
      right.push(c.clone().addScaledVector(frame.l, -GAUGE / 2));
    }
    for (const pts of [left, right]) {
      const geo = new THREE.TubeGeometry(new PolyCurve(pts), pts.length, RAIL_R, 6, false);
      group.add(shadow(new THREE.Mesh(geo, maple(path.length, 0.02))));
    }
    for (let s = 0.012; s < path.length; s += 0.028) {
      const p = path.at(s);
      path.frame(s, frame);
      const pos = p.addScaledVector(frame.u, -(RIDE + RAIL_R + 0.0012));
      ties.push(basisMatrix(frame.l, frame.u, frame.t, pos));
    }
    if (track.backstop) {
      path.frame(0, frame);
      const pos = path.at(0).addScaledVector(frame.t, -(R + 0.004)).addScaledVector(frame.u, 0.001);
      blocks.push(basisMatrix(frame.l, frame.u, frame.t, pos));
    }
    if (track.end.wall) {
      path.frame(path.length, frame);
      if (track.end.chime !== undefined) {
        // A tuned brass bar across the end, at the height the marble strikes it.
        const pos = path.at(path.length).addScaledVector(frame.t, R + 0.0045);
        chimeBars.push({ m: basisMatrix(frame.u, frame.l, frame.t, pos), pos, l: frame.l.clone() });
      } else {
        const pos = path.at(path.length).addScaledVector(frame.t, R + 0.004).addScaledVector(frame.u, 0.003);
        blocks.push(basisMatrix(frame.l, frame.u, frame.t, pos));
      }
    }
  }
  // Chime bars hang between two little oak posts.
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.28 });
  for (const c of chimeBars) {
    const bar = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, GAUGE + 0.022, 16), brass));
    bar.applyMatrix4(c.m);
    group.add(bar);
    for (const side of [-1, 1]) {
      const end = c.pos.clone().addScaledVector(c.l, side * (GAUGE / 2 + 0.013));
      group.add(shadow(dowel(end.clone().setY(end.y - RIDE - 0.006), end.clone().setY(end.y + 0.008), 0.0022, oak(0.03, 0.01))));
    }
  }
  const tieMesh = shadow(new THREE.InstancedMesh(new THREE.BoxGeometry(GAUGE + 2 * RAIL_R + 0.005, 0.0028, 0.006), oak(0.03, 0.01), ties.length));
  ties.forEach((m, i) => tieMesh.setMatrixAt(i, m));
  group.add(tieMesh);
  const blockMesh = shadow(new THREE.InstancedMesh(new RoundedBoxGeometry(GAUGE + 2 * RAIL_R + 0.004, 0.016, 0.006, 2, 0.0015), oak(0.03, 0.03), blocks.length));
  blocks.forEach((m, i) => blockMesh.setMatrixAt(i, m));
  group.add(blockMesh);

  // ---- Supports ----
  const postMat = walnut(0.4, 0.03);
  const propMat = oak(0.4, 0.02);
  for (const p of supports.posts) {
    if (p.base) {
      // Ladder posts are structural walnut; plain props are slimmer oak.
      const ladder = !p.track;
      const mat = ladder ? postMat : propMat;
      group.add(shadow(dowel(p.base, p.top, ladder ? POST_R * 1.2 : POST_R * 0.8, mat)));
      // A small foot where it meets the base, and a cap on top.
      const foot = shadow(new THREE.Mesh(new THREE.CylinderGeometry(POST_R * 2.2, POST_R * 2.6, 0.006, 16), mat));
      foot.position.set(p.base.x, 0.003, p.base.z);
      group.add(foot);
    }
    if (p.arm) group.add(shadow(dowel(p.arm.from, p.arm.to, POST_R * 0.75, oak(0.05, 0.02))));
  }
  // The overhead beam and the hangers that carry the top run.
  const { beam } = supports;
  const beamLen = beam.from.distanceTo(beam.to);
  const beamMesh = shadow(new THREE.Mesh(new RoundedBoxGeometry(beamLen + 0.03, 0.014, 0.012, 2, 0.003), walnut(beamLen, 0.03)));
  beamMesh.position.lerpVectors(beam.from, beam.to, 0.5);
  group.add(beamMesh);
  const bracket = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.014, 0.014, Math.abs(layout.spiral.z - beam.to.z) + 0.012, 2, 0.003), walnut(0.1, 0.03)));
  bracket.position.set(beam.to.x, beam.to.y, (beam.to.z + layout.spiral.z) / 2);
  group.add(bracket);
  for (const h of supports.hangers) group.add(shadow(dowel(h.from, h.to, 0.0018, oak(0.05, 0.02))));
  // Central posts for the helices, each topped with a turned finial; the
  // tower's post rises to carry the beam.
  layout.helixPosts.forEach((h, i) => {
    const top = i === 0 ? Math.max(h.top, supports.beamY + 0.02) : h.top;
    group.add(shadow(dowel(new THREE.Vector3(h.x, 0, h.z), new THREE.Vector3(h.x, top, h.z), h.radius, walnut(0.6, 0.06), 24)));
    const finial = shadow(new THREE.Mesh(new THREE.SphereGeometry(h.radius * 1.45, 24, 16), walnut(0.05, 0.05)));
    finial.position.set(h.x, top + h.radius, h.z);
    group.add(finial);
  });
  for (const a of supports.arms) group.add(shadow(dowel(a.from, a.to, 0.003, oak(0.1, 0.02))));

  // ---- Funnel bowls ----
  for (const f of layout.funnels) {
    const profile = [];
    const holeY = f.surface(f.hole);
    const thick = 0.004;
    profile.push(new THREE.Vector2(f.hole + thick, holeY - 0.018));
    profile.push(new THREE.Vector2(f.hole, holeY - 0.018));
    for (let i = 0; i <= 40; i++) {
      const r = f.hole + ((f.radius - f.hole) * i) / 40;
      profile.push(new THREE.Vector2(r, f.surface(r)));
    }
    profile.push(new THREE.Vector2(f.radius + 0.002, f.rimY + 0.004));
    profile.push(new THREE.Vector2(f.radius + 0.007, f.rimY + 0.002));
    profile.push(new THREE.Vector2(f.radius + 0.008, f.rimY - 0.006));
    for (let i = 0; i <= 20; i++) {
      const r = f.radius + 0.006 - ((f.radius - f.hole) * i) / 20;
      profile.push(new THREE.Vector2(Math.max(f.hole + thick, r), f.surface(Math.max(f.hole, r - 0.004)) - 0.008 - i * 0.0004));
    }
    profile.push(new THREE.Vector2(f.hole + thick, holeY - 0.018));
    const bowl = shadow(new THREE.Mesh(new THREE.LatheGeometry(profile, 96), walnut(0.25, 0.1)));
    bowl.material = bowl.material.clone();
    bowl.material.side = THREE.DoubleSide;
    bowl.position.set(f.cx, 0, f.cz);
    group.add(bowl);
    if (f.wall) {
      const w = f.wall;
      const board = shadow(new THREE.Mesh(
        new THREE.CylinderGeometry(w.radius + 0.003, w.radius + 0.003, w.height, 48, 1, true, 0, w.span),
        oak(w.radius * w.span, w.height),
      ));
      board.material = board.material.clone();
      board.material.side = THREE.DoubleSide;
      // Cylinder angles θ start at +z and run towards +x (x = sin θ, z = cos θ),
      // so direction φ in the x-z plane is θ = π/2 − φ; centre the arc there.
      board.rotation.y = Math.PI / 2 - w.angle - w.span / 2;
      board.position.set(f.cx, f.rimY + w.height / 2 - 0.004, f.cz);
      group.add(board);
    }
    // Three legs, set away from the chute that leaves underneath.
    const out = f.exitTo.path.tangent(0.02).setY(0).normalize();
    const away = Math.atan2(out.z, out.x) + Math.PI;
    for (let k = 0; k < 3; k++) {
      const a = away + (k * 2 * Math.PI) / 3;
      // From the rim's lip, splayed outwards: clear of the corkscrew winding underneath.
      const top = new THREE.Vector3(f.cx + Math.cos(a) * (f.radius + 0.006), f.rimY - 0.006, f.cz + Math.sin(a) * (f.radius + 0.006));
      const foot = new THREE.Vector3(f.cx + Math.cos(a) * (f.radius + 0.03), 0, f.cz + Math.sin(a) * (f.radius + 0.03));
      group.add(shadow(dowel(foot, top, POST_R, postMat)));
    }
  }

  // ---- Lift tower ----
  const { lift } = layout;
  const liftGroup = new THREE.Group();
  group.add(liftGroup);
  const uprightH = lift.yTop + 0.05;
  for (const dz of [-0.026, 0.026]) {
    const up = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.03, uprightH, 0.01, 2, 0.002), walnut(uprightH, 0.03)));
    up.position.set(lift.x, uprightH / 2, lift.z + dz);
    liftGroup.add(up);
  }
  const capMat = walnut(0.1, 0.03);
  const cap = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.012, 0.07, 2, 0.003), capMat));
  cap.position.set(lift.x, uprightH + 0.006, lift.z);
  liftGroup.add(cap);
  const sprocketGeo = gearGeometry(lift.radius + 0.004, 14, 0.008, 0.004);
  const sprockets = [lift.yBottom, lift.yTop].map((y) => {
    const g = shadow(new THREE.Mesh(sprocketGeo, walnut(0.06, 0.06)));
    g.position.set(lift.x, y, lift.z);
    liftGroup.add(g);
    const axle = shadow(dowel(new THREE.Vector3(lift.x, y, lift.z - 0.032), new THREE.Vector3(lift.x, y, lift.z + 0.05), 0.0035, oak(0.08, 0.01)));
    liftGroup.add(axle);
    return g;
  });
  // Drive: a big gear with a crank, turning the bottom sprocket through a pinion.
  const pinionR = 0.014, bigR = 0.06;
  const pinion = shadow(new THREE.Mesh(gearGeometry(pinionR, 10, 0.007, 0.0035), walnut(0.03, 0.03)));
  pinion.position.set(lift.x, lift.yBottom, lift.z + 0.04);
  const big = shadow(new THREE.Mesh(gearGeometry(bigR, 40, 0.008, 0.005), walnut(0.12, 0.12)));
  big.position.set(lift.x + pinionR + bigR - 0.004, lift.yBottom + 0.0, lift.z + 0.04);
  big.position.y = Math.max(bigR + 0.008, lift.yBottom);
  const bigAxle = shadow(dowel(new THREE.Vector3(big.position.x, big.position.y, lift.z + 0.03), new THREE.Vector3(big.position.x, big.position.y, lift.z + 0.06), 0.004, oak(0.05, 0.01)));
  const crank = new THREE.Group();
  crank.position.copy(big.position).setZ(lift.z + 0.05);
  const crankArm = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.008, 0.045, 0.004, 2, 0.0015), oak(0.05, 0.01)));
  crankArm.position.y = 0.02;
  const handle = shadow(dowel(new THREE.Vector3(0, 0.04, 0), new THREE.Vector3(0, 0.04, 0.025), 0.004, walnut(0.03, 0.01)));
  crank.add(crankArm, handle);
  // Its own little stand.
  const stand = shadow(dowel(new THREE.Vector3(big.position.x, 0, lift.z + 0.03), new THREE.Vector3(big.position.x, big.position.y, lift.z + 0.03), 0.005, postMat));
  liftGroup.add(pinion, big, bigAxle, crank, stand);
  for (const o of [...sprockets, pinion, big, crank]) o.userData.dynamic = true;
  // A board behind the chain, and guide dowels that keep marbles on the paddles.
  const back = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.004, lift.yTop - lift.yBottom + 0.06, 0.04, 1, 0.001), oak(0.6, 0.04)));
  back.position.set(lift.x, (lift.yTop + lift.yBottom) / 2, lift.z);
  back.visible = false;
  liftGroup.add(back);
  for (const dz of [-0.0055, 0.0055]) {
    const x = lift.ballX + R + RAIL_R + 0.0005;
    liftGroup.add(shadow(dowel(new THREE.Vector3(x, lift.pickY + 0.01, lift.z + dz), new THREE.Vector3(x, lift.releaseY - 0.012, lift.z + dz), RAIL_R * 0.8, maple(0.6, 0.02))));
  }
  // Chain links and paddles, moved every frame.
  const linkCount = Math.floor(lift.loop / 0.006);
  const links = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0055, 0.0022, 0.006), new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.6, metalness: 0.2 }), linkCount);
  links.castShadow = true;
  const paddleMesh = shadow(new THREE.InstancedMesh(new RoundedBoxGeometry(0.02, 0.003, 0.008, 1, 0.001), oak(0.02, 0.01), lift.paddles));
  liftGroup.add(links, paddleMesh);
  links.userData.dynamic = paddleMesh.userData.dynamic = true;

  // ---- Switch flippers ----
  const flippers = layout.switches.map((sw) => {
    const pivot = new THREE.Group();
    pivot.position.copy(sw.at).add(new THREE.Vector3(0, R * 0.2, 0));
    const blade = shadow(new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.012, 0.0025, 2, 0.001), oak(0.03, 0.01)));
    blade.position.x = -0.015;   // trails back along the incoming track
    pivot.add(blade);
    const pin = shadow(dowel(new THREE.Vector3(0, -TIE_DROP, 0), new THREE.Vector3(0, 0.012, 0), 0.0018, walnut(0.02, 0.01)));
    pivot.add(pin);
    // Blade trails back along the incoming track: local +x points the way marbles travel.
    const base = Math.atan2(-sw.dir.z, sw.dir.x);
    pivot.rotation.y = base;
    group.add(pivot);
    pivot.userData.dynamic = true;
    return { sw, pivot, base, angle: 0 };
  });

  // ---- Marbles ----
  const marbleGeo = new THREE.SphereGeometry(R, 24, 16);
  const hues = [8, 32, 200, 140, 280, 50, 220, 340, 170, 100, 260, 20];
  const marbleMeshes = hues.map((h) => {
    const m = new THREE.Mesh(marbleGeo, new THREE.MeshPhysicalMaterial({
      map: marbleTexture(h),
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.3,
    }));
    m.castShadow = true;
    return m;
  });

  const calls = mergeStatic(group);
  return { group, links, paddleMesh, sprockets, pinion, big, crank, flippers, marbleMeshes, linkCount, lift, calls };
}

/**
 * Merge every static mesh that shares a wood (or material) into one mesh, so
 * the whole machine draws in a few dozen calls rather than hundreds. Each
 * part's texture repeat is baked into its UVs first, so parts cut to
 * different lengths can share one material.
 */
function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  const drop = [];
  group.traverse((o) => {
    if (o.userData.dynamic) return;
    for (let p = o.parent; p; p = p.parent) if (p.userData.dynamic) return;
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || !o.geometry.index) return;
    const m = o.material;
    const key = m.map ? `${m.map.source.uuid}:${m.side}:${m.color.getHexString()}` : m.uuid;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (m.map) {
      const uv = g.attributes.uv, { x, y } = m.map.repeat;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * x, uv.getY(i) * y);
    }
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!buckets.has(key)) buckets.set(key, { material: m, geos: [] });
    buckets.get(key).geos.push(g);
    drop.push(o);
  });
  for (const o of drop) o.removeFromParent();
  for (const { material, geos } of buckets.values()) {
    let mat = material;
    if (material.map) {
      mat = material.clone();
      for (const k of ['map', 'normalMap', 'roughnessMap']) {
        if (!material[k]) continue;
        mat[k] = material[k].clone();
        mat[k].repeat.set(1, 1);
        mat[k].needsUpdate = true;
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return buckets.size;
}

const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1), v3 = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/** Move everything that moves: marbles, chain, paddles, gears, flippers. */
export function updateMeshes(machine, meshes, dt) {
  const { lift } = machine.layout;
  machine.marbles.forEach((m, i) => {
    const mesh = meshes.marbleMeshes[i];
    mesh.position.copy(m.p);
    mesh.quaternion.copy(m.quat);
  });

  const cp = {};
  for (let i = 0; i < meshes.linkCount; i++) {
    chainPoint(lift, machine.chain + (i / meshes.linkCount) * lift.loop, cp);
    q.setFromAxisAngle(Z, Math.atan2(cp.ny, cp.nx) - Math.PI / 2);
    mat4.compose(v3.set(cp.x, cp.y, lift.z), q, s1);
    meshes.links.setMatrixAt(i, mat4);
  }
  meshes.links.instanceMatrix.needsUpdate = true;
  for (let k = 0; k < lift.paddles; k++) {
    chainPoint(lift, machine.chain + k * lift.pitch, cp);
    q.setFromAxisAngle(Z, Math.atan2(cp.ny, cp.nx));
    const off = 0.0095;
    mat4.compose(v3.set(cp.x + cp.nx * off, cp.y + cp.ny * off, lift.z), q, s1);
    meshes.paddleMesh.setMatrixAt(k, mat4);
  }
  meshes.paddleMesh.instanceMatrix.needsUpdate = true;

  // Gears turn with the chain.
  const turn = machine.chain / lift.radius;
  meshes.sprockets.forEach((g) => { g.rotation.z = -turn; });
  meshes.pinion.rotation.z = -turn;
  const bigTurn = (turn * 0.014) / 0.06;
  meshes.big.rotation.z = bigTurn;
  meshes.crank.rotation.z = bigTurn;

  for (const f of meshes.flippers) {
    const target = f.sw.state ? 0.28 : -0.28;
    f.angle += (target - f.angle) * Math.min(1, dt * 18);
    f.pivot.rotation.y = f.base + f.angle;
  }
}

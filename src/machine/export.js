import * as THREE from 'three';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The machine as a still USDZ model for AR Quick Look on iPhone: everything
// as it stands at this moment, marbles included, sitting on the table.

/** Bake each instanced mesh into one plain mesh, since USDZ doesn't have instancing. */
function flatten(root) {
  const out = new THREE.Group();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (o.isInstancedMesh) {
      if (!o.count) return;
      const m = new THREE.Matrix4();
      const parts = [];
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        parts.push(o.geometry.clone().applyMatrix4(m.premultiply(o.matrixWorld)));
      }
      out.add(new THREE.Mesh(mergeGeometries(parts), o.material));
    } else {
      const mesh = new THREE.Mesh(o.geometry, o.material);
      o.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
      out.add(mesh);
    }
  });
  return out;
}

export async function exportUSDZ(meshes, marbles) {
  const scene = new THREE.Scene();
  const model = new THREE.Group();
  model.add(flatten(meshes.group));
  for (const m of marbles) model.add(flatten(m));
  // Stand it on the table: the underside of the base at y = 0.
  const box = new THREE.Box3().setFromObject(model);
  model.position.y = -box.min.y;
  scene.add(model);
  scene.updateMatrixWorld(true);
  return new USDZExporter().parseAsync(scene, { quickLookCompatible: true, maxTextureSize: 1024 });
}

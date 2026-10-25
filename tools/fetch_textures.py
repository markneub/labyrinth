"""
Download the wood textures (CC0, Poly Haven) into public/textures/:
albedo, OpenGL normal and roughness maps per material at 1024 px, plus a
manifest.json recording where each came from.

    python3 tools/fetch_textures.py                    # fetch every material
    python3 tools/fetch_textures.py --search maple     # browse candidates

Needs network access to api.polyhaven.com and dl.polyhaven.org, and Pillow.
Material names are looked up in src/textures.js.
"""

import io
import json
import os
import sys
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures")
API = "https://api.polyhaven.com"

# (material name, Poly Haven asset id)
MATERIALS = [
    ("board", "white_maple_veneer"),  # the playing surface: pale, soft grain like birch ply
    ("wood", "oak_veneer_02"),        # blocks, rim, frame and box: a shade warmer
]
MAPS = {"albedo": "Diffuse", "normal": "nor_gl", "rough": "Rough"}
SIZE = 1024


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "labyrinth-asset-fetch"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def search(words):
    assets = json.loads(get(f"{API}/assets?t=textures"))
    for asset_id, info in sorted(assets.items()):
        text = " ".join([asset_id, info.get("name", "")] + info.get("tags", []) + info.get("categories", [])).lower()
        if all(w.lower() in text for w in words):
            print(f"{asset_id:32s} {info.get('name', '')} [{', '.join(info.get('categories', []))}]")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--search":
        search(sys.argv[2:])
        return
    os.makedirs(OUT, exist_ok=True)
    manifest = {"source": "Poly Haven (CC0)", "materials": []}
    for name, asset in MATERIALS:
        files = json.loads(get(f"{API}/files/{asset}"))
        for suffix, key in MAPS.items():
            img = Image.open(io.BytesIO(get(files[key]["2k"]["jpg"]["url"])))
            img = img.convert("L" if suffix == "rough" else "RGB").resize((SIZE, SIZE), Image.LANCZOS)
            img.save(os.path.join(OUT, f"{name}_{suffix}.jpg"), quality=88)
        manifest["materials"].append({"name": name, "asset": asset, "url": f"https://polyhaven.com/a/{asset}"})
        print(f"{name}: {asset}")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print("wrote", os.path.join(OUT, "manifest.json"))


if __name__ == "__main__":
    main()

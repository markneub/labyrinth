"""Shrink the exported AR model and check it against ARKit's rules.

    pip install usd-core pillow
    python3 tools/pack_usdz.py public/machine.usdz

three.js writes text geometry (.usda) and PNG textures; this converts the
geometry to binary .usdc and the opaque textures to JPEG, repackages the
.usdz in place and runs USD's validators on it.
"""
import os, sys, shutil, tempfile, zipfile
from PIL import Image
from pxr import Sdf, Usd, UsdUtils, UsdValidation

path = sys.argv[1]
work = tempfile.mkdtemp()
zipfile.ZipFile(path).extractall(work)

renames = {}
for root, _, files in os.walk(work):
    for f in files:
        full = os.path.join(root, f)
        rel = os.path.relpath(full, work)
        if f.endswith('.png'):
            im = Image.open(full)
            if im.mode in ('RGBA', 'LA') and im.getchannel('A').getextrema()[0] < 255:
                continue   # really uses alpha: keep as PNG
            jpg = full[:-4] + '.jpg'
            im.convert('RGB').save(jpg, quality=88)
            os.remove(full)
            renames[rel] = rel[:-4] + '.jpg'
        elif f.endswith('.usda') and rel != 'model.usda':
            layer = Sdf.Layer.FindOrOpen(full)
            layer.Export(full[:-5] + '.usdc')
            os.remove(full)
            renames[rel] = rel[:-5] + '.usdc'

root_layer = os.path.join(work, 'model.usda')
text = open(root_layer).read()
for a, b in renames.items():
    text = text.replace(a, b)
# Two property types three.js gets wrong for UsdPreviewSurface's texture readers.
text = text.replace('token inputs:in.connect', 'float2 inputs:in.connect')
text = text.replace('token inputs:varname', 'string inputs:varname')
open(root_layer, 'w').write(text)
# 8-bit normal maps need remapping from 0..1 to -1..1, which three.js leaves out.
stage = Usd.Stage.Open(root_layer)
for prim in stage.Traverse():
    if prim.GetName().endswith('_normal') and prim.GetAttribute('info:id').Get() == 'UsdUVTexture':
        prim.CreateAttribute('inputs:scale', Sdf.ValueTypeNames.Float4).Set((2, 2, 2, 1))
        prim.CreateAttribute('inputs:bias', Sdf.ValueTypeNames.Float4).Set((-1, -1, -1, 0))
stage.GetRootLayer().Export(os.path.join(work, 'model.usdc'))

out = path + '.tmp.usdz'
if not UsdUtils.CreateNewUsdzPackage(os.path.join(work, 'model.usdc'), out):
    sys.exit('packaging failed')
shutil.move(out, path)
shutil.rmtree(work)
print(f'{path}: {os.path.getsize(path) / 1e6:.1f} MB')
registry = UsdValidation.ValidationRegistry()
validators = registry.GetOrLoadAllValidators()
errors = UsdValidation.ValidationContext(validators).Validate(Usd.Stage.Open(path))
for e in errors:
    print(e.GetErrorAsString())
print('USD validation:', 'ok' if not errors else f'{len(errors)} problems')

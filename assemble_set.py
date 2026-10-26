"""Rebuild a StoryArc set in Blender from its floorplan JSON + prop GLBs, the same way the Walk Viewer does,
and save it as a .blend and one combined .glb.

  /opt/homebrew/bin/blender -b --factory-startup --python assemble_set.py -- FLOORPLAN.json PROP.glb [...] [--out PATH] [--turn NAME=DEG]

  --out   where to save, without the extension (default: next to the floorplan, "<floorplan file name>-set")
  --turn  turn the model in every box called NAME by DEG (90° steps), for a model that faces the wrong way (T in the viewer). Repeatable

Same rules as the viewer: each box takes the GLB with the closest name, stretched to fill it; boxes without one stay boxes;
a GLB without a box stays at its own spot. Blender (x, y, z) = StoryArc floorplan (x, z, y), so the .glb opens in the Walk Viewer
exactly where the viewer puts things, and the viewer shows StoryArc coordinates for it (scene extra "storyArc").
"""
import argparse, json, math, re, sys
from pathlib import Path

import bmesh, bpy
from mathutils import Euler, Matrix, Vector

ap = argparse.ArgumentParser(prog='assemble_set.py')
ap.add_argument('floorplan')
ap.add_argument('props', nargs='*')
ap.add_argument('--out')
ap.add_argument('--turn', action='append', default=[])
args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

plan = json.loads(Path(args.floorplan).read_text())
fp = plan['floorplan']
out = Path(args.out or str(Path(args.floorplan).with_suffix('')) + '-set').resolve()
turns = {name.strip().lower(): int(d) // 90 % 4 for name, d in (t.rsplit('=', 1) for t in args.turn)}
P = Matrix(((1, 0, 0), (0, 0, 1), (0, 1, 0)))  # StoryArc (x, y, z) <-> Blender (x, z, y)

# Box colours as in the viewer: hex, else the first CSS colour word (three.js's own list), else grey
CSS = dict(re.findall(r"'(\w+)': 0x([0-9A-F]{6})", (Path(__file__).parent / 'vendor/three/build/three.core.js').read_text()))
def color(c):
    c = c or ''
    h = c[1:] if re.fullmatch(r'#[0-9a-fA-F]{6}', c) else next((CSS[w] for w in re.findall(r'[a-z]+', c.lower()) if w in CSS), 'a7b0b9')
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))]  # sRGB → linear

mats = {}
def material(rgb, alpha=1.0):
    key = (*rgb, alpha)
    if key not in mats:
        m = mats[key] = bpy.data.materials.new('Box')
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = (*rgb, 1)
        bsdf.inputs['Roughness'].default_value = 0.85
        bsdf.inputs['Alpha'].default_value = alpha  # < 1 exports as a see-through (BLEND) material
        m.surface_render_method = 'BLENDED' if alpha < 1 else 'DITHERED'
        m.use_backface_culling = True  # one-sided like the viewer's boxes, or see-through walls look twice as white
    return mats[key]

def where(t):  # a StoryArc transform → Blender matrix. three.js Euler 'XYZ' = Blender 'ZYX'; P·R·P turns it into Blender's axes
    p, r = t['position'], t.get('rotation') or {}
    R = Euler((r.get('x', 0), r.get('y', 0), r.get('z', 0)), 'ZYX').to_matrix()
    return Matrix.Translation(P @ Vector((p['x'], p['y'], p['z']))) @ (P @ R @ P).to_4x4()

def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob

def copy(ob, parent):  # an object and its children, sharing their meshes and textures
    c = link(ob.copy())
    c.parent = parent
    for child in ob.children:
        copy(child, c)
    return c

def box(name, t, s, rgb, alpha=1.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1); bm.to_mesh(me); bm.free()
    me.transform(Matrix.Diagonal((*(P @ Vector((s['x'], s['y'], s['z']))), 1)))
    me.materials.append(material(rgb, alpha))
    link(ob := bpy.data.objects.new(name, me)).matrix_world = where(t)
    return ob

# Names match when every word of the shorter one is in the other; the closest pair wins (same rule as the viewer)
def words(s):
    return {w[:-1] if w.endswith('s') else w for w in re.findall(r'[^\W\d_]+', re.sub(r'\.(glb|gltf)$', '', s.lower()))}
def likeness(a, b):
    A, B = words(a), words(b)
    shared = len(A & B)
    return shared / len(A | B) if shared and shared == min(len(A), len(B)) else 0

for ob in list(bpy.data.objects):  # start empty
    bpy.data.objects.remove(ob)

props = []
for f in args.props:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(Path(f).resolve()))
    objs = [o for o in bpy.data.objects if o not in before]
    props.append({'name': Path(f).name, 'objs': objs, 'slots': []})
bpy.context.view_layer.update()

room = fp['roomDimensions']
box('Floor', {'position': {'x': 0, 'y': -0.01, 'z': 0}}, {'x': room['width'], 'y': 0.02, 'z': room['depth']}, color('#b9a27e'))
for i, w in enumerate(fp['wallCoordinates']['walls'], 1):
    a, b = w['start'], w['end']
    dx, dz = b['x'] - a['x'], b['z'] - a['z']
    box(f'Wall {i}', {'position': {'x': (a['x'] + b['x']) / 2, 'y': w['height'] / 2, 'z': (a['z'] + b['z']) / 2}, 'rotation': {'y': -math.atan2(dz, dx)}},
        {'x': math.hypot(dx, dz), 'y': w['height'], 'z': 0.08}, color('#f2f2f2'), 0.3)

for o in plan.get('objects', []):
    name, t = o['objectName'], o['transform']
    best = max(props, key=lambda p: likeness(p['name'], name), default=None)
    if not best or not likeness(best['name'], name):
        box(name, t, t['size'], color(o.get('color')))
        continue
    turn = turns.get(name.lower(), 0)
    best['slots'].append(name + (f' (turned {turn * 90}°)' if turn else ''))
    R = Matrix.Rotation(turn * math.pi / 2, 4, 'Z')
    pts = [R @ m.matrix_world @ Vector(c) for m in best['objs'] if m.type == 'MESH' for c in m.bound_box]
    lo, hi = (Vector([f(p[i] for p in pts) for i in range(3)]) for f in (min, max))
    s = P @ Vector((t['size']['x'], t['size']['y'], t['size']['z']))
    k = [want / have if have > 1e-6 else 1 for want, have in zip(s, hi - lo)]  # stretch to the box (flat models keep that size)
    # An empty in the box's place holds a copy of the model: turned 180° like in the viewer (StoryArc's plan is mirrored), centred, stretched
    slot = link(bpy.data.objects.new(name, None))
    slot.matrix_world = where(t) @ Matrix.Rotation(math.pi, 4, 'Z') @ Matrix.Diagonal((*k, 1)) @ Matrix.Translation(-(lo + hi) / 2)
    for m in best['objs']:
        if m.parent is None:
            copy(m, slot).matrix_basis = R @ m.matrix_basis

for p in props:
    if p['slots']:
        for m in p['objs']:
            bpy.data.objects.remove(m)
    print(f"{p['name']} → {', '.join(p['slots']) or 'no match, left at its own spot'}")

bpy.context.scene['storyArc'] = 1  # the viewer shows StoryArc coordinates for this set
out.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out) + '.blend')
bpy.ops.export_scene.gltf(filepath=str(out) + '.glb', export_format='GLB', export_extras=True)
print('Saved', str(out) + '.blend', 'and', str(out) + '.glb')

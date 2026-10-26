# Builds the example world for Walk Viewer: models/sample-street.glb, a small blocky street with breakable pieces.
#   blender -b --factory-startup --python make_sample.py
# Each piece is an empty with a custom property "piece" (→ glTF extras → userData.piece), at its bottom centre, with its meshes under it.
# A part (the water tank) hangs under its building: aim at it to break only the part. Buildings face the street (−y in Blender = +z in glTF).
# The scene property "walk_viewer" (JSON) gives the viewer its title and the places to jump to: [name, x, z, yaw°] in glTF coordinates.
import bpy, json, math, os

bpy.ops.wm.read_factory_settings(use_empty=True)
mats = {}
def mat(hex_):
    if hex_ not in mats:
        m = bpy.data.materials.new(hex_); m.use_nodes = True
        rgb = [int(hex_[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        bsdf = m.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = [c ** 2.2 for c in rgb] + [1]; bsdf.inputs['Roughness'].default_value = 0.85
        mats[hex_] = m
    return mats[hex_]
def box(name, center, size, color, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    o = bpy.context.object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True); o.data.materials.append(mat(color))
    if parent: o.parent = parent; o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o
def cyl(name, center, r, h, color, parent=None, verts=8):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=center)
    o = bpy.context.object; o.name = name; o.data.materials.append(mat(color))
    if parent: o.parent = parent; o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o
def ball(name, center, r, color, parent=None):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r, location=center)
    o = bpy.context.object; o.name = name; o.data.materials.append(mat(color))
    if parent: o.parent = parent; o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o
def piece(name, x, y, z=0.15, parent=None):
    e = bpy.data.objects.new('piece ' + name, None); e['piece'] = name; e.location = (x, y, z)
    bpy.context.scene.collection.objects.link(e)
    if parent: e.parent = parent; e.matrix_parent_inverse = parent.matrix_world.inverted()
    bpy.context.view_layer.update()
    return e

# ground: grass, a road along x, a sidewalk in front of the buildings
box('Grass', (0, -6, -0.05), (70, 52, 0.1), '7cb85a')
box('Road', (0, -9, 0.005), (70, 8, 0.01), '5f6670')
box('Sidewalk', (0, -2.5, 0.075), (70, 5, 0.15), 'd9d6cf')
for i in range(-8, 9): box(f'Road line {i + 9}', (i * 4, -9, 0.02), (2, 0.2, 0.01), 'f2f2f2')

def building(name, x, w, d, h, wall, roof, trim, door='5a3a2a', y0=0):
    p = piece(name, x, y0 + d / 2)
    box(f'{name} walls', (x, y0 + d / 2, 0.15 + h / 2), (w, d, h), wall, p)
    box(f'{name} roof', (x, y0 + d / 2, 0.15 + h + 0.2), (w + 0.4, d + 0.4, 0.4), roof, p)
    box(f'{name} door', (x, y0 - 0.06, 0.15 + 1.1), (1.2, 0.12, 2.2), door, p)
    floors = int((h - 1) // 3)
    for f in range(floors):
        z = 0.15 + 4.2 + f * 3 if h > 5 else 0.15 + 2.4
        if z + 1 > h: break
        for k in range(int(w // 2.5)):
            wx = x - w / 2 + 1.25 + k * 2.5
            if abs(wx - x) < 0.9 and z < 3: continue
            box(f'{name} window {f}-{k}', (wx, y0 - 0.05, z), (1.2, 0.1, 1.4), 'cfe8f7', p)
            box(f'{name} sill {f}-{k}', (wx, y0 - 0.1, z - 0.8), (1.5, 0.2, 0.15), trim, p)
    return p

building('Red house', -16, 8, 8, 9, 'c8553d', '5c2e2a', 'efe6d8')
shop = building('Blue shop', -6, 9, 9, 6, '3f6fb5', '263d63', 'f2f2f2')
box('Blue shop awning', (-6, -0.9, 3.1), (7, 1.8, 0.25), 'f2c14e', shop)
box('Blue shop sign', (-6, -0.08, 4.6), (5, 0.15, 1), 'ffffff', shop)
tower = building('Yellow tower', 4, 7, 7, 15, 'e9b949', '7a5a1e', 'ffffff')
tank = piece('Water tank', 5, 4.5, 15.55, tower)
cyl('Water tank barrel', (5, 4.5, 15.55 + 1.6 + 1.1), 1.1, 2.2, '8a5a3b', tank)
for dx, dy in ((-0.7, -0.7), (0.7, -0.7), (-0.7, 0.7), (0.7, 0.7)): box(f'Water tank leg {dx}{dy}', (5 + dx, 4.5 + dy, 15.55 + 0.8), (0.15, 0.15, 1.6), '333333', tank)
cafe = building('Green café', 14, 8, 8, 7, '4f8a5b', '2c4a33', 'f6efe2')
box('Green café awning', (14, -0.9, 3.0), (7, 1.8, 0.25), 'e85d5d', cafe)

def tree(name, x, y, s=1.0):
    p = piece(name, x, y)
    cyl(f'{name} trunk', (x, y, 0.15 + 1.4 * s), 0.18 * s, 2.8 * s, '7a5230', p)
    ball(f'{name} crown', (x, y, 0.15 + 3.6 * s), 1.6 * s, '4c9a4a', p)
for i, x in enumerate((-21, -11, 9, 19)): tree(f'Street tree {i + 1}', x, -4.3)
for i, (x, y, s) in enumerate(((-18, -20, 1.6), (-4, -24, 1.9), (10, -19, 1.5), (22, -23, 1.8))): tree(f'Park tree {i + 1}', x, y, s)
for i, x in enumerate((-26, -1, 24)):
    p = piece(f'Lamp post {i + 1}', x, -4.5)
    cyl(f'Lamp post {i + 1} pole', (x, -4.5, 0.15 + 2.2), 0.08, 4.4, '2b2b2b', p)
    box(f'Lamp post {i + 1} light', (x, -4.5, 0.15 + 4.5), (0.5, 0.5, 0.35), 'fff2b3', p)
for i, x in enumerate((-13, 0)):
    p = piece(f'Bench {i + 1}', x, -3.6)
    box(f'Bench {i + 1} seat', (x, -3.6, 0.15 + 0.45), (1.8, 0.5, 0.1), '9a6b3f', p)
    box(f'Bench {i + 1} back', (x, -3.37, 0.15 + 0.8), (1.8, 0.08, 0.6), '9a6b3f', p)
    for dx in (-0.8, 0.8): box(f'Bench {i + 1} leg {dx}', (x + dx, -3.6, 0.15 + 0.2), (0.1, 0.45, 0.4), '2b2b2b', p)
p = piece('Mailbox', 8, -4.4)
box('Mailbox body', (8, -4.4, 0.15 + 0.8), (0.5, 0.45, 0.7), '2f5bd3', p)
box('Mailbox leg', (8, -4.4, 0.15 + 0.25), (0.15, 0.15, 0.5), '2b2b2b', p)

bpy.context.scene['walk_viewer'] = json.dumps({'title': 'Sample street', 'places': [
    ['Start', -24, 2.5, -90], ['Shop', -6, 7, 0], ['Tower', 4, 7, 0], ['Café', 14, 7, 0], ['Park', 0, 14, 180]]})
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'sample-street.glb')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_extras=True)
print('wrote', out)

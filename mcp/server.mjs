#!/usr/bin/env node
// Walk Viewer MCP: lets an AI assistant (Claude, Cursor, any MCP client) walk through a 3D world and see it.
// Opens .glb / .gltf files (Blender, AI 3D tools like Meshy, Tripo, StoryArc) or a StoryArc floorplan .json in the Walk Viewer,
// running in a hidden Chrome, and gives the assistant tools to move the camera, walk with collisions, frame objects,
// take screenshots and ask what is at a spot in the picture.
// Plain Node 22+, nothing to install; needs Google Chrome (or set CHROME_PATH). Speaks MCP over stdio.
//   claude mcp add walk-viewer -- node /path/to/walk-viewer/mcp/server.mjs
// Coordinates: the model's own, in metres, y up (glTF). Yaw 0 looks toward −z, yaw 90 toward −x; pitch + looks up.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

const VIEWER = resolve(process.env.WALK_VIEWER_DIR ?? [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', 'Walk Viewer')] // index.html + vendor/: one folder up in the repo (mcp/), or the sibling folder
  .find(d => existsSync(join(d, 'index.html'))) ?? join(import.meta.dirname, '..'))
const CHROME = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => existsSync(p))
const log = (...a) => console.error('[walk-viewer]', ...a) // stdout is the MCP channel
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- a tiny local web server: the viewer, plus only the folders of files the assistant asked to open ----------------------------------
const allowed = new Set() // folders the assistant opened files from (a .gltf needs its .bin and textures next to it)
const MODEL = /\.(glb|gltf|bin|json|png|jpe?g|webp|ktx2)$/i
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const web = createServer((req, res) => {
  try {
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) throw 403
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file
    if (path.startsWith('/fs/')) {
      file = resolve(path.slice(3))
      if (!MODEL.test(file) || ![...allowed].some(d => file.startsWith(d + sep))) throw 403
    } else {
      file = join(VIEWER, path === '/' ? 'index.html' : path)
      if (!file.startsWith(VIEWER + sep)) throw 403
    }
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw 404
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch (e) { res.writeHead(typeof e === 'number' ? e : 400).end() }
})

// ---- hidden Chrome, driven over the DevTools protocol --------------------------------------------------------------------------------
let chrome, ws, profile, port, msgId = 0, size = [1280, 720]
const waiting = new Map()
const send = (method, params = {}) => new Promise((ok, no) => { waiting.set(++msgId, d => d.error ? no(Error(d.error.message)) : ok(d.result)); ws.send(JSON.stringify({ id: msgId, method, params })) })
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'page error')
  return r.result.value
}
async function browser() {
  if (ws?.readyState === 1) return
  if (!CHROME) throw Error('Google Chrome not found. Install it, or set CHROME_PATH to a Chrome/Chromium executable.')
  if (!existsSync(join(VIEWER, 'index.html'))) throw Error(`Walk Viewer not found at ${VIEWER}. Set WALK_VIEWER_DIR to the folder with its index.html.`)
  if (!web.listening) await new Promise(ok => web.once('error', () => web.listen(0, '127.0.0.1', ok)).listen(5241, '127.0.0.1', ok)) // a fixed port when free, so the browser keeps your saves
  port = web.address().port
  profile = mkdtempSync(join(tmpdir(), 'walk-viewer-mcp-'))
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((ok, no) => {
    let buf = ''; chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]) })
    chrome.on('exit', () => no(Error('Chrome quit while starting')))
    setTimeout(() => no(Error('Chrome did not start in 20 s')), 20000)
  })
  const http = wsUrl.replace(/^ws:\/\/([^/]+).*/, 'http://$1')
  const page = (await fetch(http + '/json').then(r => r.json())).find(t => t.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = m => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); waiting.delete(d.id) }
  await new Promise(ok => { ws.onopen = ok })
  await send('Page.enable')
  await setSize(...size)
  log('Chrome ready')
}
async function setSize(w, h) { size = [w, h]; await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }) }
function quit() { try { chrome?.kill() } catch {} ; try { profile && rmSync(profile, { recursive: true, force: true }) } catch {} ; process.exit(0) }
process.on('SIGINT', quit); process.on('SIGTERM', quit)

// ---- the agent's hands inside the page --------------------------------------------------------------------------------------------
const AGENT = String.raw`(() => {
  const v = viewer, T = v.THREE, cam = v.camera, ray = new T.Raycaster(), deg = 180 / Math.PI
  document.head.append(Object.assign(document.createElement('style'), { textContent: 'body > :not(canvas) { display: none !important }' })) // clean pictures: no HUD
  v.setFly(true) // the agent moves the camera itself; walking is done here, with collisions
  const meshes = () => { const m = []; v.model.traverse(o => o.isMesh && o.visible && !/^Label/.test(o.name) && m.push(o)); return m }
  const nameOf = o => { const path = []; for (; o && o !== v.model; o = o.parent) { const n = o.userData.piece ?? o.userData.slot ?? o.name; if (n && !/^(Scene|AuxScene)$/.test(n)) path.unshift(n) } return path.join(' > ') || '(unnamed)' }
  const r2 = n => Math.round(n * 100) / 100
  const bounds = () => new T.Box3().setFromObject(v.model)
  const a = window.agent = {
    eye: 1.7,
    world() {
      const b = bounds(), s = b.getSize(new T.Vector3()); let tris = 0, n = 0
      v.model.traverse(o => { if (o.isMesh) { n++; tris += (o.geometry.index ?? o.geometry.attributes.position).count / 3 } })
      a.walkable = Math.max(s.x, s.z) > 4 // building-sized: walking at eye height makes sense; smaller: fly
      return { size_m: s.toArray().map(r2), min: b.min.toArray().map(r2), max: b.max.toArray().map(r2), meshes: n, triangles: Math.round(tris), mode_hint: a.walkable ? 'walk' : 'fly' }
    },
    pose() {
      const e = new T.Euler().setFromQuaternion(cam.quaternion, 'YXZ'), d = cam.getWorldDirection(new T.Vector3())
      return { position: cam.position.toArray().map(r2), yaw_deg: r2(e.y * deg), pitch_deg: r2(e.x * deg), looking_toward: d.toArray().map(r2),
        fov_deg: r2(cam.fov), lens_mm: r2(cam.getFocalLength()), ground_below: a.ground(cam.position.x, cam.position.y, cam.position.z) ?? null }
    },
    ground(x, y, z) { // height of the first surface below (x, y, z)
      ray.set(new T.Vector3(x, y, z), new T.Vector3(0, -1, 0)); ray.far = Infinity
      const h = ray.intersectObjects(meshes(), false)[0]; return h ? r2(h.point.y) : undefined
    },
    setLook(yaw, pitch) { cam.quaternion.setFromEuler(new T.Euler(Math.max(-89.9, Math.min(89.9, pitch)) / deg, yaw / deg, 0, 'YXZ')) },
    lookAt(x, y, z) { cam.lookAt(x, y, z); const e = new T.Euler().setFromQuaternion(cam.quaternion, 'YXZ'); e.z = 0; cam.quaternion.setFromEuler(e) },
    moveTo(x, y, z, onGround) {
      if (onGround) { const g = a.ground(x, (y ?? bounds().max.y) + 0.5, z) ?? a.ground(x, bounds().max.y + 1, z); y = (g ?? 0) + a.eye }
      cam.position.set(x, y ?? cam.position.y, z)
    },
    walk(forward, right, up, onGround) { // step 0.2 m at a time; stop at the first wall (rays at knee and head height)
      const e = new T.Euler().setFromQuaternion(cam.quaternion, 'YXZ'), f = new T.Vector3(-Math.sin(e.y), 0, -Math.cos(e.y)), r = new T.Vector3(Math.cos(e.y), 0, -Math.sin(e.y))
      const d = f.multiplyScalar(forward).add(r.multiplyScalar(right)), len = d.length(), dir = d.clone().normalize(), m = meshes()
      let moved = 0, blocked = null
      while (moved < len - 1e-6) {
        const s = Math.min(0.2, len - moved)
        for (const dh of onGround ? [0.5 - a.eye, -0.2] : [0]) {
          ray.set(cam.position.clone().add(new T.Vector3(0, dh, 0)), dir); ray.far = s + 0.3
          const h = ray.intersectObjects(m, false)[0]; if (h) { blocked = nameOf(h.object); break }
        }
        if (blocked) break
        cam.position.addScaledVector(dir, s); moved += s
        if (onGround) { const g = a.ground(cam.position.x, cam.position.y - a.eye + 0.5, cam.position.z); if (g !== undefined) cam.position.y = g + a.eye }
      }
      cam.position.y += up
      return { moved_m: r2(moved), blocked_by: blocked }
    },
    objects(filter, limit) { // named things: StoryArc boxes / map pieces, else the model's top-level parts
      const out = [], seen = new Set(), push = o => { const b = new T.Box3().setFromObject(o); if (b.isEmpty() || seen.has(o)) return; seen.add(o)
        out.push({ name: nameOf(o), center: b.getCenter(new T.Vector3()).toArray().map(r2), size_m: b.getSize(new T.Vector3()).toArray().map(r2) }) }
      v.model.traverse(o => (o.userData.piece || o.userData.slot) && push(o))
      if (!out.length) for (const root of v.model.children) { const kids = root.children.length === 1 && !root.children[0].isMesh ? root.children[0].children : root.children; for (const k of (kids.length ? kids : [root])) push(k) }
      const f = (filter ?? '').toLowerCase(), list = out.filter(o => o.name.toLowerCase().includes(f))
      return { total: list.length, objects: list.slice(0, limit) }
    },
    find(name) {
      const f = name.toLowerCase(); let best = null
      v.model.traverse(o => { const n = (o.userData.piece ?? o.userData.slot ?? o.name ?? '').toLowerCase(); if (!n) return
        const score = n === f ? 3 : n.replace(/_/g, ' ') === f.replace(/_/g, ' ') ? 2 : n.includes(f) || n.replace(/_/g, ' ').includes(f) ? 1 : 0
        if (score > (best?.score ?? 0)) best = { o, score } })
      return best?.o
    },
    frame(name, view, distance) {
      const o = name ? a.find(name) : v.model; if (!o) return { error: 'No object named like "' + name + '". Use list_objects to see the names.' }
      const b = new T.Box3().setFromObject(o), c = b.getCenter(new T.Vector3()), r = b.getBoundingSphere(new T.Sphere()).radius
      const dirs = { front: [0, 0.15, 1], back: [0, 0.15, -1], left: [-1, 0.15, 0], right: [1, 0.15, 0], top: [0, 1, 0.001], three_quarter: [0.7, 0.45, 1] }
      const d = new T.Vector3(...(dirs[view] ?? dirs.three_quarter)).normalize(), dist = distance ?? r / Math.sin(cam.fov / 2 / deg) * 1.05
      cam.position.copy(c).addScaledVector(d, dist); a.lookAt(c.x, c.y, c.z)
      return { object: nameOf(o), center: c.toArray().map(r2), size_m: b.getSize(new T.Vector3()).toArray().map(r2), distance_m: r2(dist) }
    },
    pick(x, y) { // x, y in 0..1 across the picture (0, 0 = top left)
      ray.setFromCamera(new T.Vector2(x * 2 - 1, 1 - y * 2), cam); ray.far = Infinity
      const h = ray.intersectObjects(meshes(), false)[0]
      return h ? { object: nameOf(h.object), point: h.point.toArray().map(r2), distance_m: r2(h.distance) } : { object: null, note: 'nothing there (sky)' }
    },
    lens(fov, mm) { if (mm) cam.setFocalLength(mm); else if (fov) { cam.fov = fov; cam.updateProjectionMatrix() } },
    frames: () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))),
  }
  return true
})()`

// ---- tools ------------------------------------------------------------------------------------------------------------------------
let opened = null, openedUrls = []
const need = () => { if (!opened) throw Error('No world open yet. Call open_world first.') }
const pose = () => js('agent.pose()')
async function picture(w, h) {
  if (w && h && (w !== size[0] || h !== size[1])) await setSize(Math.min(w, 2048), Math.min(h, 2048))
  await js('agent.frames()')
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 })
  return { type: 'image', data: shot.data, mimeType: 'image/jpeg' }
}
const text = o => ({ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) })
const after = async (result, a) => { const c = [text({ ...result, pose: await pose() })]; if (a.screenshot) c.push(await picture(a.width, a.height)); return c }
const num = { type: 'number' }, shotArgs = { screenshot: { type: 'boolean', description: 'Also return a picture of the new view (default false).' } }

const TOOLS = {
  open_world: {
    description: 'Open a 3D world: one or more .glb / .gltf files (Blender, AI 3D generators like Meshy, Tripo, Hunyuan3D, StoryArc) or a StoryArc floorplan .json, by absolute file path or https URL. Files load together into one scene, replacing what was open. A floorplan .json plus prop .glb files rebuilds the set (props go into their boxes by name). Returns the world size, a starting pose and a picture.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths or https URLs.' } }, required: ['paths'] },
    async run({ paths }) {
      await browser()
      const urls = paths.map(p => {
        if (/^https?:\/\//.test(p)) return p
        const f = resolve(p); if (!existsSync(f)) throw Error('File not found: ' + f)
        if (!/\.(glb|gltf|json)$/i.test(f)) throw Error('Open .glb, .gltf or a StoryArc floorplan .json (convert other formats to .glb, e.g. in Blender).')
        allowed.add(dirname(f)); return f
      })
      const names = urls.map(u => u.split(/[/\\]/).pop()).join(', ')
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/?` + urls.map(u => 'model=' + encodeURIComponent(u)).join('&') })
      for (let t = 0; ; t += 250) {
        await sleep(250)
        const st = await js(`({ loaded: window.viewer?.loaded, err: document.getElementById('msg')?.classList.contains('err') ? document.getElementById('msg').textContent : '' })`).catch(() => ({}))
        if (st.err) throw Error(st.err)
        if (st.loaded === names) break
        if (t > 120000) throw Error('Timed out loading ' + names)
      }
      await js(AGENT)
      const world = await js('agent.world()')
      opened = names; openedUrls = urls
      const set = await js(`document.getElementById('set').textContent`)
      return [text({ opened: names, world, ...(set ? { set_assembly: set } : {}), pose: await pose(),
        tip: `Start: outside the world looking at its centre. ${world.mode_hint === 'walk' ? 'It is building-sized: use move_to with on_ground and walk to explore at eye height (1.7 m).' : 'It is small: fly around it with frame_object / move_to.'}` }), await picture()]
    },
  },
  look: {
    description: 'Take a picture of what the camera sees now (no on-screen controls in it). Optionally set the picture size, e.g. 1920×1080 or 1080×1920 to match an image you will generate.',
    inputSchema: { type: 'object', properties: { width: num, height: num } },
    async run(a) { need(); return [text({ pose: await pose() }), await picture(a.width, a.height)] },
  },
  list_objects: {
    description: 'List the named objects in the world with their centre and size (metres), to know where things are. Optional filter by name.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, limit: { type: 'number', description: 'Default 100.' } } },
    async run(a) { need(); return [text(await js(`agent.objects(${JSON.stringify(a.filter ?? '')}, ${a.limit ?? 100})`))] },
  },
  move_to: {
    description: 'Put the camera at a point. With on_ground: true it stands on the surface below (x, z) at eye height (1.7 m), like a person; then y is ignored. Keeps the current look direction unless look_at is given.',
    inputSchema: { type: 'object', properties: { x: num, y: num, z: num, on_ground: { type: 'boolean' }, look_at: { type: 'array', items: num, description: '[x, y, z] to face after moving.' }, ...shotArgs }, required: ['x', 'z'] },
    async run(a) {
      need(); await js(`agent.moveTo(${a.x}, ${a.y ?? 'undefined'}, ${a.z}, ${!!a.on_ground})`)
      if (a.look_at) await js(`agent.lookAt(${a.look_at.map(Number).join(',')})`)
      return after({ moved: true }, a)
    },
  },
  walk: {
    description: 'Walk relative to where the camera faces: forward / right / up in metres (negative = back / left / down). Stops at walls. With on_ground (default true) it follows the floor at eye height, like walking; false = fly straight.',
    inputSchema: { type: 'object', properties: { forward: num, right: num, up: num, on_ground: { type: 'boolean' }, ...shotArgs } },
    async run(a) { need(); return after(await js(`agent.walk(${a.forward ?? 0}, ${a.right ?? 0}, ${a.up ?? 0}, ${a.on_ground ?? true})`), a) },
  },
  turn: {
    description: 'Turn the head: yaw (left +, right −) and pitch (up +, down −) in degrees, added to the current look. Or set absolute values with absolute: true (yaw 0 = toward −z, 90 = toward −x).',
    inputSchema: { type: 'object', properties: { yaw: num, pitch: num, absolute: { type: 'boolean' }, ...shotArgs } },
    async run(a) {
      need(); const p = await pose()
      await js(`agent.setLook(${a.absolute ? a.yaw ?? p.yaw_deg : p.yaw_deg + (a.yaw ?? 0)}, ${a.absolute ? a.pitch ?? p.pitch_deg : p.pitch_deg + (a.pitch ?? 0)})`)
      return after({ turned: true }, a)
    },
  },
  look_at: {
    description: 'Face a point [x, y, z] or an object by name, without moving.',
    inputSchema: { type: 'object', properties: { point: { type: 'array', items: num }, object: { type: 'string' }, ...shotArgs } },
    async run(a) {
      need()
      if (a.object) { const c = await js(`(o => o && new viewer.THREE.Box3().setFromObject(o).getCenter(new viewer.THREE.Vector3()).toArray())(agent.find(${JSON.stringify(a.object)}))`); if (!c) throw Error('No object named like "' + a.object + '"'); a.point = c }
      if (!a.point) throw Error('Give point or object')
      await js(`agent.lookAt(${a.point.map(Number).join(',')})`)
      return after({ facing: a.point }, a)
    },
  },
  frame_object: {
    description: 'Move the camera so an object (by name, see list_objects) fills the view, from a side: front (+z), back, left, right, top or three_quarter (default). Leave the name empty to frame the whole world. Returns a picture.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, view: { type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'three_quarter'] }, distance: { type: 'number', description: 'Metres from its centre (default: fits it in view).' }, width: num, height: num } },
    async run(a) {
      need(); const r = await js(`agent.frame(${JSON.stringify(a.name ?? '')}, ${JSON.stringify(a.view ?? 'three_quarter')}, ${a.distance ?? 'undefined'})`)
      if (r.error) throw Error(r.error)
      return [text({ ...r, pose: await pose() }), await picture(a.width, a.height)]
    },
  },
  what_is_at: {
    description: 'What is at a spot in the current picture? x and y go from 0 to 1 across the image (0, 0 = top left, 0.5, 0.5 = centre). Returns the object name, the 3D point and its distance.',
    inputSchema: { type: 'object', properties: { x: num, y: num }, required: ['x', 'y'] },
    async run(a) { need(); return [text(await js(`agent.pick(${a.x}, ${a.y})`))] },
  },
  open_in_browser: {
    description: "Open the current world in the user's own web browser as the interactive Walk Viewer, starting at the current camera view, so they can walk around it themselves (W A S D + mouse, Minecraft-style; touch on phones). Use when the user wants to explore, check or adjust the view by hand. The page works while this assistant session is open.",
    inputSchema: { type: 'object', properties: {} },
    async run() {
      need(); const p = await pose()
      const url = `http://127.0.0.1:${port}/?` + openedUrls.map(u => 'model=' + encodeURIComponent(u)).join('&') + '&cam=' + [...p.position, p.yaw_deg, p.pitch_deg, p.fov_deg].map(n => Math.round(n * 1000) / 1000).join(',')
      if (!process.env.WALK_VIEWER_NO_OPEN) spawn(...(platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]), { stdio: 'ignore', detached: true }).unref()
      return [text({ opened_in_browser: url, starts_at: p, tell_the_user: 'Click the view to look around with the mouse; W A S D to walk, Space to jump (twice to fly), Esc to let go of the mouse.' })]
    },
  },
  set_lens: {
    description: 'Change the camera lens: fov_deg (vertical field of view, 10–120) or lens_mm (full-frame, like a Blender camera: 24 wide, 50 normal, 85 portrait).',
    inputSchema: { type: 'object', properties: { fov_deg: num, lens_mm: num, ...shotArgs } },
    async run(a) { need(); await js(`agent.lens(${a.fov_deg ?? 0}, ${a.lens_mm ?? 0})`); return after({ lens_set: true }, a) },
  },
}

// ---- MCP over stdio (JSON-RPC 2.0, one message per line) --------------------------------------------------------------------------
const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n')
let queue = Promise.resolve() // one tool at a time: they share one camera
createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return // notifications
  if (m.method === 'initialize') return reply(m.id, {
    protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'walk-viewer', version: '0.1.0' },
    instructions: 'Walk through a 3D world and see it. Start with open_world, then list_objects to learn where things are. Move with move_to / walk / turn / look_at / frame_object, check with look (a picture) and what_is_at. Units are metres, y is up.' })
  if (m.method === 'ping') return reply(m.id, {})
  if (m.method === 'tools/list') return reply(m.id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) })
  if (m.method !== 'tools/call') return reply(m.id, null, { code: -32601, message: 'Method not found: ' + m.method })
  const tool = TOOLS[m.params?.name]
  if (!tool) return reply(m.id, null, { code: -32602, message: 'Unknown tool: ' + m.params?.name })
  queue = queue.then(async () => {
    try { reply(m.id, { content: await tool.run(m.params.arguments ?? {}) }) }
    catch (e) { log(e.message); reply(m.id, { content: [text('Error: ' + e.message)], isError: true }) }
  })
}).on('close', quit)

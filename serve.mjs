#!/usr/bin/env node
// Walk Viewer server. Plain Node, nothing to install.
//   node serve.mjs                    start it and open http://localhost:5240/
//   node serve.mjs a.glb [b.glb ...]  open these models (if it's already running, it just opens them)
//   --no-open                         don't open a browser (tests)
// Serves this folder at /, and model/image files inside your home folder at /fs/<full path>. Read-only, and only to this computer.
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'

const PORT = 5240, HERE = import.meta.dirname, HOME = homedir()
const args = process.argv.slice(2), models = args.filter(a => !a.startsWith('--')).map(a => resolve(a))
const url = `http://localhost:${PORT}/` + (models.length ? '?' + models.map(m => 'model=' + encodeURIComponent(m)).join('&') : '')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

const server = createServer((req, res) => {
  try {
    // Only answer requests addressed to this computer by name, so a website can't use DNS tricks to read files through here.
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? '')) throw 403
    if (req.headers['sec-fetch-site'] === 'cross-site') throw 403 // nor can a website load files from here (an <img> pointing at your folders)
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const [root, file] = path.startsWith('/fs/') ? [HOME, resolve(path.slice(3))] : [HERE, join(HERE, path === '/' ? 'index.html' : path)]
    if (!file.startsWith(root + sep)) throw 403
    if (root === HOME && !/\.(glb|gltf|bin|json|png|jpe?g|webp|ktx2|spz|ply)$/i.test(file)) throw 403 // only model files leave the home folder
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw 404
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch (e) { res.writeHead(typeof e === 'number' ? e : 400).end() }
})
server.on('error', e => { if (e.code !== 'EADDRINUSE') throw e; console.log('Already running.'); show() })
server.listen(PORT, '127.0.0.1', () => { console.log('Walk Viewer: ' + url + '\n(Ctrl+C stops it)'); show() })
function show() { if (!args.includes('--no-open')) execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url]) }

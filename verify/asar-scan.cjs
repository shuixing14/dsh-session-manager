// Read-only scan of the DSH asar for a byte string within .js entries.
// Usage: node asar-scan.cjs <needle>   |   node asar-scan.cjs --dump <asar-path> [outFile]
const fs = require('node:fs')
const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'

const fd = fs.openSync(ASAR, 'r')
const b = Buffer.alloc(16)
fs.readSync(fd, b, 0, 16, 0)
const jsonLen = b.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const base = 16 + jsonLen

function walk(node, prefix, out) {
  for (const [n, c] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + n : n
    if (c.files) walk(c, p, out)
    else out.push({ path: p, size: Number(c.size), offset: c.offset != null ? Number(c.offset) : undefined, unpacked: !!c.unpacked })
  }
}

const files = []
walk(header, '', files)

function readEntry(rel) {
  const entry = files.find((f) => f.path === rel)
  if (!entry) return null
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset)
  return buf
}

const mode = process.argv[2]
if (mode === '--find') {
  const re = new RegExp(process.argv[3])
  for (const f of files) if (re.test(f.path)) console.log(f.path, f.size)
  process.exit(0)
}
if (mode === '--dump') {
  const rel = process.argv[3]
  const out = process.argv[4]
  const buf = readEntry(rel)
  if (!buf) {
    console.log('NOT FOUND', rel)
    process.exit(1)
  }
  if (out) fs.writeFileSync(out, buf)
  console.log('dumped', rel, buf.length, 'bytes ->', out)
  process.exit(0)
}

const needle = mode || '__ModuleLoader__'
const hits = []
for (const f of files) {
  if (!/\.js$/.test(f.path)) continue
  if (f.offset === undefined || f.unpacked) continue
  let buf
  try {
    buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, base + f.offset)
  } catch {
    continue
  }
  const s = buf.toString('utf8')
  if (s.indexOf(needle) >= 0) hits.push({ path: f.path, size: f.size, count: s.split(needle).length - 1 })
}
for (const h of hits) console.log(h.count, h.path, '(' + h.size + 'B)')
console.log('total files', files.length, 'hits', hits.length)
fs.closeSync(fd)

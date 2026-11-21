// Read-only: find asar entries containing a needle.
// usage: node find-in-asar.cjs <needle> [extension-filter]
const fs = require('node:fs')

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const base = 16 + jsonLen

const files = []
;(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (child.files) walk(child, p)
    else files.push({ path: p, size: Number(child.size), offset: Number(child.offset), unpacked: !!child.unpacked })
  }
})(header, '')

const needle = process.argv[2] || 'forwardWebRequest'
const ext = process.argv[3] || '.js'
let hits = 0
for (const f of files) {
  if (!f.path.endsWith(ext)) continue
  if (f.size > 20 * 1024 * 1024) continue
  let buf
  try {
    buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, base + f.offset)
  } catch {
    continue
  }
  const text = buf.toString('utf8')
  if (!text.includes(needle)) continue
  hits += 1
  const at = text.indexOf(needle)
  console.log('=== ' + f.path + ' (' + f.size + 'B) first@' + at)
}
console.log('hits:', hits, 'of', files.length)

// Read-only: dump one asar file to a local path.
// usage: node dump.cjs <asar-inner-path> <out-file>
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
    else files.push({ path: p, size: Number(child.size), offset: Number(child.offset) })
  }
})(header, '')
const [, , want, out] = process.argv
const entry = files.find((f) => f.path === want)
if (!entry) {
  console.error('NOT FOUND', want)
  process.exit(1)
}
const buf = Buffer.alloc(entry.size)
fs.readSync(fd, buf, 0, entry.size, base + entry.offset)
fs.writeFileSync(out, buf)
console.log('dumped', want, entry.size, '->', out)

// Extract one package tree from the DSH asar (read-only) into a local directory.
// usage: node extract-pkg.cjs <asar-inner-prefix> <out-dir>
const fs = require('node:fs')
const path = require('node:path')

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
const [prefix, outDir] = process.argv.slice(2)
if (!prefix || !outDir) {
  console.error('usage: extract-pkg.cjs <inner-prefix> <out-dir>')
  process.exit(2)
}

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const base = 16 + jsonLen

const files = []
;(function walk(node, current) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const next = current ? `${current}/${name}` : name
    if (child.files) walk(child, next)
    else files.push({ path: next, size: Number(child.size), offset: Number(child.offset) })
  }
})(header, '')

let count = 0
for (const file of files) {
  if (!file.path.startsWith(prefix)) continue
  const relative = file.path.slice(prefix.length).replace(/^\//, '')
  const target = path.join(outDir, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const buffer = Buffer.alloc(file.size)
  fs.readSync(fd, buffer, 0, file.size, base + file.offset)
  fs.writeFileSync(target, buffer)
  count += 1
}
console.log('extracted', count, 'files from', prefix, '->', outDir)

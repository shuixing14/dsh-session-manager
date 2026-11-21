// Read-only asar helper: list entries matching a regex, optionally dump one.
// Usage: node asar-tool.cjs list <regex>   |   node asar-tool.cjs dump <exact-path> <outFile>
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
    else files.push({ path: p, size: Number(child.size), offset: child.offset != null ? Number(child.offset) : undefined, unpacked: !!child.unpacked })
  }
})(header, '')

const [, , cmd, arg, arg2] = process.argv
if (cmd === 'list') {
  const re = new RegExp(arg)
  for (const f of files) if (re.test(f.path)) console.log(f.path, f.size)
} else if (cmd === 'dump') {
  const entry = files.find((f) => f.path === arg)
  if (!entry) {
    console.error('NOT FOUND', arg)
    process.exit(1)
  }
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset)
  fs.writeFileSync(arg2, buf)
  console.log('dumped', arg, entry.size)
} else {
  console.error('usage: list <regex> | dump <path> <out>')
  process.exit(2)
}

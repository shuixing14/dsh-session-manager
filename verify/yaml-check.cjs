// Parse the plugin's cordis.patch.yml with the SAME yaml package DSH bundles,
// and show how DSH's strict loader (parsePatchList) would judge it.
// Self-contained: extracts yaml@<bundled> from the asar on first run.
const fs = require('node:fs')
const path = require('node:path')

const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'
const YAML_DIR = path.join(__dirname, 'src', 'yamltest')

function extractYaml() {
  if (fs.existsSync(path.join(YAML_DIR, 'dist', 'index.js'))) return
  const fd = fs.openSync(ASAR, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jb = Buffer.alloc(jsonLen)
  fs.readSync(fd, jb, 0, jsonLen, 16)
  const header = JSON.parse(jb.toString('utf8'))
  const base = 16 + jsonLen
  const out = []
  const walk = (node, prefix) => {
    for (const [n, c] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + n : n
      if (c.files) walk(c, p)
      else out.push({ path: p, size: Number(c.size), offset: Number(c.offset) })
    }
  }
  walk(header, '')
  const PREFIX = 'dsh/node_modules/yaml/'
  let count = 0
  for (const f of out) {
    if (!f.path.startsWith(PREFIX) || f.path.startsWith(PREFIX + 'browser/')) continue
    const dest = path.join(YAML_DIR, f.path.slice(PREFIX.length))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, base + f.offset)
    fs.writeFileSync(dest, buf)
    count += 1
  }
  fs.closeSync(fd)
  console.log('extracted yaml@' + require(path.join(YAML_DIR, 'package.json')).version + ' (' + count + ' files) from the asar')
}

extractYaml()
const YAML = require(path.join(YAML_DIR, 'dist', 'index.js'))

const PATCH = path.join(__dirname, '..', 'cordis.patch.yml')
const patch = fs.readFileSync(PATCH, 'utf8')

function report(label, content) {
  console.log('\n=== ' + label + ' ===')
  let parsed
  try {
    parsed = YAML.parse(content)
  } catch (error) {
    console.log('PARSE ERROR (true YAML):')
    console.log('  ' + error.message.split('\n').slice(0, 5).join('\n  '))
    return
  }
  console.log('parsed =', JSON.stringify(parsed))
  // DSH's own post-parse validation (app-boot parsePatchList):
  if (!Array.isArray(parsed)) {
    console.log("DSH loader would THROW: \"must be a top-level YAML array of loader patch entries\"")
    return
  }
  console.log('top-level array: yes; entries =', parsed.length)
}

report('as shipped (// comment header)', patch)

const fixed = patch
  .split('\n')
  .map((l) => (l.trim().startsWith('//') ? l.replace(/^(\s*)\/\//, '$1#') : l))
  .join('\n')
report('control: # comment header', fixed)

console.log('\n=== first token analysis of the shipped file ===')
for (const [i, line] of (patch || '').split('\n').slice(0, 12).entries()) {
  console.log(String(i + 1).padStart(2), JSON.stringify(line.slice(0, 70)))
}

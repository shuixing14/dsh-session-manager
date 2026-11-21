// Repair the profile's dsh-session-manager link: point it at the real plugin checkout.
const fs = require('node:fs')
const path = require('node:path')

const PROFILE = 'C:\\Users\\shuixing\\.dsh\\profiles\\desktop'
const TARGET = 'D:\\dsh\\dsh-session-manager'
const LINK = path.join(PROFILE, 'node_modules', 'dsh-session-manager')

if (!fs.existsSync(path.join(TARGET, 'package.json'))) {
  console.error('target missing:', TARGET)
  process.exit(1)
}

try {
  const stat = fs.lstatSync(LINK)
  if (stat.isSymbolicLink() || stat.isDirectory()) fs.rmSync(LINK, { recursive: true, force: true })
} catch {}

fs.symlinkSync(TARGET, LINK, 'junction')
const resolved = fs.realpathSync(LINK)
console.log('link:', LINK)
console.log('-> ', resolved)
console.log('has package.json:', fs.existsSync(path.join(resolved, 'package.json')))
console.log('has lib/index.js:', fs.existsSync(path.join(resolved, 'lib', 'index.js')))

// Proof script: copy lib/index.js to <verify>/patched/, apply the three suggested
// fixes, and run the same E2E checks against the copy. This proves the diagnosis
// (the failures are caused by these exact lines) without touching the package.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'lib', 'index.js')
const DEST_DIR = path.join(HERE, 'patched')
const DEST = path.join(DEST_DIR, 'index.js')

fs.mkdirSync(DEST_DIR, { recursive: true })
for (const f of ['index.js', 'store.js']) {
  fs.copyFileSync(path.join(HERE, '..', 'lib', f), path.join(DEST_DIR, f))
}

let src = fs.readFileSync(DEST, 'utf8')
const edits = [
  // 1. expose the workspace unit file on the listing
  [
    "  return { sessions, home, currentSessionId, pendingMutation: workspace.pendingMutation }",
    "  return { sessions, home, currentSessionId, pendingMutation: workspace.pendingMutation, file: workspace.file }",
  ],
  // 2. pendingMutation presence test that matches the real `undefined`-when-idle shape
  [
    'pendingMutation: Boolean(unit?.global && typeof unit.global === \'object\' && unit.global.pendingMutation),',
    "pendingMutation: unit?.global?.pendingMutation !== undefined && unit?.global?.pendingMutation !== null,",
  ],
  // 3. collision-proof backup dir
  [
    '      const backupDir = backup ? path.join(home, \'session-delete-backup\', stamp()) : undefined\n      if (backupDir) fs.mkdirSync(backupDir, { recursive: true })',
    '      let backupDir\n      if (backup) {\n        const baseDir = path.join(home, \'session-delete-backup\', stamp())\n        backupDir = baseDir\n        for (let n = 1; ; n += 1) {\n          try {\n            fs.mkdirSync(backupDir) // no recursive: exists -> EEXIST -> next suffix\n            break\n          } catch (error) {\n            if (error?.code !== \'EEXIST\' || n > 50) {\n              throw error\n            }\n            backupDir = `${baseDir}-${n}`\n          }\n        }\n      }',
  ],
]
for (const [from, to] of edits) {
  if (!src.includes(from)) {
    console.log('EDIT NOT APPLICABLE (source moved?): ' + from.slice(0, 70))
    continue
  }
  src = src.replace(from, to)
}
fs.writeFileSync(DEST, src)
console.log('patched copy written to', DEST)

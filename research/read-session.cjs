// READ-ONLY helper: decode a DSH session log. These files are MULTI-FRAME zstd,
// so zstdDecompressSync(file) returns only the first frame (the header) — loop over frames.
// Usage: node read-session.cjs <path-to-session.v4.jsonl.zstd> [eventCount]
const fs = require('node:fs');
const zlib = require('node:zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function frameStarts(buf) {
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  return starts;
}

function decodeAll(buf) {
  const starts = frameStarts(buf);
  const parts = starts.map((s, k) =>
    zlib.zstdDecompressSync(buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length)));
  return { frames: starts.length, text: Buffer.concat(parts).toString('utf8') };
}

const p = process.argv[2];
const limit = Number(process.argv[3] || 3);
const buf = fs.readFileSync(p);
const { frames, text } = decodeAll(buf);
const lines = text.split('\n').filter(Boolean);
console.log(`file=${p}\nbytes=${buf.length} frames=${frames} events=${lines.length}`);
for (let k = 0; k < Math.min(limit, lines.length); k++) {
  const v = JSON.parse(lines[k]);
  const shape = Object.fromEntries(Object.entries(v).map(([key, val]) => [
    key, Array.isArray(val) ? `array(${val.length})`
      : val && typeof val === 'object' ? 'object'
      : typeof val === 'string' && val.length > 60 ? val.slice(0, 60) + '…' : val,
  ]));
  console.log(`line ${k}:`, JSON.stringify(shape));
}

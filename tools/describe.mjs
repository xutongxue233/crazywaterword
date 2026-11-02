import { PROTO_BUNDLE as BUNDLE, readProtocolSource } from '../src/protocol-source.mjs';

// The proto bundle is protobufjs `-t static-module` output: no reflection metadata at
// all, only hard-coded encode/decode bodies per type. Field numbers and names therefore
// have to be read back out of those bodies.

const WIRE_CALL = /t\.uint32\((\d+)\)\.([A-Za-z0-9_]+)\(e\.([A-Za-z0-9_.]+)/g;
const CASE_SCALAR = /case (\d+):o\.([A-Za-z0-9_]+)=t\.([A-Za-z0-9_]+)\(\)/g;
const CASE_ARRAY = /case (?<num>\d+):o\.(?<field>[A-Za-z0-9_]+)&&o\.\k<field>\.length\|\|\(o\.\k<field>=\[\]\),o\.\k<field>\.push\(tf\.protocol\.(?<type>[A-Za-z0-9_]+)\.decode/g;
const CASE_MSG = /case (\d+):o\.([A-Za-z0-9_]+)=tf\.protocol\.([A-Za-z0-9_]+)\.decode/g;
const CASE_COND = /case (\d+):/g;

const source = readProtocolSource();
const indexes = new Map();
// 前缀有两种：组内其余项是 `,i.X=...`，组里第一项是 `}).X=...`（见 findType）。
for (const match of source.matchAll(/(?:^|[,;{(]i\.|\}\)\.)([A-Za-z0-9_]+)=function\(\)\{/g)) {
  indexes.set(match[1], match.index + match[0].length - 1);
}

function typeNames() {
  return [...indexes.keys()].sort();
}

// 类型是按对象字面量成组声明的，组里的第一项写成 `((i={}).X=function(){`，
// 其余项写成 `,i.X=function(){`。只认前一种前缀会漏掉每组第一个类型
// （AchievementInfoRequest 就是这么被漏掉的），所以两种都试。
function findType(name) {
  let start = -1;
  for (const prefix of [`i.${name}=function(){`, `}).${name}=function(){`]) {
    const at = source.indexOf(prefix);
    if (at >= 0 && (start < 0 || at < start)) start = at;
  }
  if (start < 0) return null;
  const next = source.indexOf(',i.', start + 1);
  const end = next < 0 ? source.length : next;
  return source.slice(start, end);
}

function fields(name) {
  const raw = findType(name);
  if (!raw) throw new Error(`unknown type: ${name}`);
  // protobufjs emits `switch (i>>>3) { case N: ... }` for multi-field types but a bare
  // `i>>>3==N? ... :` ternary when the type has a single field. Normalise so one set of
  // patterns covers both.
  const body = raw.replace(/i>>>3==(\d+)\?\(?/g, 'case $1:');
  const out = new Map();
  const ensure = (number) => {
    if (!out.has(number)) out.set(number, { number, name: null, kind: 'unknown', type: null });
    return out.get(number);
  };

  for (const match of body.matchAll(WIRE_CALL)) {
    const field = ensure(Number(match[1]) >> 3);
    const call = match[2];
    const path = match[3];
    if (field.name === null && !path.includes('.')) field.name = path;
    field.wire = call;
  }
  for (const match of body.matchAll(CASE_ARRAY)) {
    const field = ensure(Number(match.groups.num));
    field.name = match.groups.field;
    field.kind = 'repeated';
    field.type = match.groups.type;
  }
  for (const match of body.matchAll(CASE_MSG)) {
    const field = ensure(Number(match[1]));
    field.name = match[2];
    field.kind = 'message';
    field.type = match[3];
  }
  for (const match of body.matchAll(CASE_SCALAR)) {
    const field = ensure(Number(match[1]));
    field.name = match[2];
    field.kind = 'scalar';
    field.type = match[3];
  }

  const required = new Set(
    [...body.matchAll(/missing required '([A-Za-z0-9_]+)'/g)].map((match) => match[1]),
  );
  // proto2 `required` also shows up as an unguarded assignment in encode: no
  // `Object.hasOwnProperty.call(e,"x")` guard in front of it.
  const hasOwn = new Set(
    [...body.matchAll(/Object\.hasOwnProperty\.call\(e,"([A-Za-z0-9_]+)"\)/g)].map((match) => match[1]),
  );

  return [...out.values()]
    .sort((a, b) => a.number - b.number)
    .map((field) => ({ ...field, required: field.name ? required.has(field.name) : false, optional: field.name ? hasOwn.has(field.name) : false }));
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    const needle = (args[1] ?? '').toLowerCase();
    for (const name of typeNames()) if (name.toLowerCase().includes(needle)) console.log(name);
  } else {
    for (const name of args) {
      const list = fields(name);
      console.log(`\n=== ${name} (${list.length} fields) ===`);
      for (const field of list) {
        const flags = [field.required ? 'required' : '', field.optional ? 'optional' : ''].filter(Boolean).join(',');
        console.log(`  ${String(field.number).padStart(3)}  ${(field.name ?? '?').padEnd(24)} ${String(field.kind).padEnd(9)} ${String(field.type ?? field.wire ?? '').padEnd(22)} ${flags}`);
      }
    }
  }
}

export { BUNDLE, fields, findType, typeNames };

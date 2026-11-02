// wxapkg tool: decrypt PC-WeChat V1MMWX package + unpack wxapkg archive
// usage: node wxapkg.mjs decrypt <appid> <in.wxapkg> <out.wxapkg>
//        node wxapkg.mjs unpack  <in.wxapkg> <outdir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from('V1MMWX');
const HEADER_SIZE = 14;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function asBuffer(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('wxapkg input must be a Buffer or Uint8Array');
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function decrypt(appid, input) {
  const data = asBuffer(input);
  if (!data.length) throw new Error('wxapkg input is empty');
  if (data.length < MAGIC.length && data.equals(MAGIC.subarray(0, data.length))) {
    throw new Error('truncated V1MMWX header');
  }
  if (!data.subarray(0, 6).equals(MAGIC)) return { data, decrypted: false };
  if (data.length < 1030) throw new Error('truncated V1MMWX encrypted block: expected at least 1030 bytes');
  if (typeof appid !== 'string' || !appid.length) throw new Error('an appid is required to decrypt V1MMWX');
  const key = crypto.pbkdf2Sync(Buffer.from(appid, 'utf8'), Buffer.from('saltiest'), 1000, 32, 'sha1');
  const iv = Buffer.from('the iv: 16 bytes');
  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
  dec.setAutoPadding(false);
  // AES block covers plaintext[0..1022]; its 1024th plaintext byte is padding garbage.
  const head = Buffer.concat([dec.update(data.subarray(6, 1030)), dec.final()]).subarray(0, 1023);
  const xk = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
  const tail = Buffer.from(data.subarray(1030));
  for (let i = 0; i < tail.length; i++) tail[i] ^= xk;
  return { data: Buffer.concat([head, tail]), decrypted: true };
}

function relativeName(name) {
  // Package entries normally begin with '/'; this is an archive root, not a drive root.
  // Reject Windows aliases even on another OS so an extracted package stays portable.
  if (!name || /[\\\x00-\x1f\x7f<>:"|?*]/.test(name)) throw new Error(`unsafe archive path: ${JSON.stringify(name)}`);
  const parts = name.replace(/^\/+/, '').split('/');
  if (parts.some((part) => part === '..')) throw new Error(`archive path traversal: ${JSON.stringify(name)}`);
  const clean = parts.filter((part) => part && part !== '.');
  if (!clean.length || clean.some((part) => /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error(`unsafe Windows archive path: ${JSON.stringify(name)}`);
  }
  return clean.join('/');
}

// Fully validate the archive before touching an output directory. Offsets are absolute.
export function inspectArchive(input) {
  const buf = asBuffer(input);
  if (buf.length < HEADER_SIZE + 4) throw new Error('truncated wxapkg header or file count');
  if (buf[0] !== 0xbe || buf[13] !== 0xed) throw new Error('invalid wxapkg header markers');
  const indexLen = buf.readUInt32BE(5);
  const bodyLen = buf.readUInt32BE(9);
  const bodyStart = HEADER_SIZE + indexLen;
  const bodyEnd = bodyStart + bodyLen;
  if (indexLen < 4 || bodyStart > buf.length || bodyEnd !== buf.length) {
    throw new Error('wxapkg index/body lengths do not match the input size');
  }
  const count = buf.readUInt32BE(14);
  if (count > Math.floor((indexLen - 4) / 13)) throw new Error('wxapkg file count exceeds the index size');
  let p = 18;
  const files = [];
  const names = new Set();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 4 > bodyStart) throw new Error(`truncated index entry ${i}`);
    const nameLen = buf.readUInt32BE(p); p += 4;
    if (!nameLen || nameLen > bodyStart - p - 8) throw new Error(`invalid filename length in index entry ${i}`);
    let name;
    try { name = utf8.decode(buf.subarray(p, p + nameLen)); }
    catch { throw new Error(`invalid UTF-8 filename in index entry ${i}`); }
    p += nameLen;
    const off = buf.readUInt32BE(p); p += 4;
    const size = buf.readUInt32BE(p); p += 4;
    if (off < bodyStart || off > bodyEnd || size > bodyEnd - off) {
      throw new Error(`file data outside the declared body: ${JSON.stringify(name)}`);
    }
    const relativePath = relativeName(name);
    const canonical = relativePath.normalize('NFC').toLowerCase();
    if (names.has(canonical)) throw new Error(`duplicate archive path: ${JSON.stringify(name)}`);
    names.add(canonical);
    files.push({ name, relativePath, off, size });
    total += size;
  }
  if (p !== bodyStart) throw new Error('wxapkg index has unconsumed or missing bytes');
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/'))) throw new Error(`archive file/directory conflict: ${name}`);
    }
  }
  return { count, indexLen, bodyLen, total, files };
}

function statIfPresent(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// lstat every component, including existing ancestors of the requested output root.
function checkDirectories(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = statIfPresent(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`output directory is a symlink or not a directory: ${current}`);
    }
  }
}

function checkNewFile(filename) {
  checkDirectories(path.dirname(filename));
  if (statIfPresent(filename)) throw new Error(`refusing to overwrite existing output: ${filename}`);
}

function makeDirectories(directory, created) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = statIfPresent(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe output directory: ${current}`);
    } else {
      fs.mkdirSync(current);
      created.push(current);
    }
  }
}

function writeNewFiles(files) {
  const createdFiles = [];
  const createdDirectories = [];
  try {
    for (const { dest, data } of files) {
      makeDirectories(path.dirname(dest), createdDirectories);
      checkNewFile(dest);
      const fd = fs.openSync(dest, 'wx');
      createdFiles.push(dest);
      try { fs.writeFileSync(fd, data); }
      finally { fs.closeSync(fd); }
    }
  } catch (error) {
    // Only remove entries created by this invocation; never recursively remove a directory.
    for (const filename of createdFiles.reverse()) { try { fs.unlinkSync(filename); } catch {} }
    for (const directory of createdDirectories.reverse()) { try { fs.rmdirSync(directory); } catch {} }
    throw error;
  }
}

export function unpack(input, outdir) {
  const buf = asBuffer(input);
  const result = inspectArchive(buf);
  const root = path.resolve(outdir);
  checkDirectories(root);
  const outputs = result.files.map((file) => {
    const dest = path.resolve(root, ...file.relativePath.split('/'));
    const relative = path.relative(root, dest);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`archive path escapes the output directory: ${file.name}`);
    }
    checkNewFile(dest);
    return { dest, data: buf.subarray(file.off, file.off + file.size) };
  });
  // Every archive entry and existing destination has passed preflight at this point.
  if (!outputs.length) makeDirectories(root, []);
  else writeNewFiles(outputs);
  return { count: result.count, bodyLen: result.bodyLen, total: result.total };
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const [cmd, a, b, c] = argv;
  const usage = 'usage: decrypt <appid> <in> <out> | unpack <in> <outdir>';
  if (cmd === '--help' || cmd === '-h') { log(usage); return 0; }
  try {
    if (cmd === 'decrypt' && argv.length === 4) {
      const raw = fs.readFileSync(b);
      const { data, decrypted } = decrypt(a, raw);
      // A wrong appid must not leave a file that looks like a successful decryption.
      inspectArchive(data);
      const dest = path.resolve(c);
      checkNewFile(dest);
      writeNewFiles([{ dest, data }]);
      log(`${decrypted ? 'decrypted' : 'plain'} ${raw.length} -> ${data.length} bytes, first=0x${data[0].toString(16)}`);
    } else if (cmd === 'unpack' && argv.length === 3) {
      const r = unpack(fs.readFileSync(a), b);
      log(`unpacked ${r.count} files, ${r.total} bytes -> ${b}`);
    } else throw new Error(usage);
    return 0;
  } catch (cause) {
    error(`wxapkg: ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();

// Synthetic packages only: no installed client, user credentials, or game code execution.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decrypt, inspectArchive, main, unpack } from './wxapkg.mjs';

function archive(entries) {
  const files = entries.map(([name, data]) => ({ name: Buffer.from(name), data: Buffer.from(data) }));
  const indexLen = 4 + files.reduce((sum, file) => sum + 12 + file.name.length, 0);
  const bodyLen = files.reduce((sum, file) => sum + file.data.length, 0);
  const result = Buffer.alloc(14 + indexLen + bodyLen);
  result[0] = 0xbe;
  result.writeUInt32BE(indexLen, 5);
  result.writeUInt32BE(bodyLen, 9);
  result[13] = 0xed;
  result.writeUInt32BE(files.length, 14);
  let p = 18;
  let body = 14 + indexLen;
  for (const file of files) {
    result.writeUInt32BE(file.name.length, p); p += 4;
    file.name.copy(result, p); p += file.name.length;
    result.writeUInt32BE(body, p); p += 4;
    result.writeUInt32BE(file.data.length, p); p += 4;
    file.data.copy(result, body); body += file.data.length;
  }
  return result;
}

function entryOffset(buf, index) {
  let p = 18;
  for (let i = 0; i < index; i++) p += 12 + buf.readUInt32BE(p);
  return p;
}

// Inverse of the documented PC wrapper: 1023 bytes + one discarded AES byte,
// then XOR the remainder using the appid's penultimate UTF-16 code unit.
function encryptedFixture(appid, plain) {
  assert(plain.length >= 1023);
  const key = crypto.pbkdf2Sync(appid, 'saltiest', 1000, 32, 'sha1');
  const cipher = crypto.createCipheriv('aes-256-cbc', key, Buffer.from('the iv: 16 bytes'));
  cipher.setAutoPadding(false);
  const aesInput = Buffer.concat([plain.subarray(0, 1023), Buffer.from([0xa5])]);
  const encryptedHead = Buffer.concat([cipher.update(aesInput), cipher.final()]);
  const tail = Buffer.from(plain.subarray(1023));
  const xor = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
  for (let i = 0; i < tail.length; i++) tail[i] ^= xor;
  return Buffer.concat([Buffer.from('V1MMWX'), encryptedHead, tail]);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wxapkg-test-'));
let rejected = 0;
try {
  const moduleUrl = new URL('./wxapkg.mjs', import.meta.url).href;
  const imported = execFileSync(process.execPath, ['--input-type=module', '-e',
    `process.argv = ['node', 'unrelated-entry', 'invalid']; await import(${JSON.stringify(moduleUrl)}); console.log('import-ok');`,
  ], { encoding: 'utf8' });
  assert.equal(imported.trim(), 'import-ok', 'import must not execute the CLI');
  assert.equal(main(['--help'], { log() {}, error() {} }), 0);

  const plain = archive([
    ['/src/chunks/game.js', Buffer.from('fixture source; never evaluated')],
    ['./assets/binary.bin', Buffer.from([0, 255, 128, 10])],
    ['/empty.txt', Buffer.alloc(0)],
  ]);
  const parsed = inspectArchive(plain);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.files[0].relativePath, 'src/chunks/game.js');
  const output = path.join(temp, 'roundtrip');
  const result = unpack(plain, output);
  assert.equal(result.count, 3);
  assert.equal(result.total, parsed.total);
  assert.equal(fs.readFileSync(path.join(output, 'src/chunks/game.js'), 'utf8'), 'fixture source; never evaluated');
  assert.deepEqual(fs.readFileSync(path.join(output, 'assets/binary.bin')), Buffer.from([0, 255, 128, 10]));
  assert.equal(fs.statSync(path.join(output, 'empty.txt')).size, 0);
  // Explicit byteOffset coverage without relying on Buffer's shared slab offset.
  const padded = new Uint8Array(plain.length + 16);
  padded.set(plain, 7);
  assert.equal(inspectArchive(padded.subarray(7, 7 + plain.length)).count, 3);
  assert.equal(decrypt('unused', plain).decrypted, false);
  assert.deepEqual(decrypt('unused', plain).data, plain);
  unpack(archive([]), path.join(temp, 'empty-package'));
  assert(fs.statSync(path.join(temp, 'empty-package')).isDirectory());

  const largePlain = archive([['/large.bin', Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 251))]]);
  const appid = 'wx0123456789abcdef';
  const encrypted = encryptedFixture(appid, largePlain);
  assert.equal(decrypt(appid, encrypted).decrypted, true);
  assert.deepEqual(decrypt(appid, encrypted).data, largePlain);
  assert.deepEqual(decrypt('x', encryptedFixture('x', largePlain)).data, largePlain, 'short appid XOR fallback');
  for (const length of [0, 1, 5, 6, 100, 1029]) assert.throws(() => decrypt(appid, encrypted.subarray(0, length)));
  assert.throws(() => decrypt('', encrypted), /appid/);
  assert.throws(() => decrypt(appid, 'not bytes'), /Buffer/);

  const encryptedFile = path.join(temp, 'encrypted.wxapkg');
  const decryptedFile = path.join(temp, 'decrypted.wxapkg');
  fs.writeFileSync(encryptedFile, encrypted);
  const quiet = { log() {}, error() {} };
  assert.equal(main(['decrypt', appid, encryptedFile, decryptedFile], quiet), 0);
  assert.deepEqual(fs.readFileSync(decryptedFile), largePlain);
  assert.equal(main(['decrypt', appid, encryptedFile, decryptedFile], quiet), 1, 'CLI refuses overwrite');
  assert.deepEqual(fs.readFileSync(decryptedFile), largePlain);
  const wrongKeyOutput = path.join(temp, 'wrong-key.wxapkg');
  assert.equal(main(['decrypt', 'wrong-appid', encryptedFile, wrongKeyOutput], quiet), 1);
  assert(!fs.existsSync(wrongKeyOutput));
  assert.equal(main(['unpack', decryptedFile, path.join(temp, 'cli-unpacked')], quiet), 0);
  assert.equal(main(['unpack'], quiet), 1);

  function rejectsWithoutOutput(data, pattern = /wxapkg|index|path|filename|body|conflict|duplicate/i) {
    const destination = path.join(temp, `rejected-${rejected++}`, 'out');
    assert.throws(() => unpack(data, destination), pattern);
    assert(!fs.existsSync(path.dirname(destination)), 'failed preflight must not create any output directories');
  }
  function mutated(change) {
    const copy = Buffer.from(plain);
    change(copy);
    return copy;
  }
  for (const data of [Buffer.alloc(0), plain.subarray(0, 13), plain.subarray(0, 17), plain.subarray(0, plain.length - 1)]) {
    rejectsWithoutOutput(data);
  }
  rejectsWithoutOutput(mutated((buf) => { buf[0] = 0; }));
  rejectsWithoutOutput(mutated((buf) => { buf[13] = 0; }));
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(3, 5)));
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(0xffffffff, 5)));
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(0xffffffff, 9)));
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(0xffffffff, 14)));
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(1, 14)), /index/);
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(0, 18)), /filename/);
  rejectsWithoutOutput(mutated((buf) => buf.writeUInt32BE(0xffffffff, 18)), /filename/);
  rejectsWithoutOutput(mutated((buf) => { buf[22] = 0xff; }), /UTF-8/);
  rejectsWithoutOutput(mutated((buf) => {
    const entry = entryOffset(buf, 1);
    buf.writeUInt32BE(14, entry + 4 + buf.readUInt32BE(entry));
  }), /body/);
  rejectsWithoutOutput(mutated((buf) => {
    const entry = entryOffset(buf, 1);
    buf.writeUInt32BE(0xffffffff, entry + 8 + buf.readUInt32BE(entry));
  }), /body/);
  rejectsWithoutOutput(mutated((buf) => {
    const entry = entryOffset(buf, 2);
    buf.writeUInt32BE(buf.length + 1, entry + 4 + buf.readUInt32BE(entry));
  }), /body/);
  for (const name of [
    '../escape', '/nested/../../escape', '..\\escape', 'nested\\..\\escape',
    'C:/escape', '/C:/escape', '//server/share:stream', '/safe.txt:stream',
    '/bad\0name', '/bad?.txt', '/trailing. /a', '/trailing./a', '/CON.txt', '/nul', '/',
  ]) rejectsWithoutOutput(archive([['/first-valid.txt', 'untouched'], [name, 'reject']]));
  for (const names of [['/same.txt', 'same.txt'], ['/Case.txt', '/case.txt'], ['/a', '/a/b'], ['/a/b', '/a']]) {
    rejectsWithoutOutput(archive(names.map((name) => [name, 'fixture'])));
  }

  const existing = path.join(temp, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep existing bytes');
  assert.throws(() => unpack(archive([['/new.txt', 'new'], ['/keep.txt', 'replace']]), existing), /overwrite/);
  assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep existing bytes');
  assert(!fs.existsSync(path.join(existing, 'new.txt')), 'existing-file preflight occurs before any write');
  fs.writeFileSync(path.join(existing, 'parent-is-file'), 'keep');
  assert.throws(() => unpack(archive([['/parent-is-file/child', 'reject']]), existing), /directory/);

  const linkTarget = path.join(temp, 'link-target');
  fs.mkdirSync(linkTarget);
  const linkedRoot = path.join(temp, 'linked-root');
  fs.symlinkSync(linkTarget, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => unpack(plain, linkedRoot), /symlink/);
  assert.deepEqual(fs.readdirSync(linkTarget), []);
  fs.symlinkSync(linkTarget, path.join(existing, 'linked-parent'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => unpack(archive([['/linked-parent/child', 'reject']]), existing), /symlink/);
  assert.deepEqual(fs.readdirSync(linkTarget), []);

  console.log(`wxapkg selftest passed: encrypted/plain roundtrips, import-safe CLI, ${rejected} malformed archives, no-overwrite and symlink protection`);
} finally {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('cw-wxapkg-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

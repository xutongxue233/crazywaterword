import fs from 'node:fs';
import path from 'node:path';
import { decrypt, inspectArchive } from '../tools/wxapkg.mjs';

export const PROTO_BUNDLE = path.resolve(import.meta.dirname, '../work/extracted/_src_chunks_/src/chunks/game.js');
const APPID = 'wx2ea52a972ea18e5e';

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function cachedPackage() {
  if (!process.env.APPDATA) return;
  const users = path.join(process.env.APPDATA, 'Tencent/xwechat/radium/users');
  const candidates = [];
  for (const user of directories(users)) {
    const root = path.join(users, user, 'applet/packages', APPID);
    for (const version of directories(root).filter(name => /^\d+$/.test(name))) {
      const file = path.join(root, version, '_src_chunks_.wxapkg');
      if (fs.existsSync(file)) candidates.push({ version: Number(version), file });
    }
  }
  return candidates.sort((a, b) => b.version - a.version)[0]?.file;
}

export function readProtocolSource(bundlePath) {
  const file = bundlePath || process.env.CW_PROTO_BUNDLE ||
    (fs.existsSync(PROTO_BUNDLE) ? PROTO_BUNDLE : cachedPackage());
  if (!file) throw new Error('缺少协议文件。请在电脑版微信打开《疯狂水世界》并进入游戏，或设置 CW_PROTO_BUNDLE 指向自己的 _src_chunks_.wxapkg 或解包后的 src/chunks/game.js。');
  const input = fs.readFileSync(file);
  if (!/\.wxapkg$/i.test(file)) return input.toString('utf8');
  const { data } = decrypt(APPID, input);
  const entry = inspectArchive(data).files.find(item => item.relativePath === 'src/chunks/game.js');
  if (!entry) throw new Error(file + ' 中缺少 src/chunks/game.js，请使用 _src_chunks_.wxapkg');
  return data.toString('utf8', entry.off, entry.off + entry.size);
}

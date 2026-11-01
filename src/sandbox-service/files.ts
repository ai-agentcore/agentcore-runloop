// Run this helper INSIDE the same native OS sandbox as commands. Parent-side
// realpath checks alone cannot protect against a concurrent symlink replacement.
export const FILE_HELPER = `
const fs = require('node:fs');
const path = require('node:path');
const [op, name] = process.argv.slice(1);
try {
  if (path.isAbsolute(name) || name.split(/[\\\\/]/).some(p => p === '..') || name.includes('\\0')) throw 0;
  const parts = name.split('/').filter(p => p && p !== '.');
  let current = process.cwd();
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw 0; }
    catch (e) { if (!(op === 'write' && i === parts.length - 1 && e.code === 'ENOENT')) throw e; }
  }
  if (op === 'read') {
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw 0;
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let n = 0;
    while (n < buffer.length) {
      const read = fs.readSync(fd, buffer, n, buffer.length - n, n);
      if (!read) break;
      n += read;
    }
    if (n > 8 * 1024 * 1024) throw 0;
    process.stdout.write(buffer.subarray(0, n));
    fs.closeSync(fd);
  } else if (op === 'write') {
    const data = fs.readFileSync(0);
    if (data.length > 8 * 1024 * 1024) throw 0;
    const fd = fs.openSync(current, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, data); fs.closeSync(fd);
  } else if (op === 'list') {
    const names = fs.readdirSync(current, {withFileTypes:true});
    if (names.length > 10000) throw 0;
    process.stdout.write(JSON.stringify(names.map(e => ({name:e.name, type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file'}))));
  } else throw 0;
} catch { process.stderr.write('FILE_OPERATION_FAILED'); process.exitCode = 1; }
`;

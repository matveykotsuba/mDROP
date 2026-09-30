// Упаковка утверждённого оригинала через Electron из devDependencies.
const fs = require('fs');
const path = require('path');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
try {
  const root = path.resolve(__dirname, '..');
  const source = electron.nativeImage.createFromPath(path.join(root, 'build/icon-source.png'));
  if (source.isEmpty()) throw new Error('Не найден build/icon-source.png');
  const png = size => source.resize({ width: size, height: size, quality: 'best' }).toPNG();
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    header[entry] = sizes[i] === 256 ? 0 : sizes[i];
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  const ico = Buffer.concat([header, ...images]);
  fs.mkdirSync(path.join(root, 'public/icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/icon.ico'), ico);
  fs.writeFileSync(path.join(root, 'build/icon.png'), png(512));
  fs.writeFileSync(path.join(root, 'public/favicon.ico'), ico);
  for (const size of [32, 64, 180, 192, 512]) fs.writeFileSync(path.join(root, `public/icons/mdrop-${size}.png`), png(size));
  console.log('Иконки с M: Windows 16–256, Electron 512, web 32/64/180/192/512.');
  electron.app.exit(0);
} catch (err) { console.error(err); electron.app.exit(1); }

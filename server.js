const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pipeline } = require('stream/promises');
const { networkInfo, lanAddress } = require('./network');

const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function safeName(raw) {
  let name = path.win32.basename(raw).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim();
  name = name.slice(0, 180).replace(/[\uD800-\uDBFF]$/u, '').replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') return null;
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) || name.startsWith('.part-')) name = '_' + name;
  return name;
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    function onData(chunk) {
      size += chunk.length;
      if (size > 128 * 1024) {
        chunks.length = 0;
        req.removeListener('data', onData);
        req.resume();
        reject(Object.assign(new Error('Заметка слишком большая'), { status: 413 }));
      } else chunks.push(chunk);
    }
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('Передача прервана')));
  });
}

// dataRoot — где лежат drops/ и data/ (в Electron это Документы\mDrop)
function startServer({ port = Number(process.env.PORT) || 8765, dataRoot = __dirname } = {}) {
  const DROPS = path.join(dataRoot, 'drops');
  const DATA = path.join(dataRoot, 'data');
  const NOTES_FILE = path.join(DATA, 'notes.json');
  let publicPort = port;

  fs.mkdirSync(DROPS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  let notes = [];
  try {
    notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    if (!Array.isArray(notes) || notes.some((n) => !n || typeof n.id !== 'string' || typeof n.text !== 'string' || !Number.isFinite(n.time))) {
      throw new Error('Некорректный формат заметок');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${NOTES_FILE}. Файл сохранён без изменений. ${err.message}`);
  }

  function saveNotes(next) {
    const tmp = NOTES_FILE + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', flush: true });
      fs.renameSync(tmp, NOTES_FILE);
      notes = next;
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  // --- SSE: живые обновления на всех устройствах ---
  const sseClients = new Set();

  function broadcast(type) {
    const msg = `data: ${JSON.stringify({ type })}\n\n`;
    for (const res of sseClients) { if (!res.write(msg)) res.destroy(); }
  }

  // Если файл с таким именем уже есть — добавляет суффикс -1, -2, ...
  const reservedNames = new Set();
  function uniqueName(name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let n = 1; reservedNames.has(candidate.toLowerCase()) || fs.existsSync(path.join(DROPS, candidate)); n++) {
      candidate = `${base}-${n}${ext}`;
    }
    reservedNames.add(candidate.toLowerCase());
    return candidate;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (['POST', 'DELETE'].includes(req.method) &&
          ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')) {
        req.resume();
        return sendJSON(res, 403, { error: 'Открой mDrop напрямую, чтобы изменять файлы и заметки' });
      }
      // --- API ---
      if (p === '/api/info' && req.method === 'GET') {
        return sendJSON(res, 200, { app: 'mdrop', version: require('./package.json').version, host: os.hostname(), url: `http://${lanAddress()}:${publicPort}` });
      }

      if (p === '/api/qr' && req.method === 'GET') {
        const network = networkInfo();
        const candidates = network.candidates.map((a) => ({ ...a, url: `http://${a.address}:${publicPort}` }));
        const address = url.searchParams.get('address');
        if (address && !candidates.some((a) => a.address === address)) return sendJSON(res, 400, { error: 'Этот адрес сейчас недоступен в локальной сети. Обнови список.' });
        const link = (candidates.find((a) => a.address === address) || candidates[0])?.url || null;
        const qr = link ? await QRCode.toDataURL(link, { margin: 1, width: 480 }) : null;
        return sendJSON(res, 200, { url: link, qr, urls: candidates.map((a) => a.url), candidates, excluded: network.excluded });
      }

      if (p === '/api/files' && req.method === 'GET') {
        const entries = await fsp.readdir(DROPS, { withFileTypes: true });
        const files = [];
        for (const e of entries) {
          if (!e.isFile() || e.name.startsWith('.part-')) continue;
          let st;
          try { st = await fsp.stat(path.join(DROPS, e.name)); }
          catch (err) { if (err.code === 'ENOENT') continue; throw err; }
          files.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        return sendJSON(res, 200, files);
      }

      if (p === '/api/upload' && req.method === 'POST') {
        const raw = decodeURIComponent(req.headers['x-filename'] || '');
        const name = safeName(raw);
        if (!name) { req.resume(); return sendJSON(res, 400, { error: 'Некорректное имя файла' }); }
        const final = uniqueName(name);
        const tmp = path.join(DROPS, `.part-${crypto.randomBytes(6).toString('hex')}`);
        const out = fs.createWriteStream(tmp, { flags: 'wx' });
        try {
          await pipeline(req, out);
          await fsp.rename(tmp, path.join(DROPS, final));
        } catch (err) {
          await fsp.rm(tmp, { force: true });
          throw err;
        } finally { reservedNames.delete(final.toLowerCase()); }
        broadcast('files');
        return sendJSON(res, 200, { name: final });
      }

      if (p.startsWith('/api/file/')) {
        const name = decodeURIComponent(p.slice('/api/file/'.length));
        if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f:*?"<>|]/.test(name) || name.startsWith('.part-')) return sendJSON(res, 400, { error: 'Некорректное имя' });
        const file = path.join(DROPS, name);
        const st = await fsp.lstat(file);
        if (!st.isFile()) return sendJSON(res, 404, { error: 'Файл не найден' });

        if (req.method === 'DELETE') {
          await fsp.rm(file);
          broadcast('files');
          return sendJSON(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': st.size,
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          });
          await pipeline(fs.createReadStream(file), res);
          return;
        }
      }

      if (p === '/api/notes') {
        if (req.method === 'GET') return sendJSON(res, 200, notes);
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          if (typeof body?.text !== 'string' || !body.text.trim()) return sendJSON(res, 400, { error: 'Нужна непустая текстовая заметка' });
          if (body.text.length > 20000) return sendJSON(res, 413, { error: 'Заметка не должна превышать 20 000 символов' });
          saveNotes([{ id: crypto.randomUUID(), text: body.text.trim(), time: Date.now() }, ...notes]);
          broadcast('notes');
          return sendJSON(res, 200, { ok: true });
        }
      }

      if (p.startsWith('/api/notes/') && req.method === 'DELETE') {
        const id = p.slice('/api/notes/'.length);
        saveNotes(notes.filter((n) => n.id !== id));
        broadcast('notes');
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"hello"}\n\n');
        sseClients.add(res);
        // Пинг каждые 25с держит соединение живым и выявляет оборванные сокеты
        const ping = setInterval(() => { if (!res.write(': ping\n\n')) res.destroy(); }, 25000);
        res.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      // --- Статика ---
      if (req.method === 'GET') {
        const rel = p === '/' ? 'index.html' : p.slice(1);
        const file = path.normalize(path.join(PUBLIC, rel));
        if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          await pipeline(fs.createReadStream(file), res);
          return;
        }
      }

      sendJSON(res, 404, { error: 'Не найдено' });
    } catch (err) {
      const status = err.status || (err instanceof SyntaxError || err instanceof URIError ? 400 : err.code === 'ENOENT' ? 404 : 500);
      if (status === 500 && !req.destroyed) console.error(err);
      if (res.destroyed) return;
      if (!res.headersSent) sendJSON(res, status, { error: err.status ? err.message : status === 400 ? 'Некорректный запрос' : status === 404 ? 'Не найдено' : 'Ошибка сервера' });
      else res.destroy();
    }
  });

  // Большой файл может идти дольше пяти минут. Обрываем только простой.
  server.requestTimeout = 0;
  server.setTimeout(120000, (socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      publicPort = server.address().port;
      console.log(`mDrop запущен:`);
      console.log(`  на этом компьютере:  http://localhost:${publicPort}`);
      console.log(`  с других устройств:  http://${lanAddress()}:${publicPort}`);
      resolve(server);
    });
  });
}

module.exports = { startServer, lanAddress };

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? 'Порт уже занят — mDrop уже запущен?' : err);
    process.exit(1);
  });
}

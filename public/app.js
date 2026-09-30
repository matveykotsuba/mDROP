const $ = (id) => document.getElementById(id);

const ICONS = {
  image: '🖼️', video: '🎬', audio: '🎵', archive: '🗜️', doc: '📄', code: '⚙️', apk: '🤖',
};
const EXT_KIND = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', svg: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  pdf: 'doc', doc: 'doc', docx: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc', txt: 'doc',
  js: 'code', py: 'code', html: 'code', css: 'code', json: 'code',
  apk: 'apk',
};

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ICONS[EXT_KIND[ext]] || '📦';
}

function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' КБ';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' МБ';
  return (b / 1073741824).toFixed(2) + ' ГБ';
}

const timeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function fmtTime(ms) { return timeFormat.format(ms); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2500);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); toast('Скопировано ✓'); return; } catch {}
  }
  // На http://<ip> clipboard API недоступен — фолбэк через textarea
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  ta.remove();
  toast(copied ? 'Скопировано ✓' : 'Не удалось скопировать. Выдели текст и скопируй вручную.');
}

async function api(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Ошибка сервера');
  return body;
}

function showError(err) {
  toast(err instanceof TypeError || err.name === 'TimeoutError' ? 'Нет связи с компьютером. Проверь Wi-Fi и доступ к локальной сети в VPN.' : err.message);
}

// Один запрос за раз; события во время запроса объединяются в одно обновление.
function listLoader(load) {
  let running = null;
  let dirty = false;
  function refresh() {
    dirty = true;
    if (running) return running;
    if (document.hidden) return Promise.resolve();
    running = (async () => {
      try {
        while (dirty && !document.hidden) { dirty = false; await load(); }
      } finally { running = null; }
    })();
    return running;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dirty) refresh(); });
  return refresh;
}

// Неизменённые строки сохраняют DOM, выделение текста и фокус кнопок.
async function updateList(list, data, keyOf, create) {
  const previous = new Map([...list.children].map(node => [node.dataset.key, node]));
  const next = [];
  let sliceStart = performance.now();
  for (const entry of data) {
    const key = keyOf(entry);
    const signature = JSON.stringify(entry);
    let node = previous.get(key);
    if (!node || node.dataset.signature !== signature) {
      node = create(entry);
      node.dataset.key = key;
      node.dataset.signature = signature;
    }
    next.push(node);
    // Большой первый список не блокирует ввод на всё время создания строк.
    if (performance.now() - sliceStart > 8) {
      await new Promise(resolve => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  const keep = new Set(next);
  for (const node of previous.values()) { if (!keep.has(node)) node.remove(); }
  let cursor = list.firstElementChild;
  for (const node of next) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(node, cursor);
  }
}

// --- Файлы ---
const loadFiles = listLoader(async () => {
  let files;
  try { files = await api('/api/files'); } catch (err) { showError(err); return; }
  $('files-count').textContent = files.length;
  $('files-empty').classList.toggle('hidden', files.length > 0);
  await updateList($('files'), files, f => f.name, (f) => {
    const li = document.createElement('li');
    li.className = 'file-item';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = fileIcon(f.name);

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const nm = document.createElement('div');
    nm.className = 'file-name';
    nm.textContent = f.name;
    const sub = document.createElement('div');
    sub.className = 'file-sub';
    sub.textContent = `${fmtSize(f.size)} · ${fmtTime(f.mtime)}`;
    meta.append(nm, sub);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const dl = document.createElement('a');
    dl.className = 'btn btn-icon';
    dl.href = '/api/file/' + encodeURIComponent(f.name);
    dl.title = 'Скачать';
    dl.textContent = '⬇️';

    const del = document.createElement('button');
    del.className = 'btn btn-icon';
    del.title = 'Удалить';
    del.textContent = '🗑️';
    del.onclick = async () => {
      if (!confirm(`Удалить «${f.name}»?`)) return;
      if (del.disabled) return;
      del.disabled = true;
      try { await api('/api/file/' + encodeURIComponent(f.name), { method: 'DELETE' }); await loadFiles(); }
      catch (err) { showError(err); }
      finally { del.disabled = false; }
    };

    actions.append(dl, del);
    li.append(icon, meta, actions);
    return li;
  });
});

// --- Загрузка с прогрессом ---
const uploadQueue = [];
let activeUploads = 0;
function pumpUploads() {
  while (activeUploads < 2 && uploadQueue.length) uploadQueue.shift()();
}

function uploadFile(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';
  item.innerHTML = '<div class="row"><span class="name"></span><span class="pct">В очереди</span><button class="btn btn-icon cancel" title="Отменить загрузку" aria-label="Отменить загрузку">×</button></div><div class="progress"><div></div></div>';
  item.querySelector('.name').textContent = file.name;
  $('upload-list').appendChild(item);
  const label = item.querySelector('.pct');
  const bar = item.querySelector('.progress > div');
  const xhr = new XMLHttpRequest();
  let started = false;
  let settled = false;
  let frame = 0;
  let percent = -1;
  function finish(message) {
    if (settled) return;
    settled = true;
    cancelAnimationFrame(frame);
    item.remove();
    if (started) activeUploads--;
    toast(message);
    pumpUploads();
  }
  item.querySelector('.cancel').onclick = (e) => {
    e.stopPropagation();
    if (started) xhr.abort();
    else {
      const index = uploadQueue.indexOf(startUpload);
      if (index !== -1) uploadQueue.splice(index, 1);
      finish('Загрузка отменена');
    }
  };
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable || settled) return;
    const value = Math.round((e.loaded / e.total) * 100);
    if (value === percent) return;
    percent = value;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      label.textContent = percent === 100 ? 'Сохранение…' : percent + '%';
      bar.style.transform = 'scaleX(' + percent / 100 + ')';
    });
  };
  xhr.onload = () => {
    if (xhr.status === 200) { finish('«' + file.name + '» загружен ✓'); reloadFiles(); }
    else {
      let message = 'Не удалось загрузить файл';
      try { message = JSON.parse(xhr.responseText).error || message; } catch {}
      finish(message);
    }
  };
  xhr.onerror = () => finish('Загрузка прервана. Проверь Wi-Fi и доступ к локальной сети в VPN, затем выбери файл снова.');
  xhr.onabort = () => finish('Загрузка отменена');
  function startUpload() {
    if (settled) return;
    started = true;
    activeUploads++;
    label.textContent = '0%';
    try {
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.send(file);
    } catch (err) { finish('Не удалось начать загрузку: ' + err.message); }
  }
  uploadQueue.push(startUpload);
  pumpUploads();
}

// --- Заметки ---
const loadNotes = listLoader(async () => {
  let notes;
  try { notes = await api('/api/notes'); } catch (err) { showError(err); return; }
  await updateList($('notes'), notes, n => n.id, (n) => {
    const li = document.createElement('li');
    li.className = 'note-item';

    const body = document.createElement('div');
    body.className = 'note-text';
    const txt = document.createElement('div');
    txt.textContent = n.text;
    const sub = document.createElement('div');
    sub.className = 'note-sub';
    sub.textContent = fmtTime(n.time);
    body.append(txt, sub);

    const copy = document.createElement('button');
    copy.className = 'btn btn-icon';
    copy.title = 'Копировать';
    copy.textContent = '📋';
    copy.onclick = () => copyText(n.text);

    const del = document.createElement('button');
    del.className = 'btn btn-icon';
    del.title = 'Удалить';
    del.textContent = '🗑️';
    del.onclick = async () => {
      if (!confirm('Удалить заметку?')) return;
      if (del.disabled) return;
      del.disabled = true;
      try { await api('/api/notes/' + n.id, { method: 'DELETE' }); await loadNotes(); }
      catch (err) { showError(err); }
      finally { del.disabled = false; }
    };

    li.append(body, copy, del);
    return li;
  });
});

async function sendNote() {
  const ta = $('note-text');
  if ($('note-send').disabled) return;
  const original = ta.value;
  const text = ta.value.trim();
  if (!text) return;
  $('note-send').disabled = true;
  $('note-send').textContent = 'Отправка…';
  try {
    await api('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (ta.value === original) ta.value = '';
    await loadNotes();
  } catch (err) { showError(err); }
  finally { $('note-send').disabled = false; $('note-send').textContent = 'Отправить'; }
}

// --- Инициализация ---
const dz = $('dropzone');
dz.onclick = (e) => { if (e.target !== $('file-input') && !e.target.closest('.upload-item')) $('file-input').click(); };
dz.addEventListener('keydown', (e) => {
  if (e.target === dz && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('file-input').click(); }
});
$('file-input').onchange = (e) => {
  [...e.target.files].forEach(uploadFile);
  e.target.value = '';
};
// Счётчик глубины: подсветка не мигает при перетаскивании над дочерними элементами
let dragDepth = 0;
dz.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) dz.classList.add('dragover'); });
dz.addEventListener('dragover', (e) => e.preventDefault());
dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('dragover'); } });
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove('dragover');
  [...e.dataTransfer.files].forEach(uploadFile);
});

$('note-send').onclick = sendNote;
$('note-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNote(); }
});

let qrRequest = 0;
async function loadQR(address = '') {
  const request = ++qrRequest;
  $('qr-img').classList.add('qr-loading');
  $('qr-url').textContent = 'Проверяем адреса…';
  $('qr-copy').disabled = true;
  try {
    const info = await api('/api/qr' + (address ? '?address=' + encodeURIComponent(address) : ''));
    if (request !== qrRequest) return;
    $('qr-network').replaceChildren(...info.candidates.map((a) => {
      const option = document.createElement('option');
      option.value = a.address;
      option.textContent = `${a.name} · ${a.address}`;
      option.selected = a.url === info.url;
      return option;
    }));
    $('qr-network').disabled = info.candidates.length < 2;
    if (info.qr) {
      const decoded = new Image();
      decoded.src = info.qr;
      try { await decoded.decode(); } catch {}
      if (request !== qrRequest) return;
      $('qr-img').src = info.qr;
      $('qr-img').classList.remove('qr-loading');
    }
    $('qr-url').textContent = info.url || 'Не найден адрес Wi-Fi или Ethernet. Подключи компьютер к домашней сети.';
    $('qr-copy').disabled = !info.url;
    $('qr-alts').textContent = info.excluded.length ? 'Исключены из QR: ' + info.excluded.map((a) => a.name).join(', ') : '';
  } catch (err) {
    if (request !== qrRequest) return;
    $('qr-url').textContent = 'Не удалось обновить адрес. Нажми «Обновить».';
    showError(err);
  }
}
let modalTransition = 0;
function animateModal(open) {
  const modal = $('qr-modal');
  const card = modal.querySelector('.modal-card');
  const transition = ++modalTransition;
  for (const element of [modal, card]) element.getAnimations().forEach(animation => animation.cancel());
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : open ? 160 : 120;
  if (open) { modal.classList.remove('hidden'); document.querySelector('main').inert = true; }
  const fade = modal.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration, easing: 'ease-out' });
  card.animate([{ transform: open ? 'translateY(8px)' : 'translateY(0)' }, { transform: open ? 'translateY(0)' : 'translateY(8px)' }], { duration, easing: 'ease-out' });
  if (!open) fade.finished.then(() => {
    if (transition !== modalTransition) return;
    modal.classList.add('hidden');
    document.querySelector('main').inert = false;
    $('qr-btn').focus();
  }).catch(() => {});
}
$('qr-btn').onclick = () => {
  animateModal(true);
  $('qr-close').focus();
  loadQR();
};
$('qr-network').onchange = () => loadQR($('qr-network').value);
$('qr-refresh').onclick = () => loadQR();
$('qr-copy').onclick = () => copyText($('qr-url').textContent);
function closeQR() { animateModal(false); }
$('qr-close').onclick = closeQR;
$('qr-modal').onclick = (e) => {
  if (e.target === $('qr-modal')) closeQR();
};
document.addEventListener('keydown', (e) => {
  if ($('qr-modal').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeQR();
  if (e.key === 'Tab') {
    const controls = [...$('qr-modal').querySelectorAll('button:not(:disabled), select:not(:disabled), summary')];
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

api('/api/info').then((i) => {
  $('host').textContent = `сервер: ${i.host}`;
}).catch(showError);

// Дебаунс: пачка событий (загрузка нескольких файлов) даёт одну перерисовку
const debounce = (fn, ms = 120) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const reloadFiles = debounce(loadFiles);
const reloadNotes = debounce(loadNotes);

let sseOpened = false;
const es = new EventSource('/api/events');
es.onmessage = (e) => {
  const { type } = JSON.parse(e.data);
  if (type === 'files') reloadFiles();
  if (type === 'notes') reloadNotes();
};
// Повторный onopen = переподключение (сон ноутбука, перезапуск сервера) → пересинхронизация
es.onopen = () => {
  $('connection').textContent = 'На связи';
  $('connection').classList.remove('offline');
  if (sseOpened) { loadFiles(); loadNotes(); }
  sseOpened = true;
};
es.onerror = () => {
  $('connection').textContent = 'Нет связи · переподключаемся…';
  $('connection').classList.add('offline');
};

loadFiles();
loadNotes();

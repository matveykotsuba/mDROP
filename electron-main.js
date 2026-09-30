const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');

const PORT = 8765;
const ICON = path.join(__dirname, 'build', 'icon.png');

let win = null;
let tray = null;
let quitting = false;

function formatError(err) {
  if (!err) return 'Unknown error';
  return err.stack || err.message || String(err);
}

function logMainError(err) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main-errors.log'), `[${new Date().toISOString()}]\n${formatError(err)}\n\n`);
  } catch {}
}

function isMissingTempHtml(err) {
  const message = formatError(err);
  const match = message.match(/open '([^']+\.tmp\.html)'/i);
  const file = err && err.path ? err.path : match && match[1];
  if (!file || !/\.tmp\.html$/i.test(file)) return false;
  try {
    const temp = path.resolve(app.getPath('temp')).toLowerCase();
    return path.resolve(file).toLowerCase().startsWith(temp + path.sep);
  } catch {
    return false;
  }
}

function handleMainError(err) {
  logMainError(err);
  if (isMissingTempHtml(err)) return;
  dialog.showErrorBox('mDrop', 'Ошибка приложения:\n' + formatError(err));
  app.exit(1);
}

process.on('uncaughtException', handleMainError);
process.on('unhandledRejection', handleMainError);

// Программный рендеринг в режиме автопроверки — capturePage стабильнее без GPU
if (process.env.MDROP_SHOT) app.disableHardwareAcceleration();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 760,
    height: 920,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: '#0a0a0a',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', showWindow);
  const localURL = `http://127.0.0.1:${PORT}`;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== localURL) event.preventDefault();
  });
  win.loadURL(localURL);

  // Крестик прячет в трей, приложение продолжает раздавать файлы
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Режим автопроверки: снять скриншот окна и выйти
  if (process.env.MDROP_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      console.log('MDROP_SHOT: страница загрузилась');
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const img = await win.capturePage();
          if (img.isEmpty()) throw new Error('пустой кадр');
          fs.writeFileSync(process.env.MDROP_SHOT, img.toPNG());
          console.log('MDROP_SHOT: скриншот сохранён');
          break;
        } catch (err) {
          console.log(`MDROP_SHOT: попытка ${i + 1} не удалась: ${err.message || err}`);
        }
      }
      app.exit(0);
    });
  }
}

function createTray(dataRoot) {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('mDrop — обмен файлами');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть mDrop', click: showWindow },
    { label: 'Папка с файлами', click: () => shell.openPath(path.join(dataRoot, 'drops')) },
    {
      type: 'checkbox',
      label: 'Запускать при входе в Windows',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    const dataRoot = path.join(app.getPath('documents'), 'mDrop');
    try {
      await startServer({ port: PORT, dataRoot });
    } catch (err) {
      dialog.showErrorBox('mDrop', err.code === 'EADDRINUSE'
        ? `Порт ${PORT} занят. Закрой другой экземпляр сервера (например, запущенный через start-mdrop.bat) и открой mDrop снова.`
        : 'Не удалось запустить сервер:\n' + err.message);
      app.exit(1);
      return;
    }
    createWindow();
    createTray(dataRoot);
  });
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {}); // живём в трее

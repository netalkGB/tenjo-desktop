const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cryptoModule = require('crypto');
const net = require('net');
const http = require('http');

// Single-user mode does not need real password hashing, so replace
// crypto.argon2 with a dummy implementation that satisfies the API contract.
function installDummyArgon2() {
  cryptoModule.argon2 = function argon2(_algorithm, options, callback) {
    const result = Buffer.alloc(options.tagLength || 32);
    if (callback) {
      process.nextTick(() => callback(null, result));
    } else {
      return result;
    }
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// tenjo server starts asynchronously via IIFE on require(), so it may not
// be listening yet when require() returns. Poll until the port accepts
// connections before opening the BrowserWindow.
function waitForTenjoServer(port, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 200);
        }
      });
    };
    check();
  });
}

// Localization: Japanese if system locale starts with 'ja', English otherwise
const i18n = {
  ja: {
    file: 'ファイル', edit: '編集', view: '表示', window: 'ウインドウ',
    closeWindow: 'ウインドウを閉じる',
    undo: '取り消す', redo: 'やり直す', cut: 'カット', copy: 'コピー',
    paste: 'ペースト', selectAll: 'すべてを選択',
  },
  en: {
    file: 'File', edit: 'Edit', view: 'View', window: 'Window',
    closeWindow: 'Close Window',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy',
    paste: 'Paste', selectAll: 'Select All',
  },
};

function t(key) {
  const lang = app.getLocale().startsWith('ja') ? 'ja' : 'en';
  return i18n[lang][key] || key;
}

// Application menu (visible on macOS, hidden on Windows/Linux)
function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: t('file'),
      submenu: [
        { label: t('closeWindow'), role: 'close' },
      ],
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: t('view'),
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: t('window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

installDummyArgon2();

let mainWindow = null;
let embeddedPg = null;
let tenjoServer = null;
let socketDir = null;
let isQuitting = false;

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Suppress pg connection errors during shutdown
process.on('uncaughtException', (err) => {
  if (isQuitting && err.message && err.message.includes('terminating connection')) {
    return;
  }
  throw err;
});

// Intercept http.Server.listen to capture the tenjo server instance
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  tenjoServer = this;
  http.Server.prototype.listen = originalListen;
  return originalListen.apply(this, args);
};

app.whenReady().then(async () => {
  buildAppMenu();
  try {
    // Determine persistent data directory
    const userData = app.getPath('userData');

    // Generate or load session secret
    const secretPath = path.join(userData, '.session-secret');
    let sessionSecret;
    try {
      sessionSecret = fs.readFileSync(secretPath, 'utf-8');
    } catch {
      sessionSecret = cryptoModule.randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
    }

    // Prepare embedded PostgreSQL directories
    const isWindows = process.platform === 'win32';
    const pgDataDir = path.join(userData, 'pgdata');
    if (!isWindows) {
      socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenjo-'));
    }

    // Find free ports
    const pgPort = await findFreePort();
    const tenjoPort = await findFreePort();

    // Ephemeral password: random on every launch, never written to disk.
    // pg_hba.conf is temporarily set to trust at startup so we can issue
    // ALTER USER to install the new password, then reverted to scram-sha-256.
    const pgPassword = cryptoModule.randomBytes(32).toString('hex');

    // Set environment variables for tenjo server
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = isWindows
      ? `postgresql://postgres:${pgPassword}@127.0.0.1:${pgPort}/tenjo`
      : `postgresql://postgres:${pgPassword}@localhost/tenjo?host=${socketDir}&port=${pgPort}`;
    process.env.DATABASE_SCHEMA = 'tenjo';
    process.env.SESSION_SECRET = sessionSecret;
    process.env.LISTEN_HOST = '127.0.0.1';
    process.env.LISTEN_PORT = String(tenjoPort);
    process.env.SINGLE_USER_MODE = 'true';
    const dataDir = path.join(userData, 'tenjo-server-data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    // Start embedded PostgreSQL (dynamic import for ESM package)
    // Windows does not support Unix domain sockets — listen on TCP only
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const postgresFlags = isWindows
      ? ['-h', '127.0.0.1']
      : ['-k', socketDir, '-h', ''];
    embeddedPg = new EmbeddedPostgres({
      databaseDir: pgDataDir,
      port: pgPort,
      user: 'postgres',
      password: pgPassword,
      persistent: true,
      postgresFlags,
    });

    const pgVersionPath = path.join(pgDataDir, 'PG_VERSION');
    const pgHbaPath = path.join(pgDataDir, 'pg_hba.conf');

    if (!fs.existsSync(pgVersionPath)) {
      await embeddedPg.initialise();
    }
    // Trust only postgres@postgres for the admin connection; tenjo database stays scram-sha-256.
    // Both local and host rules are written on all platforms; unreachable rules are harmless.
    fs.writeFileSync(pgHbaPath, [
      'local   postgres        postgres                                trust',
      'host    postgres        postgres        127.0.0.1/32            trust',
      'local   all             all                                     scram-sha-256',
      'host    all             all             127.0.0.1/32            scram-sha-256',
      'host    all             all             ::1/128                 scram-sha-256',
    ].join('\n') + '\n');
    await embeddedPg.start();

    // Connect via trust (postgres@postgres only), install ephemeral password, lock down
    {
      const { Client } = require(path.join(__dirname, 'tenjo', 'node_modules', 'pg'));
      const pgAdmin = new Client(isWindows
        ? { host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres' }
        : { host: socketDir, port: pgPort, user: 'postgres', database: 'postgres' });
      await pgAdmin.connect();
      await pgAdmin.query(`ALTER USER postgres PASSWORD '${pgPassword}'`);
      // Lock down: scram-sha-256 for all connections
      fs.writeFileSync(pgHbaPath, [
        'local   all             all                                     scram-sha-256',
        'host    all             all             127.0.0.1/32            scram-sha-256',
        'host    all             all             ::1/128                 scram-sha-256',
      ].join('\n') + '\n');
      await pgAdmin.query('SELECT pg_reload_conf()');
      await pgAdmin.end();
    }

    // Require tenjo server (triggers auto-start via its IIFE)
    require('./tenjo/server/dist/index.js');

    // Wait for the tenjo server to be ready
    await waitForTenjoServer(tenjoPort);

    // Create BrowserWindow (restore previous position/size)
    const windowStateKeeper = require('electron-window-state');
    const windowState = windowStateKeeper({
      defaultWidth: 1200,
      defaultHeight: 750,
    });

    mainWindow = new BrowserWindow({
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height,
      minWidth: 480,
      minHeight: 400,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    windowState.manage(mainWindow);
    mainWindow.loadURL(`http://127.0.0.1:${tenjoPort}`);

    // Disable reload (Cmd+R, Ctrl+R, F5, Cmd+Shift+R)
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      if ((input.control || input.meta) && key === 'r') {
        event.preventDefault();
      }
      if (key === 'f5') {
        event.preventDefault();
      }
    });
    mainWindow.webContents.reload = () => {};
    mainWindow.webContents.reloadIgnoringCache = () => {};

    // Prevent dragging links and images
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.insertCSS('a, img { -webkit-user-drag: none !important; user-drag: none !important; }');
      mainWindow.webContents.executeJavaScript(`
        document.addEventListener('dragstart', (e) => {
          if (e.target.tagName === 'A' || e.target.tagName === 'IMG' || e.target.closest('a')) {
            e.preventDefault();
          }
        }, true);
      `);
    });

    // Right-click context menu
    mainWindow.webContents.on('context-menu', (_event, params) => {
      const items = [];
      if (params.isEditable) {
        items.push(
          { label: t('undo'), role: 'undo' },
          { label: t('redo'), role: 'redo' },
          { type: 'separator' },
          { label: t('cut'), role: 'cut' },
          { label: t('copy'), role: 'copy' },
          { label: t('paste'), role: 'paste' },
          { type: 'separator' },
          { label: t('selectAll'), role: 'selectAll' },
        );
      } else if (params.selectionText) {
        items.push(
          { label: t('copy'), role: 'copy' },
          { type: 'separator' },
          { label: t('selectAll'), role: 'selectAll' },
        );
      }
      if (items.length > 0) {
        Menu.buildFromTemplate(items).popup({ window: mainWindow });
      }
    });

    // Block navigation away from the local server
    const allowedOrigin = `http://127.0.0.1:${tenjoPort}`;
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(allowedOrigin)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    // Block new windows (middle-click, target="_blank", window.open) —
    // open external URLs in the system browser, discard local ones
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(allowedOrigin)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    process.stderr.write(`Failed to start: ${err && err.stack ? err.stack : String(err)}\n`);
    app.quit();
  }
});

// Quit when all windows are closed (except on macOS where apps stay in Dock)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS: re-create window when Dock icon is clicked and no windows exist
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
    const tenjoPort = process.env.LISTEN_PORT;
    if (tenjoPort) {
      const windowStateKeeper = require('electron-window-state');
      const windowState = windowStateKeeper({
        defaultWidth: 1200,
        defaultHeight: 750,
      });
      mainWindow = new BrowserWindow({
        x: windowState.x,
        y: windowState.y,
        width: windowState.width,
        height: windowState.height,
        minWidth: 480,
        minHeight: 400,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      windowState.manage(mainWindow);
      mainWindow.loadURL(`http://127.0.0.1:${tenjoPort}`);
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    }
  }
});

// Graceful shutdown: Express server -> PostgreSQL -> cleanup
app.on('before-quit', async (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();

  if (tenjoServer) {
    await new Promise((resolve) => tenjoServer.close(resolve));
  }

  if (embeddedPg) {
    try {
      await embeddedPg.stop();
    } catch {
      // Ignore shutdown errors
    }
  }

  // Remove temporary socket directory
  if (socketDir) {
    try {
      fs.rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  app.exit(0);
});

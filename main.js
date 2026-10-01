/* Pink Pony launcher — main process.
 *
 * WHAT IS REAL AND WHAT IS NOT, as of right now:
 *
 *   real   the window, the IPC plumbing, the account store
 *   STUB   signing in, and launching the game
 *
 * The two stubs are marked and both throw rather than pretending. That is
 * deliberate - a launcher that silently does nothing when you press Play is
 * harder to debug than one that says which piece is missing.
 *
 * To make them real:
 *
 *   npm i msmc minecraft-launcher-core
 *
 * msmc does the Microsoft side. It needs an Azure app registration with the
 * Minecraft scopes, which Microsoft has to approve before third party login
 * works at all - that is a form and a wait, not something code can skip.
 *
 * minecraft-launcher-core downloads the version manifest, libraries, assets
 * and natives and builds the java command line. Fabric is installed on top and
 * our mod jar dropped into the profile's mods folder.
 */
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const STORE = path.join(app.getPath('userData'), 'account.json');
let win = null;

function createWindow() {
  win = new BrowserWindow({
    // The layout is a 240px rail + main + a 396px right column, and the
    // featured-servers row is five across. Below ~1400 the right column starts
    // eating the servers, so that is the floor rather than a taste call.
    width: 1500,
    height: 920,
    minWidth: 1400,
    minHeight: 760,
    backgroundColor: '#08070C',
    // Our own title bar, so the window matches the rest of the app rather
    // than wearing Windows' one.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/*
 * ONE LAUNCHER AT A TIME.
 *
 * There was no single-instance lock, so double-clicking the shortcut while the
 * launcher sat hidden behind a running game started a SECOND launcher: its own
 * update check, its own download, and an installer trying to replace files the
 * first copy still had open. A second start now just brings the first window
 * back - and asks GitHub again, because "I opened it to see if there's an
 * update" is exactly why people do that.
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    checkForUpdate('second-instance');
  });
  app.whenReady().then(() => { createWindow(); startUpdates(); });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ============================ auto update ============================
 *
 * THIS DID NOT EXIST, WHICH IS WHY NOTHING EVER UPDATED.
 *
 * electron-updater has been in `dependencies` since the launcher was set up
 * and `publish` has always pointed at the releases repo, so every `npm run
 * release` really did put a signed installer and a latest.yml on GitHub. The
 * one thing missing was anybody asking for it: the package was never required
 * and autoUpdater was never called. The feed was live and had no reader.
 *
 * That is the whole reason for "I think I'm on 1.1.1" - not a bad release, not
 * a draft, not a token. Every copy anyone installed stayed on whatever version
 * they first ran, forever, and the only way to move was to download the setup
 * by hand.
 *
 * ONLY WHEN PACKAGED. In dev there is no app-update.yml next to the binary and
 * electron-updater throws on the spot. Guarding on app.isPackaged means `npm
 * start` still works instead of dying at launch.
 */
function updateSay(state, extra = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', { state, ...extra });
}

function startUpdates() {
  if (!app.isPackaged) {
    updateSay('dev');
    return;
  }

  // Download on its own and install on its own - with ONE exception: never
  // while the game is running. The launcher is still open behind a running
  // game (it has to be, to see it close), and an installer that restarts it
  // then would pull the rug out from under a session. So an update that
  // lands mid-game waits for the game to close, then installs.
  //
  // This used to ask first ("Restart now / Later"). Everybody clicked Later,
  // and "Later" meant "whenever you next fully quit", which for a launcher
  // that lives in the tray was never - so a 26.3 fix could sit downloaded
  // and uninstalled for days.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => updateSay('checking'));
  autoUpdater.on('update-not-available', (i) => updateSay('current', { version: i?.version }));
  autoUpdater.on('update-available',     (i) => updateSay('found',   { version: i?.version }));
  autoUpdater.on('download-progress', (p) =>
    updateSay('downloading', { percent: Math.round(p?.percent || 0) }));

  autoUpdater.on('error', (err) => {
    // Never fatal. A launcher that will not start because GitHub is having a
    // bad morning is worse than a launcher on last week's build.
    updateSay('error', { message: String(err && err.message ? err.message : err) });
    // One retry, a few minutes on - a flaky connection at startup used to
    // mean no update until the next restart.
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; lastUpdateCheck = 0; checkForUpdate('retry'); },
                              5 * 60 * 1000);
    }
  });

  autoUpdater.on('update-downloaded', (i) => {
    updateWaiting = i?.version || 'new';
    if (gameRunning) {
      updateSay('ready', { version: i?.version, waiting: true });
      return;                               // the game's 'close' handler installs it
    }
    installUpdate();
  });

  // THE CHECK USED TO HAPPEN ONCE, at startup, and never again. A launcher
  // left open all evening - hidden behind the game, shown again when it
  // closes - never heard about a release that went out after it started, so
  // the only way to get one was Settings > Check now. It now asks:
  //   - when the page has loaded (so the Settings row shows the answer),
  //   - every 30 minutes while it is open,
  //   - every time a game closes (the launcher is being looked at again),
  //   - when somebody opens it a second time,
  //   - 5 minutes after a failed check, once.
  autoUpdater.logger = updateLog;
  win?.webContents.once('did-finish-load', () => checkForUpdate('start'));
  setTimeout(() => checkForUpdate('start-fallback'), 15000);
  setInterval(() => checkForUpdate('timer'), 30 * 60 * 1000);
}

let lastUpdateCheck = 0;
let retryTimer = null;

/* Throttled to one real request a minute, whoever asks. */
function checkForUpdate(why) {
  if (!app.isPackaged || updateWaiting) return;
  if (Date.now() - lastUpdateCheck < 60 * 1000) return;
  lastUpdateCheck = Date.now();
  updateLog.info(`check (${why})`);
  autoUpdater.checkForUpdates().catch(() => { /* the error handler already said so */ });
}

/*
 * What the updater did, in userData/updater.log. "It didn't update" is not
 * something anybody can debug from a screenshot; this says whether it asked,
 * what GitHub answered and why a download failed. Nothing secret goes through
 * electron-updater - the feed is a public release. Capped at 256 KB.
 */
const UPDATE_LOG = path.join(app.getPath('userData'), 'updater.log');
function updateLine(level, args) {
  try {
    try { if (fs.statSync(UPDATE_LOG).size > 256 * 1024) fs.writeFileSync(UPDATE_LOG, ''); } catch { /* no file yet */ }
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    fs.appendFileSync(UPDATE_LOG, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch { /* logging must never break updating */ }
}
const updateLog = {
  info:  (...a) => updateLine('info', a),
  warn:  (...a) => updateLine('warn', a),
  error: (...a) => updateLine('error', a),
  debug: () => {}
};

/* Set once an update has downloaded; cleared only by the restart itself. */
let updateWaiting = '';

/*
 * Silent (no installer window - it is a one-click NSIS install anyway) and
 * relaunch afterwards, so from the player's side the launcher blinks and comes
 * back on the new version. The short pause is so the "Updating…" line is
 * actually seen rather than the window vanishing with no explanation.
 */
function installUpdate() {
  if (!updateWaiting) return;
  updateSay('installing', { version: updateWaiting });
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 1500);
}

ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  try {
    lastUpdateCheck = Date.now();
    updateLog.info('check (button)');
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version || '' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('update-install', () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  if (gameRunning) return { ok: false, reason: 'Close the game first.' };
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
});

ipcMain.on('win', (_e, what) => {
  if (!win) return;
  if (what === 'min') win.minimize();
  else if (what === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (what === 'close') win.close();
});

/*
 * Links go to the system browser, never into this window.
 *
 * The allowlist is not paranoia for its own sake: the renderer builds some of
 * what it shows from remote data, so "open whatever string you are given"
 * would eventually mean opening a string somebody else chose. file:// URLs in
 * particular would run in Electron's own context.
 */
const OPENABLE = /^https:\/\/(discord\.gg|discord\.com|(www\.)?pinkponyclient\.com|(www\.)?youtube\.com|x\.com|(www\.)?tiktok\.com)\//i;

ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && OPENABLE.test(url)) shell.openExternal(url);
});

// ---- modules ------------------------------------------------------------
/*
 * The Mods page edits a file the GAME writes.
 *
 * The client declares what modules exist and rewrites modules.json on every
 * startup; this side changes only the enabled flags and writes it back. That
 * is why there is no module list in the launcher's JavaScript - a second list
 * here would drift from the jar within a week and start offering toggles for
 * modules that do not exist.
 *
 * Consequence worth knowing: the page is empty until the game has been run
 * once, because until then there is no manifest. The page says so rather than
 * looking broken.
 */
/*
 * Which modules.json: the ACTIVE PROFILE's. This used to read
 * .minecraft/config/pinkpony, from before the launcher had its own folder and
 * profiles - a file no Pink Pony game has written since, so the Mods page was
 * showing, and toggling, a stale copy the game never read.
 */
const MODULES = () => path.join(profileDir(), 'config', 'pinkpony', 'modules.json');

ipcMain.handle('mods-read', async () => {
  try {
    return JSON.parse(fs.readFileSync(MODULES(), 'utf8'));
  } catch (e) {
    // No file is the normal state before the first run, not an error.
    return { format: 0, modules: [], missing: true };
  }
});

ipcMain.handle('mods-write', async (_e, enabled) => {
  // `enabled` is {id: bool} and nothing else. Taking the whole document from
  // the renderer would let a bug there rewrite names and descriptions the
  // client owns - so the file is re-read and only the flags are touched.
  if (!enabled || typeof enabled !== 'object') throw new Error('bad payload');

  const file = MODULES();
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.modules)) throw new Error('manifest has no modules');

  for (const m of doc.modules) {
    if (Object.prototype.hasOwnProperty.call(enabled, m.id)) m.enabled = !!enabled[m.id];
  }

  // Write beside it and rename, so the game reading this at the wrong moment
  // sees the old file whole rather than half of the new one.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return true;
});

// ---- settings ------------------------------------------------------------
/*
 * Kept in the launcher's own userData folder, not in .minecraft. These are
 * settings for the LAUNCHER - which java to use, how much memory to hand the
 * game - and putting them inside a game directory the player might delete,
 * move or reinstall would lose them for no reason.
 *
 * The access code lives here too. It is stored in the clear, which is fine for
 * what it is: a licence key that is already sitting in plaintext in the game's
 * own config, and that the server can revoke. It is NOT a password and must
 * never be treated as somewhere to put one.
 */
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');

/*
 * Our own folder, the way Lunar and Orbit do it.
 *
 * ~/.pinkpony rather than the shared .minecraft. Three reasons, and the third
 * is the one that bites:
 *
 *   - our mods, our versions, our logs; nothing of ours lands in a folder the
 *     vanilla launcher also manages
 *   - a broken install is one folder to delete, not a hunt through .minecraft
 *   - somebody else's mods in .minecraft cannot crash our client, and ours
 *     cannot crash their vanilla game
 *
 * Memory stays in MB internally because that is what the java flag wants; the
 * settings page shows GB.
 */
function defaultGameDir() {
  return path.join(app.getPath('home'), '.pinkpony');
}

const DEFAULTS = {
  /*
   * PROFILES - a version, and its own mods folder.
   *
   * One shared mods folder means every mod loads on every version, which is
   * how somebody ends up with a 1.21.1 jar crashing 1.21.4. Each profile gets
   * its own game directory (mods, config, saves) while assets and libraries
   * stay shared in the root - they are version-keyed already and are by far
   * the biggest thing on disk.
   */
  profiles: [{ id: 'default', name: 'Default', mc: '1.21.1' }],
  activeProfile: 'default',

  // The real ones, and the player can add their own. Kept in settings rather
  // than hardcoded in the renderer so "add server" has somewhere to write.
  servers: [
    { name: 'Factions', ip: 'factions.pinkponyclient.com' },
    { name: 'Skyblock', ip: 'skyblock.pinkponyclient.com' },
    { name: 'SMP',      ip: 'smp.pinkponyclient.com' }
  ],
  memory: 4096,          // MB - shown as GB, passed to java as MB
  javaPath: '',          // empty = let the launcher find one
  gameDir: '',           // empty = our own folder, see defaultGameDir()
  code: '',
  closeOnLaunch: true,
  // Bring the launcher back when the game closes (only matters with
  // closeOnLaunch - otherwise it never went away).
  reopenOnClose: true,
  keepLogs: false,
  // The game window. 0 x 0 means "whatever Minecraft picks" (854x480).
  windowWidth: 0,
  windowHeight: 0,
  fullscreen: false,
  // profile id -> when it was last launched. Written by main only.
  lastPlayed: {},
  // Which version of the Terms this player agreed to. See TERMS_VERSION.
  termsAccepted: ''
};

/*
 * THE TERMS OF SERVICE. Bump this when the Terms change enough that people
 * should see them again: every launcher then asks once more before the next
 * launch. The text itself lives on the website, pinkponyclient.com/terms.html.
 */
const TERMS_VERSION = '2026-09-25';
const TERMS_URL = 'https://pinkponyclient.com/terms.html';

function readSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

ipcMain.handle('settings-read', async () => {
  const s = readSettings();
  // The renderer is told where the folder WOULD be, so the page can show a
  // real path instead of the word "default" and nobody has to guess.
  //
  // totalMemMb comes along because the home page shows allocated memory as a
  // share of what this machine actually has. "4GB" means nothing on its own -
  // it is generous on an 8GB laptop and stingy on a 32GB desktop.
  return {
    ...s,
    defaultGameDir: defaultGameDir(),
    termsVersion: TERMS_VERSION,
    termsUrl: TERMS_URL,
    totalMemMb: Math.round(require('os').totalmem() / (1024 * 1024))
  };
});

ipcMain.handle('settings-write', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') throw new Error('bad payload');

  // Merged against the defaults by KEY, so the renderer cannot invent fields
  // and cannot clobber the file with whatever shape it happens to hold.
  const current = readSettings();
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }

  // Clamped here rather than in the renderer. A UI can be wrong; this is the
  // last place before it reaches disk and then a java command line.
  next.memory = Math.max(1024, Math.min(32768, Number(next.memory) || DEFAULTS.memory));

  // Profiles, like servers, are rebuilt field by field rather than trusted -
  // the id becomes a folder name.
  if (Array.isArray(patch.profiles)) {
    next.profiles = patch.profiles
      .filter((p) => p && typeof p.id === 'string')
      .slice(0, 20)
      .map((p) => ({
        id: String(p.id).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32),
        name: String(p.name || p.id).trim().slice(0, 32),
        mc: String(p.mc || '1.21.1').trim().slice(0, 16)
      }))
      .filter((p) => p.id);
    if (!next.profiles.length) next.profiles = [...DEFAULTS.profiles];
  }
  if (typeof patch.activeProfile === 'string') {
    next.activeProfile = patch.activeProfile.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }
  if (!next.profiles.some((p) => p.id === next.activeProfile)) {
    next.activeProfile = next.profiles[0].id;
  }

  // Servers are rebuilt field by field. A list straight from the renderer is a
  // list that can carry anything, and this one ends up in a TCP connection.
  if (Array.isArray(patch.servers)) {
    next.servers = patch.servers
      .filter((s) => s && typeof s.ip === 'string')
      .slice(0, 30)
      .map((s) => ({
        name: String(s.name || s.ip).trim().slice(0, 32),
        ip: String(s.ip).trim().toLowerCase().slice(0, 120)
      }))
      .filter((s) => /^[a-z0-9.\-]+(:\d{1,5})?$/.test(s.ip));
  }
  next.closeOnLaunch = !!next.closeOnLaunch;
  next.reopenOnClose = !!next.reopenOnClose;
  next.keepLogs = !!next.keepLogs;
  next.fullscreen = !!next.fullscreen;
  // A window size is both or neither, and inside what a screen can be. These
  // end up as --width/--height on the game's command line.
  const w = Math.round(Number(next.windowWidth) || 0), h = Math.round(Number(next.windowHeight) || 0);
  if (w >= 640 && w <= 7680 && h >= 480 && h <= 4320) { next.windowWidth = w; next.windowHeight = h; }
  else { next.windowWidth = 0; next.windowHeight = 0; }
  // Only main writes this; whatever the renderer sent is put back.
  next.lastPlayed = current.lastPlayed && typeof current.lastPlayed === 'object' ? current.lastPlayed : {};
  for (const k of ['javaPath', 'gameDir', 'code']) next[k] = String(next[k] || '').trim();
  // Only ever the current version or nothing - the renderer cannot claim
  // agreement to some other text.
  next.termsAccepted = next.termsAccepted === TERMS_VERSION ? TERMS_VERSION : '';

  const tmp = SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS);
  return next;
});

/*
 * Folder and file pickers.
 *
 * The renderer never types a path into a text box that then gets used - it
 * asks for a picker and gets back whatever the OS dialog returned. That keeps
 * the one place a path enters the system inside the main process, where it can
 * be checked, and means a typo cannot point java at something that does not
 * exist.
 */
ipcMain.handle('pick-path', async (_e, kind) => {
  const opts = kind === 'file'
    ? { title: 'Choose java', properties: ['openFile'] }
    : { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
  const res = await dialog.showOpenDialog(win, opts);
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle('show-folder', async (_e, dir) => {
  const target = (typeof dir === 'string' && dir) ? dir : defaultGameDir();
  // Made on demand rather than at startup: a launcher that creates folders
  // just for being opened is a launcher that litters.
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* shown anyway */ }
  return openFolder(target);
});

/*
 * FOLDERS ONLY. shell.openPath() on a FILE runs it - an .exe, a .bat, a
 * shortcut - and the path came from the renderer, which draws text from the
 * database. Anything that is not a directory is refused.
 */
function openFolder(target) {
  try {
    if (!fs.statSync(target).isDirectory()) return false;
  } catch { return false; }
  shell.openPath(target);
  return true;
}

/*
 * Named places, so Settings can have "Open logs" and "Open screenshots" without
 * the renderer ever building a path. Created on demand.
 */
ipcMain.handle('open-place', async (_e, name, profileId) => {
  const s = readSettings();
  // A profile id is only used if it is one of ours - it becomes a path.
  const which = s.profiles.find((p) => p.id === profileId) || activeProfile(s);
  const places = {
    game:        s.gameDir || defaultGameDir(),
    profile:     profileDir(s, which),
    mods:        path.join(profileDir(s), 'mods'),
    logs:        path.join(profileDir(s), 'logs'),
    screenshots: path.join(profileDir(s), 'screenshots'),
    launcher:    app.getPath('userData')
  };
  const target = places[String(name)];
  if (!target) return false;
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* opened anyway */ }
  return openFolder(target);
});

/* Start with Windows. The OS keeps this, not settings.json, so it is read
   back from the OS every time rather than remembered. Packaged builds only -
   in dev it would register electron.exe. */
ipcMain.handle('login-item', async (_e, on) => {
  if (!app.isPackaged) return { ok: false, reason: 'dev', on: false };
  if (typeof on === 'boolean') app.setLoginItemSettings({ openAtLogin: on });
  return { ok: true, on: !!app.getLoginItemSettings().openAtLogin };
});

// ---- server list ping ----------------------------------------------------
/*
 * Asking a Minecraft server whether it is up, in about sixty lines.
 *
 * This is why the fake player counts came out. There is a real protocol for
 * this - the same one the vanilla multiplayer screen uses - so the choice was
 * never "invent numbers or show nothing", it was "invent numbers or implement
 * the handshake". It is: connect, send a handshake asking for status, send an
 * empty request, read one JSON blob back.
 *
 * https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping
 */
function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, pos };
    shift += 7;
    if (shift > 35) break;
  }
  return null;                       // not enough bytes yet
}

/** SRV first, the way Minecraft resolves an address, then a plain host. */
async function resolveServer(address) {
  const [rawHost, rawPort] = String(address).split(':');
  const host = rawHost.trim();
  if (rawPort) return { host, port: Number(rawPort) || 25565 };
  try {
    const rows = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (rows && rows.length) return { host: rows[0].name, port: rows[0].port };
  } catch { /* no SRV record - normal for most hosts */ }
  return { host, port: 25565 };
}

ipcMain.handle('server-ping', async (_e, address) => {
  if (typeof address !== 'string' || !address) return { online: false };

  const { host, port } = await resolveServer(address);
  const started = Date.now();

  return await new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    // A dead host can hang a TCP connect for a long time. Four seconds is well
    // past any server that is actually going to answer.
    const timer = setTimeout(() => finish({ online: false }), 4000);
    const socket = net.createConnection({ host, port });
    socket.setTimeout(4000);

    socket.on('error', () => { clearTimeout(timer); finish({ online: false }); });
    socket.on('timeout', () => { clearTimeout(timer); finish({ online: false }); });

    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);

      const handshake = Buffer.concat([
        varint(0x00),          // packet id
        varint(-1 >>> 0 & 0x7fffffff), // protocol version: anything works for status
        varint(hostBuf.length), hostBuf,
        portBuf,
        varint(1)              // next state: status
      ]);

      socket.write(Buffer.concat([varint(handshake.length), handshake]));
      socket.write(Buffer.concat([varint(1), varint(0x00)]));   // status request
    });

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      const len = readVarint(buf, 0);
      if (!len) return;                               // length not complete yet
      if (buf.length < len.pos + len.value) return;   // body still arriving

      const id = readVarint(buf, len.pos);
      if (!id || id.value !== 0x00) { clearTimeout(timer); return finish({ online: false }); }

      const str = readVarint(buf, id.pos);
      if (!str) { clearTimeout(timer); return finish({ online: false }); }

      try {
        const json = JSON.parse(buf.slice(str.pos, str.pos + str.value).toString('utf8'));
        clearTimeout(timer);
        finish({
          online: true,
          players: json?.players?.online ?? 0,
          max: json?.players?.max ?? 0,
          version: json?.version?.name ?? '',
          ms: Date.now() - started
        });
      } catch {
        clearTimeout(timer);
        finish({ online: false });
      }
    });
  });
});

// ---- account -------------------------------------------------------------
/*
 * Microsoft sign-in through msmc.
 *
 * THE CLIENT ID IS NOT A SECRET. It identifies the app, it ships inside every
 * open-source launcher, and Microsoft expects it to be public. What must never
 * exist for a desktop app is a client SECRET - a desktop app cannot keep one,
 * and adding one would be handing it to everybody who downloads the launcher.
 *
 * The TOKEN is a different matter entirely: it is a live session for somebody's
 * Microsoft account. It is encrypted with Electron's safeStorage, which uses
 * the OS keychain (DPAPI on Windows), so the file on disk is useless if copied
 * to another machine.
 */
const CLIENT_ID = process.env.PINKPONY_CLIENT_ID
                 || 'ddae9499-5412-4c3c-9eab-6cb125f21fb5';   // Azure app id

/*
 * MORE THAN ONE ACCOUNT.
 *
 * Stored as a list plus which one is active, all inside one encrypted blob.
 * A file per account would be tidier to look at and worse to live with -
 * safeStorage would have to be called per file, and a half-written directory
 * after a crash is a state nobody wants to reason about.
 */
function readStore() {
  try {
    const raw = fs.readFileSync(STORE);
    const body = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    const parsed = JSON.parse(body);

    // Anyone who signed in before this change has a single account object
    // sitting in the file. Migrate rather than making them sign in again.
    if (parsed && parsed.name && !parsed.accounts) {
      return { accounts: [parsed], active: parsed.uuid };
    }
    return { accounts: [], active: null, ...parsed };
  } catch {
    return { accounts: [], active: null };
  }
}

function writeStore(store) {
  const body = JSON.stringify(store);
  if (!safeStorage.isEncryptionAvailable()) {
    // Rather than silently writing live tokens in the clear: no persistence.
    // Signing in again is a nuisance; a plaintext token in a synced folder is
    // somebody else's Minecraft account.
    console.warn('safeStorage unavailable - not persisting sessions');
    try { fs.unlinkSync(STORE); } catch { /* nothing to remove */ }
    return;
  }
  fs.writeFileSync(STORE, safeStorage.encryptString(body));
}

/** The active account, whole - token included. Main process only. */
function loadAccount() {
  const store = readStore();
  if (!store.accounts.length) return null;
  return store.accounts.find((a) => a.uuid === store.active) || store.accounts[0];
}

/** What the renderer is allowed to see. Never a token. */
function publicAccount(acc) {
  return acc ? { name: acc.name, uuid: acc.uuid, premium: !!acc.premium } : null;
}

function publicStore() {
  const store = readStore();
  return {
    accounts: store.accounts.map(publicAccount),
    active: store.active
  };
}

/** Add or replace by uuid, and make it the active one. */
function upsertAccount(acc) {
  const store = readStore();
  const i = store.accounts.findIndex((a) => a.uuid === acc.uuid);
  if (i >= 0) store.accounts[i] = acc;
  else store.accounts.push(acc);
  store.active = acc.uuid;
  writeStore(store);
}

ipcMain.handle('accounts', async () => publicStore());

ipcMain.handle('account-select', async (_e, uuid) => {
  const store = readStore();
  if (!store.accounts.some((a) => a.uuid === uuid)) throw new Error('No such account');
  store.active = uuid;
  writeStore(store);
  return publicStore();
});

ipcMain.handle('account-remove', async (_e, uuid) => {
  const store = readStore();
  store.accounts = store.accounts.filter((a) => a.uuid !== uuid);
  if (store.active === uuid) store.active = store.accounts[0]?.uuid ?? null;
  writeStore(store);
  return publicStore();
});

/*
 * A stored session goes stale (Minecraft tokens last about a day). Refresh one
 * from its refresh token; on any failure hand back what was stored and let the
 * launch be the thing that complains. Used at startup and before a switch.
 */
async function refreshAccount(acc) {
  try {
    return await refreshAccountStrict(acc);
  } catch (e) {
    // Offline, or the refresh token was revoked.
    console.warn('refresh failed:', e?.message || e);
    return acc;
  }
}

/** Same, but a failure is an error rather than the stale session back. */
async function refreshAccountStrict(acc) {
  if (!acc || !acc.refresh) return acc;
  const { Auth } = require('msmc');
  const auth = new Auth('select_account');
  auth.clientPackage = { client_id: CLIENT_ID };
  const xbox = await auth.refresh(acc.refresh);
  const mc = await xbox.getMinecraft();
  const fresh = {
    name: mc.profile.name, uuid: mc.profile.id, premium: true,
    token: mc.mclc(), refresh: xbox.save()
  };
  upsertAccount(fresh);
  return fresh;
}

ipcMain.handle('saved-account', async () => {
  const acc = loadAccount();
  if (!acc) return null;
  const fresh = await refreshAccount(acc);
  // Link it in the background - a fresh token is exactly what that needs,
  // and the home page must not wait on Mojang to draw.
  linkAccount(fresh).catch(() => {});
  return publicAccount(fresh);
});

/**
 * Microsoft sign-in, in msmc's own window. `keepActive` leaves whichever
 * account is active alone - used when the game asks, so adding an account
 * from the title screen never changes who is playing behind the player's back.
 */
async function signIn({ keepActive = false } = {}) {
  if (!CLIENT_ID) {
    throw new Error('No Azure client id set - put it in CLIENT_ID in main.js.');
  }
  const { Auth } = require('msmc');
  const auth = new Auth('select_account');
  auth.clientPackage = { client_id: CLIENT_ID };

  // 'electron' opens the Microsoft login in its own window. The alternative
  // is a device code the player types into a browser; this is friendlier and
  // is what msmc is built around. Kept on top so that, asked for from inside
  // a full-screen game, it does not open somewhere behind it.
  const before = readStore().active;
  const xbox = await auth.launch('electron', {
    width: 520, height: 680, resizable: false, alwaysOnTop: true, title: 'Add a Minecraft account'
  });
  const mc = await xbox.getMinecraft();

  const acc = {
    name: mc.profile.name,
    uuid: mc.profile.id,
    premium: true,
    token: mc.mclc(),
    refresh: xbox.save()
  };
  upsertAccount(acc);
  if (keepActive && before && before !== acc.uuid) {
    const store = readStore();
    store.active = before;
    writeStore(store);
  }
  addEvent('join', `Signed in as ${acc.name}`, '');
  return acc;
}

ipcMain.handle('sign-in', async () => {
  await signIn();
  return publicStore();
});

ipcMain.handle('sign-out', async () => {
  try { fs.unlinkSync(STORE); } catch { /* already gone */ }
  return publicStore();
});

// ---- profiles ------------------------------------------------------------

function activeProfile(settings) {
  const s = settings || readSettings();
  return s.profiles.find((p) => p.id === s.activeProfile) || s.profiles[0];
}

/**
 * Where a profile actually lives.
 *
 * root/profiles/<id> is the game directory - mods, config, saves, screenshots.
 * root itself keeps assets, libraries and versions, which are shared because
 * they are already keyed by version and are most of the gigabytes.
 */
function profileDir(settings, profile) {
  const root = (settings || readSettings()).gameDir || defaultGameDir();
  return path.join(root, 'profiles', (profile || activeProfile(settings)).id);
}

ipcMain.handle('profiles', async () => {
  const s = readSettings();
  return s.profiles.map((p) => {
    let mods = 0;
    try {
      mods = fs.readdirSync(path.join(profileDir(s, p), 'mods'))
               .filter((f) => /\.jar$/i.test(f)).length;
    } catch { /* never launched this one yet */ }
    // Which Pink Pony build is in THIS profile's folder, from the file name
    // the launcher itself gave it (PinkPony-<version>-<mc>.jar). Read here so
    // the Profiles page can say what every version has, not just the active one.
    let client = '';
    try {
      const f = fs.readdirSync(path.join(profileDir(s, p), 'mods'))
        .find((x) => /^pinkpony-.+-.+\.jar$/i.test(x));
      const m = f && f.match(/^pinkpony-(.+)-[^-]+\.jar$/i);
      client = m ? m[1] : '';
    } catch { /* never launched */ }
    return { ...p, mods, client, lastPlayed: Number(s.lastPlayed?.[p.id]) || 0,
             active: p.id === s.activeProfile };
  });
});

ipcMain.handle('profile-select', async (_e, id) => {
  const s = readSettings();
  if (!s.profiles.some((p) => p.id === id)) throw new Error('No such profile');
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...s, activeProfile: id }, null, 2));
  return activeProfile();
});

ipcMain.handle('profile-add', async (_e, name, mc) => {
  const s = readSettings();
  const base = String(name || mc || 'profile').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'profile';

  // Ids become folder names, so a duplicate would silently share a mods
  // folder with the profile it collided with - which is the exact thing
  // profiles exist to prevent.
  let id = base, n = 2;
  while (s.profiles.some((p) => p.id === id)) id = `${base}-${n++}`;

  const profile = { id, name: String(name || id).slice(0, 32), mc: String(mc || '1.21.1') };
  const next = { ...s, profiles: [...s.profiles, profile], activeProfile: id };
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  fs.mkdirSync(path.join(profileDir(next, profile), 'mods'), { recursive: true });
  return profile;
});

ipcMain.handle('profile-remove', async (_e, id) => {
  const s = readSettings();
  if (s.profiles.length <= 1) throw new Error('That is the only profile.');
  const profiles = s.profiles.filter((p) => p.id !== id);
  const next = {
    ...s,
    profiles,
    activeProfile: s.activeProfile === id ? profiles[0].id : s.activeProfile
  };
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  // The folder is deliberately left on disk. Removing a profile from a list
  // should not delete somebody's worlds, and "it is still in
  // .pinkpony/profiles" is a recoverable mistake where rmdir is not.
  return next.activeProfile;
});

// ---- carrying settings between versions -----------------------------------
/*
 * Each profile is its own game folder, which is right for worlds (a world
 * opened on 26.3 cannot go back to 1.21) and wrong for everything a player set
 * up once and expects to follow them: the in-game server list, video and
 * control settings, and Pink Pony's modules and macros.
 *
 * So those come across ONCE, automatically, the first time a new profile is
 * launched - and after that only when the player asks, from Settings. Never
 * behind their back on a profile they have already played, because by then
 * its settings are theirs.
 *
 * What is NOT carried, on purpose:
 *   saves/                  - worlds; see above
 *   mods/                   - version-specific jars; a 1.21 mod in 26.3 is a crash
 *   config/pinkpony.properties - the code and hwid; seedCode() owns that file
 *   anything else in config/ - other mods' configs, which are per mod version
 *
 * Keybinds are safe to carry: modules.json and macros.json store GLFW numbers
 * and each client translates on load, and Minecraft upgrades an older
 * options.txt itself. The one direction it cannot go is DOWN - an older game
 * does not understand a newer options.txt - so a copy from a newer version to
 * an older one leaves options.txt alone.
 */
const CARRIED = ['servers.dat', 'options.txt'];
const CARRIED_DIR = path.join('config', 'pinkpony');     // every .json in it
const CARRIED_MARK = '.pinkpony-carried';

/* 26.3 > 1.21.1 > 1.21. Numbers, not strings - "1.9" < "1.10". */
function mcNewer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/* The files that would be carried from one game folder, relative to it. */
function carriedFiles(fromDir, fromMc, toMc) {
  const out = CARRIED.filter((f) => !(f === 'options.txt' && mcNewer(fromMc, toMc)));
  try {
    for (const f of fs.readdirSync(path.join(fromDir, CARRIED_DIR))) {
      if (/\.json$/i.test(f)) out.push(path.join(CARRIED_DIR, f));
    }
  } catch { /* never played there - nothing of ours to carry */ }
  return out.filter((f) => fs.existsSync(path.join(fromDir, f)));
}

/*
 * Copy what is carried from one profile's folder into another's.
 * Whatever it replaces is copied aside first, into
 * <profile>/before-copy-<time>/, so a copy the player did not mean is undone
 * by copying those back - nothing is ever just overwritten.
 */
function carry(fromProfile, toProfile, settings) {
  const from = profileDir(settings, fromProfile);
  const to = profileDir(settings, toProfile);
  const files = carriedFiles(from, fromProfile.mc, toProfile.mc);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const aside = path.join(to, `before-copy-${stamp}`);

  for (const rel of files) {
    const dest = path.join(to, rel);
    if (fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(path.join(aside, rel)), { recursive: true });
      fs.copyFileSync(dest, path.join(aside, rel));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
  }
  fs.writeFileSync(path.join(to, CARRIED_MARK), `${fromProfile.id}\n`);
  return files;
}

/*
 * The automatic, first-time copy. A profile counts as new until the game has
 * written its options.txt there - which it does on its first start - so this
 * fires exactly once per profile, including profiles made before this
 * existed that were created but never launched. The source is the first
 * profile that HAS been played: Default, for nearly everybody.
 */
function carryIfNew(settings, profile) {
  const dir = profileDir(settings, profile);
  if (fs.existsSync(path.join(dir, 'options.txt'))) return;
  if (fs.existsSync(path.join(dir, CARRIED_MARK))) return;
  const source = settings.profiles.find((p) => p.id !== profile.id
    && fs.existsSync(path.join(profileDir(settings, p), 'options.txt')));
  if (!source) return;
  try {
    const files = carry(source, profile, settings);
    if (files.length) {
      addEvent('profile', `Brought your settings over from ${source.name}`,
               `${files.length} file${files.length === 1 ? '' : 's'} into ${profile.name}`);
    }
  } catch (e) {
    // A failed copy must never stop the game starting - it starts with
    // Minecraft's defaults, exactly as it did before this existed.
    addEvent('profile', `Could not copy settings into ${profile.name}`, String(e?.message || e));
  }
}

let gameRunning = false;

/*
 * ONE SERVER LIST FOR EVERY VERSION (1.2.8).
 *
 * Each profile is its own game folder, so each had its own servers.dat - add
 * a server on 26.3 and it was not there on 1.21.1. Now there is one shared
 * copy in the root of the Pink Pony folder: it goes into a profile before
 * that profile launches (if it is newer), and comes back out when the game
 * closes (if the game changed it). The file format is the same on both
 * versions. Featured servers are never in it - the client keeps them out.
 *
 * The first time, the newest servers.dat from any profile becomes the shared
 * one, so nobody loses the list they already have.
 */
function sharedServersPath(settings) {
  return path.join(settings.gameDir || defaultGameDir(), 'servers.shared.dat');
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function serversIn(settings, profile) {
  const dir = profileDir(settings, profile);
  fs.mkdirSync(dir, { recursive: true });
  const shared = sharedServersPath(settings);
  const mine = path.join(dir, 'servers.dat');
  try {
    if (!fs.existsSync(shared)) {
      // Seed from the newest list any profile already has.
      let best = '', bestAt = 0;
      for (const p of settings.profiles) {
        const f = path.join(profileDir(settings, p), 'servers.dat');
        const t = mtime(f);
        if (t > bestAt) { best = f; bestAt = t; }
      }
      if (best) fs.copyFileSync(best, shared);
    }
    if (fs.existsSync(shared) && mtime(shared) > mtime(mine)) {
      fs.copyFileSync(shared, mine);
      // Same timestamp both sides, so "did the game change it" is a plain compare.
      const t = new Date(mtime(shared));
      fs.utimesSync(mine, t, t);
    }
  } catch (e) {
    // The game starts with whatever list this profile had. Never a failed launch.
    console.warn('shared servers in:', e?.message || e);
  }
  return mtime(mine);
}

function serversOut(settings, profile, before) {
  try {
    const mine = path.join(profileDir(settings, profile), 'servers.dat');
    const t = mtime(mine);
    if (t && t !== before) fs.copyFileSync(mine, sharedServersPath(settings));
  } catch (e) {
    console.warn('shared servers out:', e?.message || e);
  }
}

/* The Settings button: copy from `fromId` into the profile being played now. */
ipcMain.handle('profile-copy', async (_e, fromId) => {
  if (gameRunning) {
    // The game writes options.txt as it closes and would put the old one back.
    throw new Error('Close the game first.');
  }
  const s = readSettings();
  const to = activeProfile(s);
  const from = s.profiles.find((p) => p.id === String(fromId));
  if (!from) throw new Error('No such profile.');
  if (from.id === to.id) throw new Error('That is the version you are on.');
  const files = carry(from, to, s);
  if (!files.length) throw new Error(`${from.name} has nothing to copy yet - play it once first.`);
  addEvent('profile', `Copied settings from ${from.name}`, `${files.length} files into ${to.name}`);
  return { count: files.length, skippedOptions: mcNewer(from.mc, to.mc) };
});

// ---- reading a jar -------------------------------------------------------
/*
 * Pull one file out of a zip, without a dependency.
 *
 * A .jar is a zip, and every Fabric mod carries a fabric.mod.json with its
 * name and version in it. Reading that is the difference between the Mods page
 * listing "sodium-fabric-0.6.13.jar" and listing "Sodium 0.6.13" - and the
 * whole point of the page is that it is about mods, not filenames.
 *
 * Central directory first, then the local header, the way the format is meant
 * to be read: the local header's sizes are allowed to be zeroes with the real
 * ones in a trailing descriptor, so trusting them is how zip readers break on
 * files written by streaming writers.
 */
function zipRead(buf, wanted) {
  // End of central directory: scan back from the end, since a comment (up to
  // 64k) can sit after it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return require('zlib').inflateRawSync(raw);
      return null;                       // some other compression - not ours to guess
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** What a mod says about itself, or just its filename if it will not say. */
function describeJar(file, full) {
  const out = { file, name: file.replace(/\.jar(\.disabled)?$/i, ''), version: '', description: '' };
  try {
    const json = zipRead(fs.readFileSync(full), 'fabric.mod.json');
    if (!json) return out;
    // Fabric writes these by hand often enough that trailing commas and
    // newlines inside strings show up. Parse loosely, fall back to the name.
    const meta = JSON.parse(json.toString('utf8').replace(/,\s*([}\]])/g, '$1'));
    out.id = meta.id || '';
    out.name = meta.name || out.name;
    out.version = meta.version || '';
    out.description = String(meta.description || '').split('\n')[0].slice(0, 120);
  } catch { /* not a Fabric mod, or a jar we cannot read - the filename stands */ }
  return out;
}

/**
 * Everything in the mods folder, ours and theirs.
 *
 * Disabling renames to .jar.disabled rather than deleting or moving. Fabric
 * ignores anything that is not a .jar, the file stays exactly where the player
 * put it, and turning it back on is the same rename backwards - which matters
 * for a mod somebody downloaded once and cannot find again.
 */
ipcMain.handle('mods-scan', async () => {
  const dir = path.join(profileDir(), 'mods');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* it may already exist */ }

  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }

  return files
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((f) => {
      const info = describeJar(f, path.join(dir, f));
      const lower = f.toLowerCase();
      return {
        ...info,
        enabled: !lower.endsWith('.disabled'),
        // Ours and its dependency are marked so the UI can say why removing
        // them is a bad idea, rather than letting somebody delete the client
        // and wonder where it went.
        managed: lower.startsWith('pinkpony') || lower.startsWith('fabric-api')
      };
    })
    .sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name));
});

ipcMain.handle('mods-file', async (_e, action, file) => {
  if (typeof file !== 'string' || !/^[^\\/:*?"<>|]+\.jar(\.disabled)?$/i.test(file)) {
    throw new Error('bad file');       // no paths, no traversal
  }
  const dir = path.join(profileDir(), 'mods');
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) throw new Error('not there any more');

  if (action === 'toggle') {
    const off = file.toLowerCase().endsWith('.disabled');
    const next = off ? file.replace(/\.disabled$/i, '') : file + '.disabled';
    fs.renameSync(full, path.join(dir, next));
    return true;
  }
  if (action === 'remove') {
    fs.unlinkSync(full);
    return true;
  }
  throw new Error('unknown action');
});

ipcMain.handle('mods-folder', async () => {
  const dir = path.join(profileDir(), 'mods');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fine */ }
  shell.openPath(dir);
  return dir;
});

/*
 * Jars dragged onto the Profiles page. The renderer only has the paths the OS
 * gave the drop (webUtils.getPathForFile in preload); each one is checked to
 * be an existing .jar file of a sane size before it is COPIED - never moved -
 * into this profile's mods folder. A name that is already there is skipped
 * rather than overwritten.
 */
ipcMain.handle('mods-add', async (_e, paths) => {
  const dir = path.join(profileDir(), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const out = { added: [], skipped: [] };
  for (const src of (Array.isArray(paths) ? paths : []).slice(0, 50)) {
    const name = path.basename(String(src || ''));
    try {
      if (!/\.jar$/i.test(name)) { out.skipped.push({ name, why: 'not a .jar' }); continue; }
      const st = fs.statSync(src);
      if (!st.isFile() || st.size > 200 * 1024 * 1024) { out.skipped.push({ name, why: 'not a mod file' }); continue; }
      if (/^pinkpony/i.test(name)) { out.skipped.push({ name, why: 'the launcher installs Pink Pony itself' }); continue; }
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) { out.skipped.push({ name, why: 'already there' }); continue; }
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
      out.added.push(name);
    } catch (e) {
      out.skipped.push({ name, why: 'could not copy' });
    }
  }
  return out;
});

// ---- licence status ------------------------------------------------------
/*
 * What this code is entitled to, without launching anything.
 *
 * The licenses table is not readable by anon - correctly, it holds every code
 * in existence - so the build function answers this too. One tier since
 * 2026-09-25: Premium, a month at a time ({ premium, lifetime, paid_until }).
 */
ipcMain.handle('licence-status', async () => {
  const { code } = readSettings();
  if (!code) return { ok: false, reason: 'no_code', tier: 'free' };
  try {
    return await fetch(`${SB_URL}/functions/v1/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY,
                 Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({ code })
    }).then((r) => r.json());
  } catch {
    return { ok: false, reason: 'offline', tier: 'free' };
  }
});

// ---- friends -------------------------------------------------------------
/*
 * A thin pass-through to the friends function. The launcher holds the code and
 * knows which account is signed in; the function decides everything else.
 *
 * The player name comes from the SIGNED IN ACCOUNT, not from anything the
 * renderer types. The function binds a licence to a name on first use and
 * enforces it after, so passing a name from a text box would be handing the
 * renderer the ability to act as somebody else - or, more likely, to bind the
 * licence to a typo forever.
 */
ipcMain.handle('friends', async (_e, action, target) => {
  const { code } = readSettings();
  const acc = loadAccount();

  if (!code) return { ok: false, reason: 'no_code' };
  if (!acc?.name) return { ok: false, reason: 'not_signed_in' };

  try {
    return await fetch(`${SB_URL}/functions/v1/friends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY,
                 Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({
        action: String(action || 'list'),
        code,
        player: acc.name,
        target: target ? String(target) : undefined
      })
    }).then((r) => r.json());
  } catch {
    return { ok: false, reason: 'offline' };
  }
});

// ---- equipping cosmetics --------------------------------------------------
/*
 * Reading cosmetics is public and the renderer does it directly. WRITING comes
 * through here, because the cosmetics function wants three things the renderer
 * must not be trusted with or does not have:
 *
 *   the code    a secret, and settings are main's to read
 *   the player  taken from the SIGNED IN account, never from the renderer -
 *               same rule as friends. A renderer that can name itself can
 *               equip as somebody else.
 *   the hwid    see below
 *
 * THE HWID PROBLEM
 *
 * That function checks the licence is bound to this machine, and the launcher
 * has never computed an hwid - the game derives it from hardware. Writing a
 * second implementation here would mean two pieces of code guessing at the
 * same number and locking the player out of their own licence the day they
 * disagree.
 *
 * So the launcher does not compute it. It reads the value the GAME already
 * wrote, out of the same properties file seedCode() writes the code into. One
 * implementation, one source, and it is by definition the value the licence is
 * actually bound to.
 *
 * The cost is that equipping needs the game to have been run once on this PC.
 * That is worth saying plainly in the UI rather than failing as "code locked
 * to another PC", which is what the server would otherwise report and which
 * sounds like a ban.
 */
function readHwid(settings) {
  const s = settings || readSettings();

  // The hwid identifies the MACHINE, not the profile - so any profile that has
  // ever run gives the right answer. Checking the active one first only
  // because it is the likeliest to exist.
  const ordered = [activeProfile(s), ...s.profiles.filter((p) => p.id !== s.activeProfile)];

  for (const p of ordered) {
    if (!p) continue;
    try {
      const text = fs.readFileSync(
        path.join(profileDir(s, p), 'config', 'pinkpony.properties'), 'utf8');
      const m = text.match(/^hwid=(.*)$/m);
      const hwid = m ? m[1].trim() : '';
      if (hwid) return hwid;
    } catch { /* this profile has never been launched */ }
  }
  return '';
}

/*
 * The version this launcher actually IS.
 *
 * app.getVersion() reads it from the packaged package.json, so it cannot drift
 * from what electron-updater compares against - which is the point. A number
 * typed into the HTML would be a second place to remember to bump, and the one
 * that gets forgotten is always the one people read.
 */
ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('cosmetics', async (_e, action, kind, value) => {
  if (action !== 'equip') return { ok: false, reason: 'unknown_action' };

  const settings = readSettings();
  const acc = loadAccount();

  if (!settings.code) return { ok: false, reason: 'no_code' };
  if (!acc?.name) return { ok: false, reason: 'not_signed_in' };

  const hwid = readHwid(settings);
  if (!hwid) return { ok: false, reason: 'no_hwid' };

  try {
    const res = await fetch(`${SB_URL}/functions/v1/cosmetics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY,
                 Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({
        action: 'equip',
        code: settings.code,
        hwid,
        player: acc.name,
        kind: String(kind || ''),
        // An empty value is how the function is told to take something off, so
        // it is passed through rather than rejected as missing.
        value: value == null ? '' : String(value)
      })
    }).then((r) => r.json());

    if (res?.ok) {
      addEvent('cos', value ? 'Equipped a cosmetic' : 'Removed a cosmetic',
               String(value || kind || ''));
    }
    return res;
  } catch {
    return { ok: false, reason: 'offline' };
  }
});

// ---- what actually happened ----------------------------------------------
/*
 * Recent activity, from things the launcher genuinely saw.
 *
 * The panel used to hold four invented rows. Same objection as the invented
 * player counts: a launcher that makes things up cannot be believed about
 * anything else. These are recorded as they happen - a launch, an install, a
 * sign-in - and there are no others, so an empty list stays empty.
 */
// ---- linking Minecraft accounts to the code -------------------------------
/*
 * Every Minecraft account you play on with your code shares one wardrobe:
 * buy a cape on one and it is on all of them, equip it on one and they all
 * wear it. The sharing itself is done by the database (linked_accounts and
 * the pp_* triggers); all the launcher does is prove each account is yours.
 *
 * THE PROOF IS MINECRAFT'S OWN SERVER LOGIN. The `link` function hands out a
 * one-off server id, the launcher tells Mojang "this account is joining a
 * server with that id" using the account's own session, and the function asks
 * Mojang whether that really happened. The session token goes to Mojang and
 * nowhere else - never to us. A name that is merely typed or claimed cannot
 * pass, so nobody can link somebody else's account and dress them up.
 *
 * Needs the hwid, so the first link happens after the game has run once on
 * this PC (see readHwid). Re-checked every twelve hours per account, which
 * also picks up a changed Minecraft name.
 */
const LINKS = path.join(app.getPath('userData'), 'linked.json');
const RELINK_MS = 12 * 3600 * 1000;

function readLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS, 'utf8')) || {}; } catch { return {}; }
}
function writeLinks(links) {
  try { fs.writeFileSync(LINKS, JSON.stringify(links)); } catch { /* retried next time */ }
}

let linking = null;

function linkAccount(acc, { force = false } = {}) {
  if (linking) return linking;
  linking = (async () => {
    const settings = readSettings();
    if (!settings.code || !acc?.uuid || !acc?.name) return { ok: false, reason: 'not_ready' };
    const hwid = readHwid(settings);
    if (!hwid) return { ok: false, reason: 'no_hwid' };

    // Keyed on a fingerprint of the code too, so a new code links afresh.
    // Never the code itself - this file is not encrypted.
    const key = crypto.createHash('sha256').update(settings.code).digest('hex').slice(0, 12)
              + ':' + acc.uuid;
    const links = readLinks();
    if (!force && links[key] && Date.now() - links[key] < RELINK_MS) return { ok: true, cached: true };

    const post = (body) => fetch(`${SB_URL}/functions/v1/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY,
                 Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify(body)
    }).then((r) => r.json());

    const start = await post({ action: 'start', code: settings.code, hwid });
    if (!start?.ok || !start.server_id) return start || { ok: false, reason: 'no_answer' };

    const join = (a) => fetch('https://sessionserver.mojang.com/session/minecraft/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: a.token?.access_token,
        selectedProfile: String(a.uuid).replace(/-/g, ''),
        serverId: start.server_id
      })
    });

    let who = acc;
    let res = await join(who);
    if (res.status === 401 || res.status === 403) {
      // A stale session. One refresh, then give up quietly until next time.
      who = await refreshAccountStrict(acc).catch(() => null);
      if (!who) return { ok: false, reason: 'session_expired' };
      res = await join(who);
    }
    if (res.status !== 204 && !res.ok) return { ok: false, reason: 'mojang_' + res.status };

    const done = await post({ action: 'finish', code: settings.code, hwid,
                              name: who.name, server_id: start.server_id });
    if (done?.ok) {
      const first = !links[key];
      links[key] = Date.now();
      writeLinks(links);
      if (first) {
        addEvent('cos', `Linked ${done.name} to your code`,
                 (done.linked || []).length > 1
                   ? 'Cosmetics now shared with ' + done.linked.filter((n) => n !== done.name).join(', ')
                   : 'Your cosmetics follow every account you link');
      }
    }
    return done;
  })()
    .catch((e) => ({ ok: false, reason: String(e?.message || e) }))
    .finally(() => { linking = null; });
  return linking;
}

const HISTORY = path.join(app.getPath('userData'), 'history.json');
const HISTORY_MAX = 40;

function addEvent(kind, text, detail) {
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { /* first one */ }
    list.unshift({ kind, text, detail: detail || '', at: Date.now() });
    fs.writeFileSync(HISTORY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* history is a nicety, never worth failing a launch over */ }
}

ipcMain.handle('history', async () => {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); }
  catch { return []; }
});

// ---- launching -----------------------------------------------------------
/*
 * What a launch actually involves, in order:
 *
 *   1. make sure our own folder exists
 *   2. make sure a Fabric profile for this Minecraft version is installed
 *   3. hand the lot to minecraft-launcher-core, which downloads the game,
 *      libraries, assets and natives and builds the java command line
 *
 * Step 2 is the one people skip. Fabric is not a mod - it is a modified
 * version profile - so without it the mod jar sits in the folder and nothing
 * loads it. Rather than shipping the Fabric installer, the profile JSON is
 * fetched from Fabric's own meta API and written into versions/, which is
 * exactly what the installer would have done.
 */
const FABRIC_META = 'https://meta.fabricmc.net/v2';

function say(percent, text, extra = {}) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('progress', { percent, text, ...extra });
  }
}

async function ensureFabric(gameDir, mcVersion) {
  const list = await fetch(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`)
    .then((r) => r.json());
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`Fabric has no loader for ${mcVersion} yet.`);
  }
  // First stable entry, falling back to the newest of anything.
  const pick = list.find((l) => l.loader && l.loader.stable) || list[0];
  const loader = pick.loader.version;
  const id = `fabric-loader-${loader}-${mcVersion}`;

  const dir = path.join(gameDir, 'versions', id);
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) return id;      // already installed, nothing to do

  say(8, 'Installing Fabric…');
  const profile = await fetch(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loader)}/profile/json`
  ).then((r) => r.json());

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return id;
}

/*
 * Getting the client itself into the game.
 *
 * The jar lives in a PRIVATE bucket, so the launcher cannot just download it -
 * and must never hold a service key to do so. Instead the "build" edge
 * function checks the access code and hands back a link that dies in five
 * minutes. The licence gate that matters is still the one inside the running
 * client; this one only stops the jar being a public download.
 *
 * Fabric API comes from Modrinth, because our mod uses it and a Fabric mod
 * without its API dependency fails at load with a message players will bring
 * to you rather than read.
 */
const SB_URL = 'https://bqqelxngcqubuskfwnvy.supabase.co';
const SB_KEY = 'sb_publishable_SDzCCGzoap9fpUuwlA07Jg_EZFD4FQk';

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Written beside and renamed: a half-downloaded jar in mods/ is a crash on
  // the next launch, and an interrupted download is not rare.
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

async function ensureFabricApi(modsDir, mcVersion) {
  const existing = fs.readdirSync(modsDir).find((f) => /^fabric-api.*\.jar$/i.test(f));
  if (existing) return existing;

  say(60, 'Getting Fabric API…');
  const url = 'https://api.modrinth.com/v2/project/fabric-api/version'
    + `?game_versions=["${mcVersion}"]&loaders=["fabric"]`;
  const list = await fetch(url, {
    headers: { 'User-Agent': 'pinkponyclient/launcher (contact: pinkponyclient.com)' }
  }).then((r) => r.json());

  const file = list?.[0]?.files?.find((f) => f.primary) || list?.[0]?.files?.[0];
  if (!file) throw new Error(`No Fabric API build for ${mcVersion}.`);
  await download(file.url, path.join(modsDir, file.filename));
  return file.filename;
}

async function ensureClient(modsDir, mcVersion, code) {
  if (!code) {
    throw new Error('No access code saved - put yours in Settings first.');
  }

  say(45, 'Checking your build…');
  const res = await fetch(`${SB_URL}/functions/v1/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: SB_KEY,
               Authorization: 'Bearer ' + SB_KEY },
    body: JSON.stringify({ code, mc_version: mcVersion })
  }).then((r) => r.json());

  if (!res?.ok) {
    throw new Error({
      invalid_code: "That access code isn't active.",
      no_build: `There is no Pink Pony build for ${mcVersion} yet.`,
      file_missing: `The build for ${mcVersion} is missing from storage (${res?.file}).`,
      rate_limited: 'Too many tries - wait a minute.',
      premium_only: 'The client needs Premium while it is in beta - $5.99 a month. Open a ticket in the Discord to get it.',
      plus_only: 'The client needs Premium while it is in beta - $5.99 a month. Open a ticket in the Discord to get it.'
    }[res?.reason] || 'Could not get the client build.');
  }

  const target = path.join(modsDir, res.file);
  if (fs.existsSync(target)) return res.file;

  // Any older Pink Pony jar has to go. Two copies in mods/ is a duplicate mod
  // id, which Fabric refuses to load at all - and it looks like our bug.
  for (const f of fs.readdirSync(modsDir)) {
    if (/^pinkpony.*\.jar$/i.test(f) && f !== res.file) {
      try { fs.unlinkSync(path.join(modsDir, f)); } catch { /* leave it */ }
    }
  }

  say(52, `Installing Pink Pony ${res.client_version}…`);
  await download(res.url, target);
  addEvent('up', `Installed Pink Pony ${res.client_version}`, res.file);
  return res.file;
}

/*
 * Hand the access code to the game.
 *
 * The launcher has it and the client has its own config file, and until now
 * neither knew about the other - so somebody who saved their code in Settings
 * still met the code screen on the first launch and reasonably wondered what
 * the setting was for.
 *
 * The launcher wins when they disagree: it is where the code was entered most
 * recently, and it is the thing a player thinks of as "my account".
 *
 * The hwid line is preserved rather than rewritten. The client derives it from
 * the machine so it would come back the same, but the licence is BOUND to that
 * value on the server - and a launcher that can silently change it is one bad
 * assumption away from locking somebody out of their own licence.
 */
function seedCode(root, code) {
  if (!code) return;

  const file = path.join(root, 'config', 'pinkpony.properties');
  let hwid = '';
  try {
    const text = fs.readFileSync(file, 'utf8');
    const h = text.match(/^hwid=(.*)$/m);
    if (h) hwid = h[1].trim();
    const c = text.match(/^code=(.*)$/m);
    if (c && c[1].trim() === code) return;      // already correct, leave it alone
  } catch { /* no config yet - the client has never run here */ }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    '#Pink Pony - do not share your code\n'
    + `code=${code}\n`
    + `hwid=${hwid}\n`);
}

/*
 * THE RIGHT JAVA FOR THE VERSION BEING LAUNCHED.
 *
 * Until 26.3 this launcher never chose a Java at all: javaPath was left empty
 * and minecraft-launcher-core ran whatever `java` was on the PATH. That only
 * ever worked because 1.21.1 wants Java 21 and the machines it ran on happened
 * to have one. 26.3 is compiled for Java 25 - on Java 21 it dies before the
 * window opens with UnsupportedClassVersionError, which reads like our bug.
 *
 * So this does what Mojang's own launcher does. Every version's JSON names
 * the Java it wants (javaVersion.component, e.g. "java-runtime-delta" for 21),
 * and Mojang publishes those runtimes as plain file lists - no installer, no
 * zip. Each file is fetched once into <root>/runtime/<component>/ and checked
 * against its sha1. A finished runtime leaves a marker, so every launch after
 * the first costs one stat().
 *
 * A Java path set by hand in Settings still wins - but only if it is new
 * enough. A path to Java 21 that someone set months ago must not turn a 26.3
 * launch into a crash, so an old one is passed over for the managed runtime
 * and the reason is written to the log.
 */
const MOJANG_VERSIONS = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MOJANG_RUNTIMES =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function runtimePlatform() {
  const a = process.arch;
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : (a === 'ia32' ? 'windows-x86' : 'windows-x64');
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}

/* What `java -version` says, as a major number. 1.8 is 8. 0 if it would not run. */
function javaMajor(javaPath) {
  try {
    const r = require('child_process').spawnSync(javaPath, ['-version'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const out = `${r.stderr || ''}${r.stdout || ''}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    const first = Number(m[1]);
    return first === 1 ? Number(m[2] || 0) : first;
  } catch { return 0; }
}

async function versionJavaNeed(mcVersion) {
  const manifest = await fetch(MOJANG_VERSIONS).then((r) => r.json());
  const entry = (manifest?.versions || []).find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`Mojang has no Minecraft ${mcVersion}.`);
  const json = await fetch(entry.url).then((r) => r.json());
  // Very old versions have no javaVersion; they run on 8.
  return {
    component: json?.javaVersion?.component || 'jre-legacy',
    major: Number(json?.javaVersion?.majorVersion || 8)
  };
}

/*
 * THE JVM ARGUMENTS MOJANG'S OWN LAUNCHER PASSES. Up to 1.2.5 we passed none.
 *
 * minecraft-launcher-core (3.18.2) never reads `arguments.jvm` from the
 * version JSON - it hard-codes one flag per OS (the Windows HeapDumpPath) and
 * that's all. For 1.21.1 that lost nothing that mattered. 26.3's JSON adds
 * `-XX:StackShadowPages=32`, `--enable-native-access=ALL-UNNAMED` and
 * `--add-exports java.base/jdk.internal.misc=ALL-UNNAMED`, and they are there
 * for the new renderer: it compiles its shaders in native code (shaderc) on
 * worker threads through Java's foreign-function API, and without the extra
 * stack shadow pages a deep native call can walk past the thread's guard
 * zone. That kills the JVM outright - no crash report, at best a truncated
 * hs_err file - usually while resources reload, which is exactly how 26.3
 * was dying (28 Sep: an EXCEPTION_ACCESS_VIOLATION inside
 * Shaderc.shaderc_compile_into_spv on Worker-Main, plus a string of silent
 * exits mid-reload with no packs selected).
 *
 * So this reads the vanilla JSON (the copy minecraft-launcher-core already
 * saved under versions/, else Mojang's manifest), applies the rules the way
 * the official launcher does, fills the placeholders, and hands the result to
 * minecraft-launcher-core as customArgs. It leaves out what that library
 * already adds itself - the classpath, java.library.path and its per-OS
 * flag - so nothing is passed twice.
 */
function jvmRuleAllows(rules) {
  if (!Array.isArray(rules) || !rules.length) return true;
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== osName) match = false;
      if (r.os.arch && !(r.os.arch === 'x86' ? process.arch === 'ia32' : r.os.arch === process.arch)) match = false;
      if (r.os.version) {
        try { if (!new RegExp(r.os.version).test(require('os').release())) match = false; } catch { match = false; }
      }
    }
    if (r.features) match = false;          // launcher features (demo, custom resolution) - never on here
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

async function vanillaVersionJson(root, mcVersion, custom) {
  const local = custom && path.join(root, 'versions', custom, `${mcVersion}.json`);
  try { if (local && fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8')); } catch { /* fall through */ }
  const manifest = await fetch(MOJANG_VERSIONS).then((r) => r.json());
  const entry = (manifest?.versions || []).find((v) => v.id === mcVersion);
  if (!entry) return null;
  return fetch(entry.url).then((r) => r.json());
}

async function mojangJvmArgs(root, mcVersion, custom) {
  let json;
  try { json = await vanillaVersionJson(root, mcVersion, custom); } catch { json = null; }
  const list = json?.arguments?.jvm;
  if (!Array.isArray(list)) return [];
  const natives = path.join(root, 'natives', mcVersion);
  const fill = {
    natives_directory: natives,
    launcher_name: 'pinkpony',
    launcher_version: app.getVersion()
  };
  // minecraft-launcher-core adds these itself.
  const skip = (a) => a === '-cp' || a === '${classpath}' || a.startsWith('-Djava.library.path=')
    || a.startsWith('-XX:HeapDumpPath=') || a === '-XstartOnFirstThread' || a === '-Xss1M';
  const out = [];
  for (const item of list) {
    const values = typeof item === 'string' ? [item]
      : jvmRuleAllows(item?.rules) ? [].concat(item?.value ?? []) : [];
    for (const raw of values) {
      if (typeof raw !== 'string' || skip(raw)) continue;
      const v = raw.replace(/\$\{(\w+)\}/g, (m, k) => (k in fill ? fill[k] : m));
      if (/\$\{\w+\}/.test(v)) continue;     // a placeholder we don't know - leave the flag out rather than pass it raw
      out.push(v);
    }
  }
  return out;
}

/* Windows exit codes are NTSTATUS values; say the two that matter in words. */
function describeExit(code) {
  if (code === null || code === undefined) return 'killed';
  const hex = '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  if (hex === '0xC0000005') return 'crashed - access violation';
  if (hex === '0xC00000FD') return 'crashed - stack overflow';
  if (code === 1 || code === -1) return `exited (${code})`;
  return code < 0 || code > 255 ? `crashed (${hex})` : `exited (${code})`;
}

function sha1Of(file) {
  return require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

async function ensureJava(root, mcVersion, customPath) {
  let need;
  try {
    need = await versionJavaNeed(mcVersion);
  } catch (e) {
    // Mojang unreachable: do exactly what this launcher always did - the Java
    // from Settings, else whatever `java` is on the PATH - rather than refuse
    // a launch that has worked every day until now.
    return { path: customPath || undefined, major: javaMajor(customPath || 'java') };
  }

  if (customPath) {
    const have = javaMajor(customPath);
    if (have >= need.major) return { path: customPath, major: have };
    addEvent('java', `Skipped the Java set in Settings for ${mcVersion}`,
      `it is Java ${have || '?'}; ${mcVersion} needs ${need.major}`);
  }

  // The Java already on the PATH, if it is new enough. This is what every
  // 1.21.1 launch has used from the start, and keeping it means that line sees
  // no change at all and nobody downloads a runtime they did not need.
  const system = javaMajor('java');
  if (system >= need.major) return { path: undefined, major: system };

  const dir = path.join(root, 'runtime', need.component);
  const marker = path.join(dir, '.pinkpony-complete');
  const exe = process.platform === 'win32'
    ? path.join(dir, 'bin', 'javaw.exe')
    : process.platform === 'darwin'
      ? path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')
      : path.join(dir, 'bin', 'java');
  if (fs.existsSync(marker) && fs.existsSync(exe)) return { path: exe, major: need.major };

  say(6, `Getting Java ${need.major}…`);
  const all = await fetch(MOJANG_RUNTIMES).then((r) => r.json());
  const pick = all?.[runtimePlatform()]?.[need.component]?.[0];
  if (!pick?.manifest?.url) {
    throw new Error(`Mojang has no Java ${need.major} for this computer (${runtimePlatform()}).`);
  }
  const files = (await fetch(pick.manifest.url).then((r) => r.json()))?.files || {};

  const entries = Object.entries(files);
  for (const [rel, f] of entries) {
    if (f.type === 'directory') fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }

  const todo = entries.filter(([, f]) => f.type === 'file' && f.downloads?.raw?.url);
  let done = 0;
  const one = async ([rel, f]) => {
    const dest = path.join(dir, rel);
    const raw = f.downloads.raw;
    const ok = fs.existsSync(dest) && fs.statSync(dest).size === raw.size && sha1Of(dest) === raw.sha1;
    if (!ok) {
      await download(raw.url, dest);
      if (sha1Of(dest) !== raw.sha1) throw new Error(`Java download was corrupted (${rel}). Try again.`);
    }
    if (f.executable && process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    done++;
    if (done % 20 === 0 || done === todo.length) {
      say(6, `Getting Java ${need.major}… ${Math.round((done / todo.length) * 100)}%`);
    }
  };
  // Eight at a time: a runtime is a few hundred small files, and one at a
  // time is minutes; all at once is a few hundred sockets.
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(one));
  }

  // Links (macOS and Linux use a few); Windows runtimes have none.
  for (const [rel, f] of entries) {
    if (f.type !== 'link' || process.platform === 'win32') continue;
    const at = path.join(dir, rel);
    try { if (!fs.existsSync(at)) fs.symlinkSync(f.target, at); } catch { /* best effort */ }
  }

  if (!fs.existsSync(exe)) throw new Error(`Java ${need.major} downloaded but ${path.basename(exe)} is missing.`);
  fs.writeFileSync(marker, `${pick.version?.name || need.major}\n`);
  addEvent('java', `Installed Java ${pick.version?.name || need.major}`, need.component);
  return { path: exe, major: need.major };
}

/*
 * SWITCHING ACCOUNTS FROM INSIDE THE GAME.
 *
 * The game never holds anybody's token but the one it was started with, and
 * this launcher is the only place tokens live - so the title screen cannot
 * switch accounts itself. What it can do is ask:
 *
 *   1. at every launch this writes <profile>/config/pinkpony/accounts.json -
 *      names and uuids ONLY, never a token - so the title screen can list them
 *   2. picking one there writes switch.json {uuid} beside it and closes the game
 *   3. when the game exits, the close handler finds switch.json, makes that
 *      account active, refreshes it, and launches the same version again
 *
 * From the player's side: click a name, the game closes and comes back as them.
 */
function accountsDir(gameDir) { return path.join(gameDir, 'config', 'pinkpony'); }

function writeAccountsFile(gameDir) {
  try {
    const pub = publicStore();
    const dir = accountsDir(gameDir);
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
      active: pub.active,
      accounts: pub.accounts.filter(Boolean).map((a) => ({ name: a.name, uuid: a.uuid }))
    }, null, 2);
    const tmp = path.join(dir, 'accounts.json.tmp');
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(dir, 'accounts.json'));
  } catch { /* the switcher just shows the one account that is playing */ }
}

/** The uuid the game asked to switch to, or null. Consumes the request. */
function takeSwitchRequest(gameDir) {
  const file = path.join(accountsDir(gameDir), 'switch.json');
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);                 // our own one-shot control file
    const uuid = String(JSON.parse(raw)?.uuid || '');
    return readStore().accounts.some((a) => a.uuid === uuid) ? uuid : null;
  } catch { return null; }
}

async function switchAndRelaunch(uuid, mcVersion) {
  const store = readStore();
  const acc = store.accounts.find((a) => a.uuid === uuid);
  if (!acc) return;
  store.active = uuid;
  writeStore(store);
  say(3, `Switching to ${acc.name}…`);
  await refreshAccount(acc);
  if (win && !win.isDestroyed()) win.webContents.send('accounts-changed');
  addEvent('join', `Switched to ${acc.name}`, 'from the title screen');
  await launchGame({ version: mcVersion });
}

/*
 * THE LINE TO THE GAME: switch and add accounts without a restart.
 *
 * The title screen can now change account in place, but only this launcher
 * holds sign-ins (encrypted with the OS keychain), so the game asks for one
 * session at the moment the player picks an account. The rules:
 *
 *   - 127.0.0.1 only, on a random port, found through
 *     <profile>/config/pinkpony/bridge.json {port, key} - written at launch,
 *     deleted when the game closes.
 *   - Every request carries the key, 32 random bytes new each time the
 *     launcher starts, compared in constant time.
 *   - Anything with an Origin header is refused, and so is a Host that is
 *     not our own loopback address - a web page cannot use this, directly or
 *     through DNS rebinding.
 *   - The token only ever travels in the response body, straight into the
 *     game's memory. Nothing new is written to disk; accounts.json still
 *     holds names and uuids only.
 *
 * The older way (switch.json and a relaunch) still works for 2.49 clients.
 */
let bridge = null;             // { server, port, key }
let bridgeGameDir = null;
let addJob = { state: 'idle', name: '', error: '' };

function bridgeFile(gameDir) { return path.join(accountsDir(gameDir), 'bridge.json'); }

function writeBridgeFile(gameDir) {
  if (!bridge) return;
  try {
    const dir = accountsDir(gameDir);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'bridge.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ port: bridge.port, key: bridge.key }));
    fs.renameSync(tmp, bridgeFile(gameDir));
  } catch { /* no line: the title screen falls back to relaunching */ }
}

function removeBridgeFile(gameDir) {
  try { fs.unlinkSync(bridgeFile(gameDir)); } catch { /* already gone */ }
}

function startBridge() {
  if (bridge) return Promise.resolve(bridge);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(32).toString('hex');
    const server = http.createServer((req, res) => {
      handleBridge(req, res, key).catch((e) => reply(res, 500, { ok: false, error: e?.message || 'Launcher error' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      bridge = { server, port: server.address().port, key };
      resolve(bridge);
    });
  });
}

function reply(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function keyMatches(given, key) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function handleBridge(req, res, key) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  if (req.headers.origin) return reply(res, 403, { ok: false, error: 'No browsers' });
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${bridge.port}`) return reply(res, 403, { ok: false, error: 'Wrong host' });
  if (!keyMatches(req.headers['x-pinkpony-key'], key)) return reply(res, 403, { ok: false, error: 'Wrong key' });

  const body = await readBody(req);
  const url = String(req.url || '').split('?')[0];

  if (url === '/accounts') {
    const pub = publicStore();
    return reply(res, 200, { ok: true, active: pub.active,
      accounts: pub.accounts.filter(Boolean).map((a) => ({ name: a.name, uuid: a.uuid })) });
  }

  if (url === '/switch') {
    const uuid = String(body.uuid || '');
    const store = readStore();
    const acc = store.accounts.find((a) => a.uuid === uuid);
    if (!acc) return reply(res, 404, { ok: false, error: 'That account is not in the launcher any more.' });
    let fresh;
    try {
      fresh = await refreshAccountStrict(acc);
    } catch (e) {
      return reply(res, 200, { ok: false,
        error: `Couldn't refresh ${acc.name} - sign in to it again in the launcher.` });
    }
    const t = (fresh && fresh.token) || {};
    if (!t.access_token) return reply(res, 200, { ok: false, error: `${acc.name} has no session - sign in again.` });
    const now = readStore();
    now.active = fresh.uuid;
    writeStore(now);
    if (bridgeGameDir) writeAccountsFile(bridgeGameDir);
    if (win && !win.isDestroyed()) win.webContents.send('accounts-changed');
    addEvent('join', `Switched to ${fresh.name}`, 'in game, no restart');
    // An in-game switch never goes through launchGame, so link here too.
    linkAccount(fresh).catch(() => {});
    return reply(res, 200, {
      ok: true, name: fresh.name, uuid: fresh.uuid, token: t.access_token,
      xuid: String(t.meta?.xuid || ''), clientId: String(t.client_token || '')
    });
  }

  if (url === '/add') {
    if (addJob.state !== 'pending') {
      addJob = { state: 'pending', name: '', error: '' };
      signIn({ keepActive: true }).then((acc) => {
        addJob = { state: 'done', name: acc.name, error: '' };
        if (bridgeGameDir) writeAccountsFile(bridgeGameDir);
        if (win && !win.isDestroyed()) win.webContents.send('accounts-changed');
      }).catch((e) => {
        const code = String(e?.message || e || '');
        // Closing the Microsoft window is not an error worth shouting about.
        if (/gui\.closed|cancel/i.test(code)) { addJob = { state: 'idle', name: '', error: '' }; return; }
        // msmc rejects with codes like "error.auth.xsts.child"; say them in words.
        let words = code;
        try { words = require('msmc/dist/assets.js').lexicon[code] || code; } catch { /* keep the code */ }
        addJob = { state: 'error', name: '', error: String(words).slice(0, 160) };
      });
    }
    return reply(res, 200, { ok: true, state: addJob.state });
  }

  if (url === '/add-status') {
    return reply(res, 200, { ok: true, ...addJob });
  }

  return reply(res, 404, { ok: false, error: 'Unknown' });
}

ipcMain.handle('launch', async (_e, opts) => launchGame(opts));

/* Remember when each profile was last played, for the Profiles page. */
function markPlayed(id) {
  try {
    const cur = readSettings();
    const next = { ...cur, lastPlayed: { ...(cur.lastPlayed || {}), [id]: Date.now() } };
    const tmp = SETTINGS + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, SETTINGS);
  } catch { /* a missing timestamp is not worth failing a launch over */ }
}

async function launchGame(opts) {
  const settings = readSettings();
  const account = loadAccount();

  if (!account || !account.token) {
    throw new Error('Sign in first - the game needs a Microsoft account.');
  }
  if (settings.termsAccepted !== TERMS_VERSION) {
    throw new Error('Accept the Terms of Service first.');
  }

  const profile = activeProfile(settings);
  const mcVersion = String(opts?.version || profile.mc || '1.21.1');

  // PLAY on a server card, or JOIN on a friend, goes straight into that server
  // with Minecraft's own --quickPlayMultiplayer. The address came from the
  // renderer, so it is checked to be an address and nothing else before it
  // goes anywhere near a command line.
  const joinServer = typeof opts?.server === 'string'
    && /^[a-z0-9.\-]+(:\d{1,5})?$/.test(opts.server.trim().toLowerCase())
    ? opts.server.trim().toLowerCase() : null;
  const root = settings.gameDir || defaultGameDir();

  // Downloads shared, everything the player owns kept per profile.
  const gameDir = profileDir(settings, profile);
  const modsDir = path.join(gameDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  say(4, 'Preparing…');
  const custom = await ensureFabric(root, mcVersion);
  await ensureClient(modsDir, mcVersion, settings.code);
  await ensureFabricApi(modsDir, mcVersion);
  const java = await ensureJava(root, mcVersion, settings.javaPath);
  carryIfNew(settings, profile);
  const serversAt = serversIn(settings, profile);
  seedCode(gameDir, settings.code);
  takeSwitchRequest(gameDir);            // a leftover from a crash must not fire later
  writeAccountsFile(gameDir);
  try { await startBridge(); writeBridgeFile(gameDir); bridgeGameDir = gameDir; }
  catch (e) { console.warn('bridge failed:', e?.message || e); }

  // Mojang's own JVM flags for this version (see mojangJvmArgs), and native
  // crash files next to the crash reports, where anyone looking for a crash
  // looks, instead of wherever the JVM's working directory happens to be.
  const vanillaJvm = await mojangJvmArgs(root, mcVersion, custom);
  const crashDir = path.join(gameDir, 'crash-reports');
  try { fs.mkdirSync(crashDir, { recursive: true }); } catch { /* the JVM falls back to its own default */ }
  const jvmExtra = [
    ...(java.major >= 22 ? ['-XX:+IgnoreUnrecognizedVMOptions'] : []),
    ...vanillaJvm,
    `-XX:ErrorFile=${path.join(crashDir, 'hs_err_pid%p.log')}`
  ];
  if (settings.keepLogs) {
    try {
      fs.appendFileSync(path.join(gameDir, 'launcher.log'),
        `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] [Pink Pony launcher]: launcher ${app.getVersion()}, Java ${java.major}, Mojang JVM flags: ${vanillaJvm.join(' ') || 'none'}\n`);
    } catch { /* never worth failing a launch over */ }
  }

  const { Client } = require('minecraft-launcher-core');
  const launcher = new Client();

  launcher.on('progress', (p) => {
    const pct = p.total ? Math.round((p.task / p.total) * 100) : 0;
    // Held between 65 and 95: Fabric, the client jar and the API have already
    // taken the first stretch, and a bar that hits 100% then sits there looks
    // stuck.
    say(65 + Math.round(pct * 0.30), `Downloading ${p.type}…`);
  });
  launcher.on('data', (line) => {
    if (settings.keepLogs) {
      fs.appendFileSync(path.join(gameDir, 'launcher.log'), line);
    }
    // The game printing anything at all means java started and it is past
    // downloading, which is the only reliable "we are nearly there" signal.
    say(97, 'Starting Minecraft…');
  });
  launcher.on('close', (code) => {
    gameRunning = false;
    serversOut(settings, profile, serversAt);
    // Written into the same log as the game's output, so a session that ends
    // without "Stopping!" says how it ended instead of just stopping.
    if (settings.keepLogs) {
      try {
        fs.appendFileSync(path.join(gameDir, 'launcher.log'),
          `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] [Pink Pony launcher]: game ${describeExit(code)}${code ? ` - exit code ${code}` : ''}\n`);
      } catch { /* logging must never break the close handler */ }
    }
    if (code) addEvent('crash', `Minecraft ${describeExit(code)}`, `${mcVersion} - exit code ${code}`);
    // The game has now run at least once, so the hwid exists - the first
    // chance a brand new install has to link this account.
    linkAccount(loadAccount()).catch(() => {});
    removeBridgeFile(gameDir);
    if (bridgeGameDir === gameDir) bridgeGameDir = null;
    // Asked to come back as somebody else? Do that before anything else - the
    // update, if one is waiting, installs when that game closes instead.
    const next = takeSwitchRequest(gameDir);
    if (next) {
      switchAndRelaunch(next, mcVersion).catch((e) => {
        say(100, `Could not switch account: ${e?.message || e}`, { done: true });
        if (win && !win.isDestroyed()) win.show();
      });
      return;
    }
    // An update that arrived mid-game installs now that the game is gone.
    // Otherwise ask again - the launcher is about to be looked at.
    if (updateWaiting) installUpdate();
    else checkForUpdate('game-closed');
    say(100, code === 0 ? 'Closed' : `Game ${describeExit(code)}`, { done: true });
    if (win && !win.isDestroyed() && settings.closeOnLaunch && settings.reopenOnClose !== false) win.show();
  });

  linkAccount(account).catch(() => {});

  gameRunning = true;
  let child;
  try {
    child = await launcher.launch({
      root,
      authorization: account.token,
      version: { number: mcVersion, type: 'release', custom },
      memory: { max: `${settings.memory}M`, min: '1024M' },
      javaPath: java.path,     // chosen per version above - see ensureJava
      // minecraft-launcher-core always passes -XX:-UseAdaptiveSizePolicy, a
      // Parallel-GC flag newer JVMs have been retiring. A JVM that no longer
      // knows a flag refuses to start at all, so on the newer Javas this tells
      // it to ignore flags it does not recognise. HotSpot reads this one before
      // any other option, so where it sits in the list does not matter. Java 21
      // (1.21.1) is left exactly as it was.
      customArgs: jvmExtra,
      // gameDirectory is what makes a profile a profile: the game writes its
      // mods, config and saves here while root keeps the shared downloads.
      overrides: { detached: false, gameDirectory: gameDir },
      quickPlay: joinServer ? { type: 'multiplayer', identifier: joinServer } : undefined,
      // Settings > Game window, as Minecraft's own --fullscreen / --width /
      // --height. NOT through MCLC's `window` option: in 3.17 its width and
      // height branch is an arrow function that is never called, so a size
      // set that way silently did nothing. Left out entirely when unset.
      customLaunchArgs: settings.fullscreen ? ['--fullscreen']
        : settings.windowWidth ? ['--width', String(settings.windowWidth), '--height', String(settings.windowHeight)]
        : undefined
    });
  } catch (e) { gameRunning = false; throw e; }
  // No process means it never started, so there is nothing to wait to close.
  if (!child) gameRunning = false;

  markPlayed(profile.id);
  addEvent('play', `Launched ${mcVersion}`,
           joinServer || profile.name);
  say(99, 'Launched');
  if (settings.closeOnLaunch && win && !win.isDestroyed()) win.hide();
  return true;
}

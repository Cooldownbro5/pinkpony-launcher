/* The only bridge between the window and the machine.
 *
 * contextIsolation is on and nodeIntegration is off, so the renderer cannot
 * touch Node at all. Everything it is allowed to do is listed here, by name.
 * That matters more than usual: this window loads images and text from the
 * internet, and a window with filesystem access that also renders remote
 * content is one bad string away from being somebody else's shell.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pp', {
  win:          (what) => ipcRenderer.send('win', what),
  signIn:       () => ipcRenderer.invoke('sign-in'),
  savedAccount: () => ipcRenderer.invoke('saved-account'),
  signOut:      () => ipcRenderer.invoke('sign-out'),
  accounts:     () => ipcRenderer.invoke('accounts'),
  selectAccount:(uuid) => ipcRenderer.invoke('account-select', uuid),
  removeAccount:(uuid) => ipcRenderer.invoke('account-remove', uuid),
  launch:       (opts) => ipcRenderer.invoke('launch', opts),
  // Links open in the real browser, never in this window. A navigation inside
  // the launcher would hand a remote page the same origin as the UI.
  open:         (url) => ipcRenderer.send('open-external', url),
  modsRead:     () => ipcRenderer.invoke('mods-read'),
  modsWrite:    (enabled) => ipcRenderer.invoke('mods-write', enabled),
  settingsRead: () => ipcRenderer.invoke('settings-read'),
  settingsWrite:(patch) => ipcRenderer.invoke('settings-write', patch),
  // Paths come from an OS dialog, never from a text box the renderer typed
  // into - that keeps the one place a path enters the system in main.js.
  pickPath:     (kind) => ipcRenderer.invoke('pick-path', kind),
  pingServer:   (address) => ipcRenderer.invoke('server-ping', address),
  licenceStatus:() => ipcRenderer.invoke('licence-status'),
  history:      () => ipcRenderer.invoke('history'),
  profiles:     () => ipcRenderer.invoke('profiles'),
  profileSelect:(id) => ipcRenderer.invoke('profile-select', id),
  profileAdd:   (name, mc) => ipcRenderer.invoke('profile-add', name, mc),
  profileRemove:(id) => ipcRenderer.invoke('profile-remove', id),
  // Copies INTO the profile being played now; main.js decides what is copied.
  profileCopy:  (fromId) => ipcRenderer.invoke('profile-copy', fromId),
  modsScan:     () => ipcRenderer.invoke('mods-scan'),
  modsFile:     (action, file) => ipcRenderer.invoke('mods-file', action, file),
  modsFolder:   () => ipcRenderer.invoke('mods-folder'),
  showFolder:   (dir) => ipcRenderer.invoke('show-folder', dir),

  /*
   * EQUIPPING, WHICH WAS NEVER WIRED UP AT ALL.
   *
   * main.js has handled the 'cosmetics' channel the whole time and the
   * cosmetics page has always called window.pp.equip - but this bridge was
   * missing, so that call resolved to undefined and every EQUIP and REMOVE on
   * that page failed before it reached anything. The page then reported it as
   * a server problem, which sent two rounds of debugging at the edge function
   * and the network, neither of which was ever involved.
   *
   * The kind/value pair goes through untouched; main.js supplies the code, the
   * hwid and the signed-in name, because none of those are the renderer's to
   * assert - see the note above its handler.
   */
  equip:        (kind, value) => ipcRenderer.invoke('cosmetics', 'equip', kind, value),
  appVersion:   () => ipcRenderer.invoke('app-version'),

  /*
   * Updates. The check and the restart are the renderer asking; onUpdate is
   * the main process telling, because a download that started on its own has
   * no call to answer.
   */
  updateCheck:   () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate:      (fn) => ipcRenderer.on('update-status', (_e, s) => fn(s)),

  // The game asked to come back as another account and the launcher did it.
  onAccountsChanged: (fn) => ipcRenderer.on('accounts-changed', () => fn()),
  onProgress:   (fn) => ipcRenderer.on('progress', (_e, p) => fn(p))
});

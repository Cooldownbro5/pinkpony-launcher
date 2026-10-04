/* Pink Pony launcher — renderer.
 *
 * This file draws things and nothing else. Every privileged operation - the
 * Microsoft login, downloading the game, spawning Java - lives in main.js and
 * is reached through window.pp, which preload.js exposes.
 *
 * That split is not ceremony. This window loads remote images and remote text
 * from Supabase; giving it Node access would mean anything that ever got
 * injected into it could read the filesystem. Renderer draws, main acts.
 */

const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pretty = (v) => String(v || '')
  .replace(/\.png$/i, '').replace(/^cape_/i, '').replace(/[_-]/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

/* ---------------- window chrome ---------------- */
document.querySelectorAll('[data-win]').forEach((b) => {
  b.onclick = () => window.pp?.win(b.dataset.win);
});

const DISCORD = 'https://discord.gg/pinkp0ny';   // a zero, not an o
const PATCH_NOTES = 'https://pinkponyclient.com/patchnotes.html';
document.querySelectorAll('[data-discord]').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); window.pp?.open?.(DISCORD); };
});

/* The header icons and the hero's cog did nothing at all. Every one of them
   now goes somewhere real, or is not there - a button that does nothing is
   worse than no button, because people click it twice and assume it is broken. */
document.querySelectorAll('.ico').forEach((b) => {
  // Friends and the bell get real handlers of their own further down; this
  // only catches anything left over.
  if (b.id === 'bell' || b.id === 'friendsBtn') return;
  const what = (b.getAttribute('title') || '').toLowerCase();
  b.onclick = () => showPage(what === 'settings' ? 'settings' : 'home');
});

/* ---------------- pages ---------------- */
function showPage(name) {
  document.querySelectorAll('.nav').forEach((o) =>
    o.classList.toggle('on', o.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) =>
    p.classList.toggle('on', p.dataset.page === name));

  // Friends and the cosmetic card are the home dashboard, not chrome. Off the
  // home page they are just a 396px column of things you did not come here to
  // look at - and every other page gets that width back.
  document.body.classList.toggle('home', name === 'home');
  // The 3D preview needs a visible, sized canvas, so it starts the first
  // time the page is actually shown.
  if (name === 'cosmetics') requestAnimationFrame(() => Fit.start());
}

document.querySelectorAll('.nav').forEach((b) => {
  b.onclick = () => showPage(b.dataset.page);
});
showPage('home');

/* ---------------- profiles ---------------- */
/* A profile is a version plus its own mods folder. One shared folder means
   every mod loads on every version, which is how a 1.21.1 jar ends up crashing
   1.21.4 - so switching profile switches which mods the Mods page is even
   talking about. */

let profiles = [];
let profile = { id: 'default', name: 'Default', mc: '1.21.1' };
let mcVersions = ['1.21.1'];

// The rest of the app asks for `version.value`, so it stays a real object with
// that property rather than every call site learning about profiles.
const version = { get value() { return profile.mc; } };

function setVersion(v) {
  $('verNum').textContent = v;
  // (The rail used to print the MINECRAFT version here, as "v26.3", which read
  // as the launcher's version. It shows the launcher's own now - see below.)
  $('updVer').textContent = 'v' + v;
  const pf = $('placeFor'); if (pf) pf.textContent = profile.name || v;
  loadUpdate();
}

const heroCog = document.querySelector('.cog');
if (heroCog) heroCog.onclick = () => showPage('settings');

const verBox = $('verBox');
if (verBox) verBox.onclick = () => showPage('profiles');

async function loadProfiles() {
  profiles = (await window.pp?.profiles?.().catch(() => [])) || [];
  if (!Array.isArray(profiles)) profiles = [];
  if (!profiles.length) profiles = [{ ...profile, active: true, mods: 0 }];
  profile = profiles.find((p) => p.active) || profiles[0];
  paintProfile();
  drawVersions();
  paintCopyFrom();
}

/* Settings > Copy from another version: every profile except the one being
   played, since that is where the copy goes. Redrawn whenever the profiles
   change, so switching version on the Profiles page updates it. */
function paintCopyFrom() {
  const sel = $('copyFrom');
  if (!sel) return;
  const others = profiles.filter((p) => p.id !== profile.id);
  sel.textContent = '';
  others.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.mc && p.name !== p.mc ? `${p.name} (${p.mc})` : (p.name || p.mc);
    sel.appendChild(o);
  });
  if (!others.length) {
    const o = document.createElement('option');
    o.textContent = 'No other versions yet';
    sel.appendChild(o);
  }
  sel.disabled = !others.length;
  const go = $('copyGo');
  if (go) go.disabled = !others.length;
}

function paintProfile() {
  // Profiles are named after their version, so "26.3  26.3" said nothing
  // twice. The second line says what the box does instead.
  $('profName').textContent = profile.name && profile.name !== profile.mc ? profile.name : 'Change version';
  // The mods list shows the ACTIVE profile's folder, so the heading says which
  // one that is. Without it "Mods" on a profiles page reads as "all mods".
  ['modsFor', 'dropFor'].forEach((id) => { const el = $(id); if (el) el.textContent = profile.name || profile.mc; });
  setVersion(profile.mc);
}

/* THE VERSION CARDS.
 *
 * A version IS a profile - clicking a card switches to it and makes its
 * folder the first time, there is no naming step. What changed in the rework
 * is what a card says: which Pink Pony build that version's folder actually
 * has, whether LAUNCH will update it, how many mods are in it and when it was
 * last played - the things you would otherwise go digging in folders for.
 *
 * Only versions we publish a client for are shown. The greyed "1.8 - coming
 * soon" tile was a promise and a dead click; it went.
 */
let BUILDS = {};                       // mc version -> newest published client version
let BETA_BUILDS = {};                  // mc version -> newest BETA client version (1.3.0)
let tierState = { premium: false };

/* "2.64.0-beta.2" vs "2.63.4", the way the build function compares them: a
   pre-release is older than the same version without a tag. */
function vcmp(a, b) {
  const sp = (v) => { const [m, ...t] = String(v || '').split('-');
    return { n: m.split('.').map((x) => parseInt(x, 10) || 0), t: t.join('-') }; };
  const A = sp(a), B = sp(b);
  for (let i = 0; i < Math.max(A.n.length, B.n.length); i++) {
    const d = (A.n[i] || 0) - (B.n[i] || 0);
    if (d) return d;
  }
  if (!A.t && B.t) return 1;
  if (A.t && !B.t) return -1;
  const ta = (A.t.match(/\d+/g) || []).map(Number), tb = (B.t.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (ta[i] || 0) - (tb[i] || 0);
    if (d) return d;
  }
  return A.t.localeCompare(B.t);
}

/* Is this launcher on the beta channel right now? Premium, and switched on. */
function onBeta() { return !!(settings && settings.betaUpdates && tierState.premium); }

/* The build PLAY will install for a version: the beta when that is newer and
   this player is on the beta channel, otherwise the release. */
function latestFor(v) {
  const rel = BUILDS[v] || '', beta = BETA_BUILDS[v] || '';
  return onBeta() && beta && (!rel || vcmp(beta, rel) > 0) ? beta : rel;
}

const lineOf = (v) => String(v).split('.').slice(0, 2).join('.');

/* Switch to a version, making its profile the first time it is asked for.
 * profileAdd both creates and activates, so there is no window where a profile
 * exists but nothing is selected. */
async function useVersion(v) {
  const have = profiles.find((p) => p.mc === v);
  profile = have
    ? await window.pp.profileSelect(have.id)
    : await window.pp.profileAdd(v, v);      // named after the version itself
  await loadProfiles();
  loadJars();                                // a different version, a different mods folder
}

function drawVersions() {
  const grid = $('verGrid');
  if (!grid) return;
  grid.textContent = '';

  // Newest first: 26.x before 1.21, whatever order the rows came back in.
  const byNum = (a, b) => {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    return 0;
  };
  const versions = [...new Set(mcVersions)].sort(byNum);
  const newest = versions[0];

  versions.forEach((v) => {
    const mine = profiles.find((p) => p.mc === v);
    const on = profile.mc === v;
    const latest = latestFor(v);
    // The active profile's jar is known exactly (loadJars reads it); the
    // others come from the file name main.js saw in their folder.
    const installed = on ? (updateInfo.installed || mine?.client || '') : (mine?.client || '');

    const card = document.createElement('div');
    card.className = 'profcard' + (on ? ' on' : '');
    card.innerHTML = `
      <span class="pcbg">${esc(v)}</span>
      <div class="pctop">
        <b class="pcver">${esc(v)}</b>
        ${v === newest ? '<span class="pill hot">NEWEST</span>' : ''}
        ${on ? '<span class="pill sel">SELECTED</span>' : ''}
      </div>
      <div class="pcstats">
        <div><i>PINK PONY</i><b>${
          !installed ? (latest ? esc(latest) + ' <em>installs on first launch</em>' : '&mdash;')
          : installed === latest || !latest ? esc(installed) + ' <em class="pcok">up to date</em>'
          : esc(installed) + ` <em class="pcup">&rarr; ${esc(latest)} on launch</em>`}</b></div>
        <div><i>MODS</i><b>${mine ? mine.mods : 0}</b></div>
        <div><i>LAST PLAYED</i><b>${mine?.lastPlayed ? esc(ago(mine.lastPlayed)) : 'Never'}</b></div>
      </div>
      <div class="pcact"></div>`;

    const act = card.querySelector('.pcact');
    const playBtn = document.createElement('button');
    playBtn.className = 'solid small pcplay';
    playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>PLAY ' + esc(v);
    playBtn.onclick = async () => {
      if (!on) await useVersion(v);
      showPage('home');
      startGame();
    };
    act.appendChild(playBtn);

    if (!on) {
      const sel = document.createElement('button');
      sel.className = 'ghost';
      sel.textContent = 'Select';
      sel.onclick = () => useVersion(v);
      act.appendChild(sel);
    }
    if (mine) {
      const folder = document.createElement('button');
      folder.className = 'ghost';
      folder.textContent = 'Folder';
      folder.title = 'Open this version’s game folder';
      folder.onclick = () => window.pp?.openPlace?.('profile', mine.id);
      act.appendChild(folder);
    }
    // Clicking anywhere on a card that is not a button selects it.
    card.onclick = (e) => { if (!on && !e.target.closest('button')) useVersion(v); };
    grid.appendChild(card);
  });

  // Point releases, only when the line in play actually has more than one.
  const picks = $('verPicks');
  if (picks) {
    picks.textContent = '';
    const have = versions.filter((v) => lineOf(v) === lineOf(profile.mc));
    picks.hidden = have.length < 2;
    if (have.length > 1) {
      have.forEach((v) => {
        const chip = document.createElement('button');
        chip.className = 'verchip' + (v === profile.mc ? ' on' : '');
        chip.textContent = v;
        chip.onclick = () => useVersion(v);
        picks.appendChild(chip);
      });
    }
  }
}

/* ---------------- installed mods ---------------- */
/* Whatever is in the mods folder, ours and anything dropped in from Modrinth,
   CurseForge or a Discord attachment. Names come from each jar's own
   fabric.mod.json, so the list is about mods rather than filenames.

   Disabling renames to .jar.disabled instead of deleting: Fabric ignores it,
   the file stays where it was put, and turning it back on is the same rename
   backwards - which matters for something downloaded once a year ago. */

async function loadJars() {
  const box = $('jarList');
  const jars = (await window.pp?.modsScan?.().catch(() => [])) || [];

  /* Which Pink Pony jar is really on disk - the only honest thing to compare
     a published build against.

     NOT `find(j => j.managed)`, which is what this was. `managed` means "do
     not let them delete this" and it covers Fabric API as well as us; the
     list is then sorted by display name, so "Fabric API" sorts ahead of
     "Pink Pony" and that find returned the API's version - 0.116.15+1.21.1,
     which can never equal a client version. The home page therefore announced
     an update on every launch, including the launch that had just installed
     the newest build, which is the fastest way to teach somebody to ignore
     the notification entirely.

     Match on the mod id, which is ours and nobody else's. The filename
     fallback covers a jar too broken to read a fabric.mod.json out of. */
  const ours = jars.find((j) => j.id === 'pinkpony')
            || jars.find((j) => /^pinkpony/i.test(j.file || ''));
  updateInfo.installed = String(ours?.version || '');
  drawNotifications();
  drawVersions();                     // the selected card says which build it has

  // The installed version above matters on every page; the list below only
  // exists on Profiles. Work that out first, draw second.
  if (!box) return;
  box.textContent = '';

  const on = jars.filter((j) => j.enabled).length;
  const count = $('modsCount');
  if (count) count.textContent = jars.length ? `${jars.length} installed · ${on} on` : '';

  if (!jars.length) {
    box.innerHTML = '<div class="modempty small"><h3>No mods yet</h3>'
      + '<p>Pink Pony and Fabric API install themselves the first time you press PLAY. '
      + 'Drop any other mod here.</p></div>';
    return;
  }

  // Pink Pony and what it needs first, then everything the player added.
  const managed = jars.filter((j) => j.managed), theirs = jars.filter((j) => !j.managed);
  const group = (label, list) => {
    if (!list.length) return;
    const h = document.createElement('p');
    h.className = 'jargroup';
    h.textContent = label;
    box.appendChild(h);
    list.forEach((j) => box.appendChild(jarRow(j)));
  };
  group('INSTALLED BY PINK PONY', managed);
  group('YOUR MODS', theirs);
  loadShaders();
  if (!theirs.length) {
    box.insertAdjacentHTML('beforeend',
      '<p class="jarnone">No mods of your own yet. Drop a .jar on this page to add one.</p>');
  }
}

/* A letter tile rather than a guessed icon: mod jars carry an icon path, but
   reading images out of zips from the renderer is not worth the bridge. */
function jarRow(j) {
  const row = document.createElement('div');
  row.className = 'jar' + (j.enabled ? '' : ' off') + (j.managed ? ' managed' : '');
  const letter = (String(j.name || j.file).match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
  row.innerHTML =
    `<span class="jaricon">${j.id === 'pinkpony' ? '<i class="ppmark"></i>' : esc(letter)}</span>
     <span class="jarmeta">
       <b>${esc(j.name)}
         ${j.version ? `<span class="jarver">${esc(j.version)}</span>` : ''}
         ${j.id === 'pinkpony' && updateInfo.latest && j.version && j.version !== updateInfo.latest
           ? `<span class="jarup">${esc(updateInfo.latest)} on next launch</span>` : ''}</b>
       <i>${esc(j.description || j.file)}</i>
     </span>`;

  const toggle = document.createElement('button');
  toggle.className = 'sw2';
  toggle.setAttribute('aria-pressed', String(j.enabled));
  toggle.setAttribute('aria-label', j.name);
  toggle.title = j.enabled ? 'Turn off' : 'Turn on';
  toggle.onclick = async () => {
    if (j.shader && j.enabled
        && !confirm(`Turn off ${j.name}? Shaders need it - the Shaders switch above turns them off properly.`)) return;
    if (j.managed && !j.shader && j.enabled
        && !confirm(`Turn off ${j.name}? Pink Pony will not load without it.`)) return;
    await window.pp.modsFile('toggle', j.file);
    loadJars();
  };
  row.appendChild(toggle);

  const del = document.createElement('button');
  del.className = 'more';
  del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
  del.title = 'Delete ' + j.file;
  del.onclick = async () => {
    // Managed jars get a warning rather than a block: it is their folder,
    // but deleting the client and then wondering where it went is a support
    // message nobody enjoys either end of.
    const warn = j.managed
      ? `${j.name} is part of Pink Pony. The launcher will reinstall it next launch.\n\nDelete anyway?`
      : `Delete ${j.file}?`;
    if (!confirm(warn)) return;
    await window.pp.modsFile('remove', j.file);
    loadJars();
  };
  row.appendChild(del);
  return row;
}

/* ---------------- shaders (1.2.9) ----------------
   One switch per profile. ON installs Sodium + Iris on the next PLAY (main.js
   ensureShaders); the packs come from a short list main.js keeps, download
   into this profile's shaderpacks folder and become the one Iris uses. Any
   pack the player drops in the folder shows up as a chip to pick. */
let shaderBusy = '';

async function loadShaders() {
  const panel = $('shaderPanel');
  if (!panel || !window.pp?.shaders) return;
  const st = await window.pp.shaders().catch(() => null);
  if (!st) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.classList.toggle('off', !st.on);
  $('shaderFor').textContent = st.mc || '';
  const sw = $('shaderSwitch');
  sw.setAttribute('aria-pressed', String(st.on));
  sw.title = st.on ? 'Turn shaders off' : 'Turn shaders on';
  $('shaderHint').textContent = !st.on
    ? 'Off. Turn on and Sodium + Iris install the next time you press PLAY.'
    : !st.installed
      ? 'On - Sodium and Iris install when you press PLAY. Pick a pack below.'
      : st.active
        ? `On, using ${st.active}. In game: Options > Video Settings > Shader Packs to change its settings.`
        : 'On. Pick a pack below - or play with none for Sodium\'s extra FPS.';

  const grid = $('packGrid');
  grid.textContent = '';
  for (const k of st.packs) {
    const card = document.createElement('div');
    const active = !!k.file && st.active === k.file;
    card.className = 'pack' + (active ? ' active' : '');
    card.innerHTML = `<div class="packtop"><b>${esc(k.name)}</b><span class="packtag">${esc(k.tag)}</span></div>
                      <p>${esc(k.blurb)}</p>`;
    const b = document.createElement('button');
    b.className = 'packbtn' + (active ? ' on' : k.file ? '' : ' go');
    b.textContent = shaderBusy === k.slug ? 'Downloading…' : active ? 'In use' : k.file ? 'Use' : 'Get';
    b.disabled = !!shaderBusy || active;
    b.onclick = async () => {
      const hint = $('shaderHint');
      try {
        if (k.file) {
          await window.pp.shaderUse(k.file);
        } else {
          shaderBusy = k.slug;
          loadShaders();
          await window.pp.shaderGet(k.slug);
          if (!st.on) await window.pp.shadersSet(true);     // getting a pack means you want shaders
        }
      } catch (e) {
        if (hint) hint.textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        shaderBusy = '';
        return;
      }
      shaderBusy = '';
      loadShaders();
    };
    card.appendChild(b);
    grid.appendChild(card);
  }

  const others = $('packOthers');
  others.textContent = '';
  if (st.others.length || st.active) {
    others.insertAdjacentHTML('beforeend', '<span class="jargroup">IN YOUR FOLDER</span>');
    for (const f of st.others) {
      const c = document.createElement('button');
      c.className = 'packchip' + (st.active === f ? ' active' : '');
      c.textContent = f.replace(/\.zip$/i, '');
      c.title = st.active === f ? 'In use' : 'Use ' + f;
      c.onclick = () => window.pp.shaderUse(f).then(loadShaders).catch((e) => {
        $('shaderHint').textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      });
      others.appendChild(c);
    }
    if (st.active) {
      const none = document.createElement('button');
      none.className = 'packchip';
      none.textContent = 'No pack';
      none.title = 'Keep Sodium, switch the shader pack off';
      none.onclick = () => window.pp.shaderUse('').then(loadShaders).catch(() => {});
      others.appendChild(none);
    }
  }
}

function wireShaders() {
  const sw = $('shaderSwitch');
  if (!sw) return;
  sw.onclick = async () => {
    const on = sw.getAttribute('aria-pressed') !== 'true';
    await window.pp.shadersSet(on).catch(() => {});
    loadShaders();
    loadJars();
  };
  $('shaderFolder').onclick = () => window.pp?.shadersFolder?.();
}

function wireJars() {
  const folder = $('modsFolder');
  if (!folder) return;
  folder.onclick = () => window.pp?.modsFolder?.();
  $('modsRescan').onclick = () => loadJars();

  /* Drag a jar onto the Profiles page and it lands in this version's mods
     folder. The page takes the drop anywhere, not just on a small target -
     aiming a file at a strip is fiddly. Everything else dropped on the window
     is refused, so a stray drop never navigates the launcher to a file. */
  const page = document.querySelector('.page[data-page="profiles"]');
  const zone = $('dropZone');
  let depth = 0;
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  page?.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone?.classList.add('hot'); });
  page?.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone?.classList.remove('hot'); } });
  page?.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    zone?.classList.remove('hot');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const res = await window.pp?.addMods?.(files).catch(() => null);
    const hint = $('modsHint');
    if (hint && res) {
      hint.textContent = res.added.length
        ? `Added ${res.added.join(', ')}.` + (res.skipped.length ? ` Skipped ${res.skipped.map((x) => `${x.name} (${x.why})`).join(', ')}.` : '')
        : `Nothing added: ${res.skipped.map((x) => `${x.name} (${x.why})`).join(', ') || 'no files'}.`;
    }
    loadJars();
    loadProfiles();
  });
}

/* ---------------- launching ---------------- */
const play = $('play');
const progress = $('progress');
const bar = $('bar');
const progressText = $('progressText');

/* One way in, so a server card gets the same progress bar and the same error
   text as the big PLAY button instead of failing silently. */
play.onclick = (opts) => startGame(opts?.server);

async function startGame(server) {
  if (!window.pp) { launchNote('Launcher backend not connected.'); return; }
  play.disabled = true;
  progress.hidden = false;
  setProgress(0, 'Preparing…');
  try {
    await window.pp.launch({ version: version.value, server });
  } catch (e) {
    // Electron wraps anything thrown in an IPC handler, so the useful part is
    // buried behind "Error invoking remote method 'launch':".
    const msg = String(e?.message || e).replace(/^.*?Error:\s*/, '');
    setProgress(0, msg, true);
    play.disabled = false;
  }
}

/* main.js reports download and launch progress through here */
window.pp?.onProgress(({ percent, text, done, failed }) => {
  setProgress(percent, text);
  // LAUNCH is what installs a new client jar, so the moment the game is up
  // (and again when it closes) the jar on disk is a different one. The
  // installed version used to be read once, at boot, so the bell kept saying
  // "2.60.4 is out - you have 2.60.2" after 2.60.4 was installed and played,
  // until the launcher was restarted.
  if (done || failed || text === 'Launched') loadJars();
  if (done || failed) {
    play.disabled = false;
    if (done) setTimeout(() => { progress.hidden = true; }, 1400);
  }
});

function setProgress(pct, text, failed) {
  bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  progressText.textContent = text || '';
  progress.classList.toggle('failed', !!failed);
}
/* The launch strip's message. Renamed when the settings page arrived with a
   note() of its own - two functions with one name is a bug waiting to be
   confusing rather than loud. */
function launchNote(t) { progress.hidden = false; setProgress(0, t); }

/* ---------------- account ---------------- */
let account = null;
let accounts = { accounts: [], active: null };

const faceUrl = (uuid, size) =>
  `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/${size}`;

/* The header button opens the switcher rather than signing in directly. With
   one account that is one extra click; with three it is the only way to change
   which one launches, and a launcher that can only ever use the account you
   happened to add first is a launcher people keep signing out of. */
$('acct').onclick = () => {
  const menu = $('accMenu');
  if (!menu) return;
  menu.hidden = !menu.hidden;
  if (!menu.hidden) drawAccounts();
};

document.addEventListener('click', (e) => {
  const menu = $('accMenu');
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && !$('acct').contains(e.target)) menu.hidden = true;
});

async function loadAccounts() {
  accounts = (await window.pp?.accounts?.().catch(() => null))
             || { accounts: [], active: null };
  // Normalised rather than trusted. A malformed reply here used to throw
  // partway through boot, which took out every page wired after this one -
  // the friends column included. One missing array is not worth a dead window.
  if (!Array.isArray(accounts.accounts)) accounts.accounts = [];
  const active = accounts.accounts.find((a) => a.uuid === accounts.active);
  if (active) showAccount(active); else clearAccount();
  drawAccounts();
  drawNotifications();
}

function drawAccounts() {
  paintSettingsAccounts();                 // Settings > Account lists the same accounts
  const box = $('accList');
  if (!box) return;
  box.textContent = '';

  if (!accounts.accounts.length) {
    box.innerHTML = '<p class="accmenuhead" style="margin:2px 6px 6px">Nobody signed in yet.</p>';
    return;
  }

  accounts.accounts.forEach((a) => {
    const on = a.uuid === accounts.active;
    const row = document.createElement('button');
    row.className = 'accrow' + (on ? ' on' : '');
    row.innerHTML =
      `<span class="accface" style="background-image:url('${faceUrl(a.uuid, 32)}')"></span>
       <b>${esc(a.name)}</b>${on ? '<span class="tick">&#10003;</span>' : ''}`;
    row.onclick = async (e) => {
      e.stopPropagation();
      accounts = await window.pp.selectAccount(a.uuid);
      afterAccountChange();
    };

    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '\u00d7';
    x.title = 'Remove ' + a.name;
    x.onclick = async (e) => {
      e.stopPropagation();
      accounts = await window.pp.removeAccount(a.uuid);
      afterAccountChange();
    };
    row.appendChild(x);
    box.appendChild(row);
  });
}

function afterAccountChange() {
  const list = Array.isArray(accounts.accounts) ? accounts.accounts : [];
  const active = list.find((a) => a.uuid === accounts.active);
  if (active) showAccount(active); else clearAccount();
  drawAccounts();
}

function clearAccount() {
  account = null;
  $('acctName').textContent = 'Sign in';
  $('acctTier').textContent = 'Not connected';
  $('acctFace').style.backgroundImage = '';
  $('featSkin').style.backgroundImage = '';
  loadTiles(null);
  loadCosmetics(null);
}

$('accAdd').onclick = async () => {
  $('accMenu').hidden = true;
  if (!window.pp) return;
  try {
    accounts = await window.pp.signIn();
    afterAccountChange();
  } catch (e) {
    launchNote('Sign-in failed: ' + (e?.message || e));
  }
};

function showAccount(acc) {
  account = acc;
  $('acctName').textContent = acc.name;
  $('acctTier').textContent = accounts.accounts.length > 1
    ? `${accounts.accounts.length} accounts` : 'Signed in';
  if (acc.uuid) {
    $('acctFace').style.backgroundImage = `url(${faceUrl(acc.uuid, 64)})`;
    $('featSkin').style.backgroundImage =
      `url(https://mc-heads.net/body/${encodeURIComponent(acc.uuid)}/220)`;
    loadTiles(acc.name);
    loadCosmetics(acc.name);
  }
}

/* ---------------- content from Supabase ---------------- */
/* The same project the client and the website use. Read only, publishable key
   - exactly what the website already does in the open. */
const SB = 'https://bqqelxngcqubuskfwnvy.supabase.co';
const KEY = 'sb_publishable_SDzCCGzoap9fpUuwlA07Jg_EZFD4FQk';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };

async function rest(path) {
  try {
    const r = await fetch(SB + path, { headers: H });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

const art = (file) =>
  `${SB}/storage/v1/object/public/cosmetics/${encodeURIComponent(file)}`;

/* One cape panel, correctly cropped and correctly shaped.
 *
 *   width  10/64 of the sheet -> background-size x = 100/(10/64) = 640%
 *   height 16/32              ->                 y = 100/(16/32) = 200%
 *
 * Background-position in per-cent is a fraction of the LEFTOVER space, not of
 * the image, so the offsets are x0/(1-w) rather than x0. That is the bit that
 * is easy to get wrong and lands you one strip to the left.
 */
function capePanel(url) {
  const i = document.createElement('i');
  i.className = 'capepanel';
  // CAPE_UV, not a second copy of the same numbers. It is declared further
  // down and read at call time, which is fine - and one definition means the
  // home column cannot drift away from the Cosmetics page the way it just did.
  i.style.cssText = `background-image:url('${url}');` + CAPE_UV;
  return i;
}

/* ---------------- recent activity ---------------- */
/* Real events only. main.js records a launch, an install and a sign-in as they
   happen; there are no others, so an empty list stays empty rather than being
   padded out with things that never occurred. */
const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  cos:  '<path d="M8 4l4 2 4-2 4 3-3 3v10H7V10L4 7z"/>',
  up:   '<path d="M12 19V5M5 12l7-7 7 7"/>',
  join: '<circle cx="12" cy="8" r="3.2"/><path d="M4 20a8 8 0 0 1 16 0"/>'
};

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.round(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

async function loadActivity() {
  const box = $('acts');
  if (!box) return;
  const rows = (await window.pp?.history?.().catch(() => [])) || [];
  box.textContent = '';

  if (!rows.length) {
    box.innerHTML = '<div class="act" style="color:var(--dim);font-size:12.5px;padding:10px 0">'
      + 'Nothing yet - launch the game and it shows up here.</div>';
    return;
  }

  rows.slice(0, 4).forEach((a) => {
    const d = document.createElement('div');
    d.className = 'act';
    d.innerHTML =
      `<span class="actico"><svg viewBox="0 0 24 24">${ICONS[a.kind] || ICONS.play}</svg></span>
       <span class="actxt"><b>${esc(a.text)}</b><i>${esc(a.detail || '')}</i></span>
       <span class="actwhen">${esc(ago(a.at))}</span>`;
    box.appendChild(d);
  });
}

/* ---------------- latest update ---------------- */
/* The build row for the selected version - its number and its notes - rather
   than a hardcoded "Hoofbeat Update" that would be a lie the day after it
   shipped. Notes are one per line in the database. */
/* The version picker offered 1.21.4, 1.21.5 and 1.8.9 with no builds behind
   any of them - three ways to hit "no build for that version". It lists what
   client_builds actually has. */
async function loadVersions() {
  const rows = await rest('/rest/v1/client_builds?select=mc_version,client_version'
                          + '&listed=eq.true&order=mc_version.desc');
  if (!rows.length) return;             // offline: keep whatever we have
  mcVersions = rows.map((r) => r.mc_version);
  BUILDS = Object.fromEntries(rows.map((r) => [r.mc_version, String(r.client_version || '')]));
  const betas = await rest('/rest/v1/client_builds_beta?select=mc_version,client_version&listed=eq.true')
    .catch(() => []);
  BETA_BUILDS = Object.fromEntries((Array.isArray(betas) ? betas : [])
    .map((r) => [r.mc_version, String(r.client_version || '')]));
  // The profiles page draws its version tiles from this, so it has to repaint
  // when the list arrives - the first render happens before this resolves.
  drawVersions();
}

async function loadUpdate() {
  const rows = await rest('/rest/v1/client_builds?select=client_version,notes,updated_at'
                          + '&listed=eq.true&mc_version=eq.' + encodeURIComponent(version.value));
  let build = rows[0];
  let beta = false;
  if (onBeta()) {
    const b = (await rest('/rest/v1/client_builds_beta?select=client_version,notes,updated_at'
                          + '&listed=eq.true&mc_version=eq.' + encodeURIComponent(version.value))
               .catch(() => []))[0];
    if (b && (!build || vcmp(b.client_version, build.client_version) > 0)) { build = b; beta = true; }
  }
  const title = document.querySelector('.update h3');
  const list = document.querySelector('.ticks');
  const tag = $('updVer');

  if (!build) {
    if (title) title.textContent = 'No build yet';
    if (list) list.innerHTML = '<li>Nothing published for this version.</li>';
    return;
  }

  if (tag) tag.textContent = 'v' + build.client_version;
  if (title) title.textContent = 'Pink Pony ' + build.client_version + (beta ? ' (beta)' : '');
  updateInfo.latest = String(build.client_version || '');
  drawNotifications();
  if (list) {
    const notes = String(build.notes || '').split('\n').map((n) => n.trim()).filter(Boolean);
    list.textContent = '';
    (notes.length ? notes : ['No notes for this build.']).forEach((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      list.appendChild(li);
    });
  }
}

/* ---------------- premium ---------------- */
/* One tier since 2026-09-25: Premium, $5.99 a month (was $5 until 1.2.5), never auto-charged. The
   card in the rail says what you actually have rather than always
   advertising - somebody already paying being shown "UPGRADE" is how a
   purchase stops feeling like it did anything.

   The build function answers tier "pony" for Premium (and `premium: true`);
   "plus" is still accepted here in case an older function answers. */
async function loadTier() {
  const status = await window.pp?.licenceStatus?.().catch(() => null);
  const card = document.querySelector('.plus');
  if (!card || !status) return;

  const head = card.querySelector('.plushead b');
  const body = card.querySelector('p');
  const button = card.querySelector('.up');

  const until = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
  };

  const premium = status.premium === true || status.tier === 'pony' || status.tier === 'plus';
  const ends = premium && !status.lifetime ? (status.paid_until || '') : '';
  const wasBeta = onBeta();
  tierState.premium = premium;
  paintBeta();
  loadCloud();
  if (onBeta() !== wasBeta) { loadUpdate(); drawVersions(); }

  head.textContent = 'PREMIUM';
  if (premium) {
    body.textContent = ends ? 'Active until ' + until(ends) + '.' : 'Active - no end date.';
    button.textContent = ends ? 'ADD A MONTH' : 'MANAGE';
  } else {
    body.textContent = '$5.99 a month, never auto-charged.';
    button.textContent = 'GET PREMIUM';
  }

  button.onclick = () => window.pp?.open?.('https://pinkponyclient.com/store.html#premium');

  setupState.premiumUntil = ends;
  drawNotifications();

  if (account) {
    $('acctTier').textContent = premium ? 'PREMIUM member'
                              : (accounts.accounts.length > 1
                                  ? `${accounts.accounts.length} accounts` : 'Signed in');
  }
}

/* ---------------- featured servers ---------------- */
/* The server list is the owner's, not the player's. It comes from
   featured_servers in Supabase (staff set it with /featured in Discord), so
   there is no Add and no Remove here: the same pinned list shows in every
   launcher, and in game at the top of Multiplayer. Anything a player saved
   with an older launcher stays in settings.json untouched; it is just not
   shown. Counts are REAL - main.js speaks the server-list-ping protocol. */
let SERVERS = [];
let serversLoaded = false;
const pings = {};   // address -> {online, players, max, ms}

const SRVICO =
  '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>'
+ '<path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>';

/* Five minutes is plenty for a list that changes when the owner types a
   command, and it is one small request per launcher. */
const FEATURED_EVERY = 5 * 60 * 1000;
async function loadFeaturedServers() {
  const rows = await rest('/rest/v1/featured_servers?select=name,ip,tag,position'
                          + '&order=position.asc,name.asc');
  const clean = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.ip === 'string'
                   && /^[a-z0-9.\-]+(:\d{1,5})?$/.test(r.ip.toLowerCase()))
    .map((r) => ({ name: String(r.name || r.ip).slice(0, 40), ip: r.ip.toLowerCase(),
                   tag: String(r.tag || 'FEATURED').slice(0, 16) }));
  const changed = JSON.stringify(clean) !== JSON.stringify(SERVERS);
  SERVERS = clean;
  serversLoaded = true;
  if (changed) { loadServers(); pingAll(); }
}

function loadServers() {
  const box = $('servers');
  if (!box) return;
  box.textContent = '';

  if (!SERVERS.length) {
    const none = document.createElement('div');
    none.className = 'addsrv';
    none.textContent = serversLoaded ? 'NO FEATURED SERVERS YET' : 'LOADING…';
    box.appendChild(none);
    return;
  }

  SERVERS.slice(0, 5).forEach((s) => {
    const p = pings[s.ip];
    const b = document.createElement('button');
    b.className = 'scard';
    b.title = s.ip;
    b.innerHTML =
      `<div class="srow">
         <span class="sico"><svg viewBox="0 0 24 24">${SRVICO}</svg></span>
         <b>${esc(s.name)}</b>
       </div>
       <div class="count"><span class="led${p?.online ? '' : ' off'}"></span>
         ${p ? (p.online ? p.players + ' online' : 'offline') : 'checking…'}</div>`;
    b.onclick = () => { showPage('home'); startGame(s.ip); };
    box.appendChild(b);
  });
}

/* ---------------- cosmetic tiles ---------------- */
/* What this account owns, from cosmetic_grants. Four tiles and a "+n" so the
   column keeps its shape whether they own three things or three hundred. */
async function loadTiles(name) {
  const box = $('tiles');
  box.textContent = '';

  const rows = name
    ? await rest('/rest/v1/cosmetic_grants?select=kind,value&player=eq.'
                 + encodeURIComponent(name.toLowerCase()))
    : [];

  const wearable = rows.filter((g) => g.kind !== 'tag');

  const blank = (why) => {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    d.title = why;
    return d;
  };
  const why = name ? 'Nothing here yet' : 'Sign in to see your cosmetics';

  if (!wearable.length) {
    for (let i = 0; i < 4; i++) box.appendChild(blank(why));
    return;
  }

  const shown = wearable.slice(0, 4);
  shown.forEach((g) => {
    const d = document.createElement('button');
    d.className = 'tile';
    d.title = pretty(g.value) + ' · ' + g.kind;
    // Same shaped element as the featured panel above - see the note there.
    if (g.kind === 'cape') {
      d.appendChild(capePanel(art(g.value)));
    } else {
      d.style.backgroundImage = `url('${art(g.value)}')`;
    }
    box.appendChild(d);
  });

  /* Pad back out to four. `.tiles` is grid-template-columns:repeat(4,1fr), so
     owning ONE cape drew one tile and left three empty columns beside it -
     which reads as artwork that failed to load, not as "you own one thing".
     The zero case was already padded; every other short case was not, and
     one-to-three is the case almost everybody is actually in. */
  for (let i = shown.length; i < 4; i++) box.appendChild(blank(why));

  if (wearable.length > 4) {
    const more = document.createElement('button');
    more.className = 'tile more2';
    more.textContent = '+' + (wearable.length - 4);
    box.appendChild(more);
  }
}

/* ---------------- featured cosmetic ---------------- */
/* The home hero's small feature panel.
 *
 * Was querying `item` and ordering by `created_at`, neither of which exists on
 * that table, so it 400ed every time and the panel silently kept its fallback
 * gradient. Now it asks for `value` ordered by `sort`, and it does not insist
 * on a cape: the catalogue currently has none, and "newest cape" that matches
 * nothing is an empty panel where a headband would have done.
 */
async function loadFeatured() {
  const rows = await rest('/rest/v1/cosmetic_catalog'
    + '?select=label,value,kind,price&listed=eq.true&kind=neq.tag&order=sort.asc&limit=1');
  const f = rows[0];
  const nameEl = document.querySelector('.featname');
  const subEl = document.querySelector('.featsub');

  /* Nothing listed to feature. This used to just `return`, which left the
     placeholder markup showing - and the placeholder named a cosmetic that
     does not exist. Nothing listed is a true and perfectly sayable state:
     every non-tag row in the catalogue is currently listed=false, so this is
     the branch that actually runs today, not a rare fallback. */
  if (!f) {
    $('featArt').style.backgroundImage = '';
    if (nameEl) nameEl.textContent = 'Nothing featured yet';
    if (subEl) subEl.textContent = 'New cosmetics show up here.';
    return;
  }

  /* A CAPE FILE IS A SHEET, NOT A PICTURE - and it is not square either. The
     visible panel is 10x16 of a 64x32 layout, so cropping alone is only half
     the job: painted as the background of a square box it comes out cropped
     correctly and then stretched wide, which is what "it looks off" was.
     .capepanel carries aspect-ratio:10/16, which is why the Cosmetics card
     has always looked right while this panel did not. Same element here. */
  const fa = $('featArt');
  fa.textContent = '';
  fa.classList.toggle('capeart', f.kind === 'cape');
  if (f.kind === 'cape') {
    fa.style.backgroundImage = '';       // let the CSS gradient show behind it
    fa.appendChild(capePanel(art(f.value)));
  } else {
    fa.style.backgroundImage = `url('${art(f.value)}')`;
  }
  if (nameEl) nameEl.textContent = f.label || pretty(f.value);
  if (subEl) subEl.textContent =
    (f.price ? f.price + ' · ' : '') + String(f.kind || '').toUpperCase();
}

/* ---------------- friends ---------------- */
/* Real friends. The launcher sends the access code and the name of the SIGNED
   IN account - the renderer never gets to say who it is - and the edge function
   decides everything else. Presence comes from the game itself, so somebody is
   shown as online because their client checked in within the last ninety
   seconds, not because we assumed they were. The placeholder list that used to
   live here invented four people; a launcher that makes up friends cannot be
   trusted about anything else on the page. */

let friendsState = { friends: [], incoming: [], outgoing: [] };

function fnote(text, good = false) {
  const el = $('friendNote');
  if (!el) return;
  el.style.color = good ? 'var(--good)' : 'var(--pink)';
  el.textContent = text;
  clearTimeout(fnote._t);
  fnote._t = setTimeout(() => { el.textContent = ''; }, 3200);
}

function fempty(text) {
  return `<div class="frow fempty">${esc(text)}</div>`;
}

async function loadFriends() {
  const box = $('friends');
  if (!box) return;

  const res = await window.pp?.friends?.('list').catch(() => null);
  box.textContent = '';
  $('friendCount').textContent = '';

  if (!res?.ok) {
    // Every one of these is a thing the user can actually fix, so say which.
    box.innerHTML = fempty({
      no_code:       'Add your access code in Settings to use friends.',
      not_signed_in: 'Sign in to see your friends.',
      wrong_account: 'That code is bound to another Minecraft account.',
      invalid_code:  "That code isn't active any more.",
      offline:       "Can't reach Pink Pony right now."
    }[res?.reason] || 'Friends are unavailable right now.');
    return;
  }

  friendsState = res;
  const online = res.friends.filter((f) => f.online).length;
  if (res.friends.length) $('friendCount').textContent = online + ' ONLINE';

  // Requests come first. A pending request sitting under a long friends list
  // is a request nobody ever answers.
  if (res.incoming.length) {
    box.appendChild(fsection('WANTS TO BE FRIENDS'));
    res.incoming.forEach((name) => box.appendChild(requestRow(name, true)));
  }

  if (res.friends.length) {
    if (res.incoming.length) box.appendChild(fsection('FRIENDS'));
    res.friends
      .slice()
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .forEach((f) => box.appendChild(friendRow(f)));
  } else if (!res.incoming.length && !res.outgoing.length) {
    box.insertAdjacentHTML('beforeend',
      fempty('Nobody yet. Add someone by their username below.'));
  }

  if (res.outgoing.length) {
    box.appendChild(fsection('SENT'));
    res.outgoing.forEach((name) => box.appendChild(requestRow(name, false)));
  }

  drawNotifications();
}

function fsection(label) {
  const p = document.createElement('p');
  p.className = 'fsection';
  p.textContent = label;
  return p;
}

function head(name, off) {
  return `<span class="fface${off ? ' off' : ''}"
      style="background-image:url('https://mc-heads.net/avatar/${encodeURIComponent(name)}/64')"></span>`;
}

function friendRow(f) {
  const row = document.createElement('div');
  row.className = 'frow';
  const where = f.online ? (f.status || 'Online') : 'Offline';
  row.innerHTML = head(f.name, !f.online)
    + `<span class="fmeta"><b>${esc(f.name)}</b><i>${esc(where)}</i></span>`;

  const act = document.createElement('span');
  act.className = 'act';

  // JOIN only shows when there is somewhere to actually follow them to. An
  // always-visible button that usually does nothing trains people to ignore it.
  if (f.online && f.server) {
    const join = document.createElement('button');
    join.className = 'mini';
    join.textContent = 'JOIN';
    join.title = 'Launch and connect to ' + f.server;
    join.onclick = () => play.onclick({ server: f.server });
    act.appendChild(join);
  }

  act.appendChild(danger('REMOVE', async () => {
    if (!confirm(`Remove ${f.name} from your friends?`)) return;
    await window.pp.friends('remove', f.name);
    loadFriends();
  }));

  row.appendChild(act);
  return row;
}

function requestRow(name, incoming) {
  const row = document.createElement('div');
  row.className = 'frow';
  row.innerHTML = head(name, true)
    + `<span class="fmeta"><b>${esc(name)}</b>`
    + `<i>${incoming ? 'Sent you a request' : 'Request sent'}</i></span>`;

  const act = document.createElement('span');
  act.className = 'act';

  if (incoming) {
    const yes = document.createElement('button');
    yes.className = 'mini';
    yes.textContent = 'ACCEPT';
    yes.onclick = async () => {
      await window.pp.friends('accept', name);
      fnote(`You and ${name} are now friends.`, true);
      loadFriends();
    };
    act.appendChild(yes);
  }

  // Decline and cancel are the same verb server-side: drop the row.
  act.appendChild(danger(incoming ? 'DECLINE' : 'CANCEL', async () => {
    await window.pp.friends('remove', name);
    loadFriends();
  }));

  row.appendChild(act);
  return row;
}

function danger(label, fn) {
  const b = document.createElement('button');
  b.className = 'mini ghosty';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function wireFriends() {
  const add = $('friendAdd');
  if (!add) return;

  const send = async () => {
    const box = $('friendName');
    const name = box.value.trim();
    if (!name) return;
    // Checked here so an obvious typo costs nothing; the function checks again,
    // because a renderer check is a convenience and never a control.
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      fnote("That isn't a Minecraft username.");
      return;
    }

    add.disabled = true;
    const res = await window.pp.friends('add', name).catch(() => null);
    add.disabled = false;

    if (!res?.ok) {
      fnote({
        thats_you:     "That's you.",
        too_many:      'That is a lot of friends.',
        no_code:       'Add your access code in Settings first.',
        not_signed_in: 'Sign in first.',
        wrong_account: 'That code is bound to another Minecraft account.',
        invalid_code:  "That code isn't active any more."
      }[res?.reason] || "Couldn't send that request.");
      return;
    }

    box.value = '';
    fnote(res.accepted ? `You and ${name} are now friends.`
        : res.already  ? `You are already friends with ${name}.`
        :                `Request sent to ${name}.`, true);
    loadFriends();
  };

  add.onclick = send;
  $('friendName').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $('friendsRefresh').onclick = () => loadFriends();

  // Presence goes stale after ninety seconds, so a minute keeps the dots
  // honest without hammering the function.
  setInterval(loadFriends, 60_000);
}

/* ---------------- settings ---------------- */
/* Every control saves the moment it changes. No Save button except on the
   access code, where typing half of one and having it saved would be worse
   than useless - it would be checked against the server on the next launch and
   rejected. */

let settings = null;

function note(text, good = true) {
  const el = $('setNote');
  if (!el) return;
  el.style.color = good ? 'var(--good)' : 'var(--pink)';
  el.textContent = text;
  clearTimeout(note._t);
  note._t = setTimeout(() => { el.textContent = ''; }, 2600);
}

async function loadSettings() {
  // Read here too so the bell can say "no access code" - it is the single
  // setting that silently disables cosmetics, friends and the download.
  window.pp?.settingsRead?.().then((s) => {
    setupState.noCode = !s?.code;
    drawNotifications();
  }).catch(() => {});
  settings = await window.pp?.settingsRead?.().catch(() => null);
  if (!settings) { settings = { memory: 4096, javaPath: '', gameDir: '', code: '',
                                closeOnLaunch: true, keepLogs: false }; }
  paintSettings();
  loadServers();
  loadFeaturedServers();
  if (!loadSettings.featuredTimer) {
    loadSettings.featuredTimer = setInterval(loadFeaturedServers, FEATURED_EVERY);
  }
}

/* Stored in MB because that is what the java flag takes; shown in GB because
   that is what anybody actually thinks in. Halves get a decimal, whole numbers
   do not - "6 GB" rather than "6.0 GB". */
function gb(mb) {
  const v = mb / 1024;
  return (Number.isInteger(v) ? v : v.toFixed(1)) + ' GB';
}

function paintSettings() {
  const mem = $('memRange');
  if (!mem) return;

  // The slider tops out at what this PC has (less 2 GB for Windows), capped at
  // 16 GB - past that Minecraft only gets slower at collecting its garbage.
  const total = Number(settings.totalMemMb) || 16384;
  const max = Math.max(2048, Math.min(16384, Math.floor((total - 2048) / 512) * 512));
  mem.max = max;
  mem.value = Math.min(settings.memory, max);
  $('memVal').textContent = gb(settings.memory);
  $('memMax').textContent = gb(max);
  $('memHint').textContent = total ? `of ${gb(Math.round(total / 1024) * 1024)} in this PC` : '';
  paintMemScale();

  $('javaPath').textContent = settings.javaPath || 'Automatic';
  $('gameDir').textContent = settings.gameDir || settings.defaultGameDir || '.pinkpony';
  $('codeInput').value = settings.code || '';

  const size = $('winSize');
  if (size) {
    const v = `${settings.windowWidth || 0}x${settings.windowHeight || 0}`;
    if (![...size.options].some((o) => o.value === v)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v.replace('x', ' × ');
      size.appendChild(o);
    }
    size.value = v;
  }
  swap($('fullscreen'), settings.fullscreen);
  swap($('closeOnLaunch'), settings.closeOnLaunch);
  swap($('reopenOnClose'), settings.reopenOnClose !== false);
  $('reopenRow')?.classList.toggle('muted', !settings.closeOnLaunch);
  swap($('keepLogs'), settings.keepLogs);
  paintBeta();
  paintCloud();
}

/* Cloud saves (1.3.1): Premium. The launcher syncs when you press PLAY and
   when the game closes; this row shows the last result and can sync now. */
let cloudState = { last: null, lastAt: 0, files: 0, busy: false };
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
}
function paintCloud() {
  const sw = $('cloudSync');
  if (!sw || !settings) return;
  const on = !!settings.cloudSync && tierState.premium;
  swap(sw, on);
  $('cloudRow')?.classList.toggle('muted', !tierState.premium);
  const now = $('cloudNow');
  if (now) { now.hidden = !on; now.disabled = cloudState.busy; now.textContent = cloudState.busy ? 'Syncing…' : 'Sync now'; }
  const hint = $('cloudHint');
  if (!hint) return;
  if (!tierState.premium) {
    hint.textContent = 'Comes with Premium: your HUD layout, settings, macros, waypoints and schematics on any PC.';
  } else if (!on) {
    hint.textContent = 'Your HUD layout, settings, macros, waypoints and schematics follow you to any PC. Synced when you press PLAY and when the game closes.';
  } else {
    const last = cloudState.last;
    const at = (last && last.ok ? last.at : 0) || cloudState.lastAt;
    const mb = last && last.limit ? ` · ${(last.used / 1048576).toFixed(1)} of ${Math.round(last.limit / 1048576)} MB` : '';
    hint.textContent = (at ? `Synced ${ago(at)} · ${cloudState.files || last?.files || 0} files${mb}` : 'On - syncs the next time you press PLAY.')
      + (last && last.note ? ' · ' + last.note : '');
  }
}
async function loadCloud() {
  const st = await window.pp?.cloudStatus?.().catch(() => null);
  if (st) cloudState = { ...cloudState, ...st };
  paintCloud();
}
window.pp?.onCloud?.((sum) => {
  cloudState.last = sum; cloudState.busy = false;
  if (sum && sum.ok) { cloudState.lastAt = sum.at; cloudState.files = sum.files; }
  paintCloud();
});

/* Beta updates (1.3.0): Premium only. Shown to everyone so it is clear what
   Premium adds, switched off and explained for anyone without it. */
function paintBeta() {
  const sw = $('betaUpdates');
  if (!sw || !settings) return;
  swap(sw, !!settings.betaUpdates && tierState.premium);
  $('betaRow')?.classList.toggle('muted', !tierState.premium);
  const hint = $('betaHint');
  if (hint) hint.textContent = tierState.premium
    ? 'Get new builds first, including things still being tested. Turn off to go back to the normal build on your next PLAY.'
    : 'Comes with Premium: new builds first, including things still being tested.';
}

/* A marker on the memory slider where most people should be: 6 GB, or half
   the PC on a small one. Changes nothing - it is a hint, not a limit. */
function paintMemScale() {
  const mem = $('memRange'), rec = $('memRec');
  if (!mem || !rec) return;
  const total = Number(settings?.totalMemMb) || 16384;
  const want = Math.min(6144, Math.max(2048, Math.floor(total / 2 / 512) * 512));
  const pct = (want - Number(mem.min)) / (Number(mem.max) - Number(mem.min)) * 100;
  rec.style.left = Math.max(0, Math.min(100, pct)) + '%';
  rec.textContent = 'Recommended ' + gb(want);
  const v = Number(mem.value);
  mem.style.setProperty('--fill', ((v - mem.min) / (mem.max - mem.min) * 100) + '%');
}

/* Settings > Account: every signed-in Minecraft account, the active one
   first, each removable. Same data as the switcher in the header. */
function paintSettingsAccounts() {
  const box = $('setAccounts');
  if (!box) return;
  box.textContent = '';
  const list = (accounts.accounts || []).slice()
    .sort((a, b) => Number(b.uuid === accounts.active) - Number(a.uuid === accounts.active));
  list.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'saccrow' + (a.uuid === accounts.active ? ' on' : '');
    row.innerHTML = `<span class="sface" style="background-image:url('${faceUrl(a.uuid, 64)}')"></span>
      <span class="accwho"><b>${esc(a.name)}</b><i>${a.uuid === accounts.active ? 'Plays when you press LAUNCH' : 'Signed in'}</i></span>`;
    if (a.uuid !== accounts.active) {
      const use = document.createElement('button');
      use.className = 'ghost tiny';
      use.textContent = 'Use';
      use.onclick = async () => { await window.pp?.selectAccount?.(a.uuid); loadAccounts(); };
      row.appendChild(use);
    }
    const rm = document.createElement('button');
    rm.className = 'ghost tiny';
    rm.textContent = 'Sign out';
    rm.onclick = async () => {
      if (!confirm(`Sign ${a.name} out of the launcher?`)) return;
      await window.pp?.removeAccount?.(a.uuid);
      loadAccounts();
    };
    row.appendChild(rm);
    box.appendChild(row);
  });
  const add = document.createElement('button');
  add.className = 'ghost accaddrow';
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add account';
  add.onclick = () => $('accAdd')?.click();
  box.appendChild(add);
}

function swap(btn, on) { if (btn) btn.setAttribute('aria-pressed', String(!!on)); }

async function save(patch, message) {
  try {
    settings = await window.pp.settingsWrite(patch);
    paintSettings();
    if (message) note(message);
  } catch (e) {
    note('Could not save: ' + (e?.message || e), false);
  }
}

function wireSettings() {
  const mem = $('memRange');
  if (!mem) return;

  // Label follows the drag; the file is only written on release, or every
  // pixel of the drag would be a disk write.
  mem.oninput = () => { $('memVal').textContent = gb(Number(mem.value)); paintMemScale(); };
  mem.onchange = () => save({ memory: Number(mem.value) }, 'Memory saved');

  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.pick;
      const p = await window.pp?.pickPath?.(key === 'javaPath' ? 'file' : 'dir');
      if (p) save({ [key]: p }, 'Saved');
    };
  });
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => save({ [b.dataset.clear]: '' }, 'Back to automatic');
  });
  document.querySelectorAll('[data-place]').forEach((b) => {
    b.onclick = () => window.pp?.openPlace?.(b.dataset.place);
  });

  const code = $('codeInput');
  $('codeShow').onclick = () => {
    const shown = code.type === 'text';
    code.type = shown ? 'password' : 'text';
    $('codeShow').textContent = shown ? 'Show' : 'Hide';
  };
  $('codeSave').onclick = () => save({ code: code.value.trim() }, 'Code saved');

  $('copyGo').onclick = async () => {
    const sel = $('copyFrom');
    const from = profiles.find((p) => p.id === sel.value);
    if (!from) return;
    const go = $('copyGo');
    go.disabled = true;
    try {
      const r = await window.pp.profileCopy(from.id);
      note(r.skippedOptions
        ? `Copied from ${from.name} - video and controls kept, ${from.mc} is newer`
        : `Copied from ${from.name} into ${profile.name}`);
    } catch (e) {
      // ipcRenderer wraps the message; show only what main.js said.
      note(String(e?.message || e).replace(/^.*Error: /, ''), false);
    } finally {
      go.disabled = false;
    }
  };

  $('winSize').onchange = () => {
    const [w, h] = $('winSize').value.split('x').map(Number);
    save({ windowWidth: w, windowHeight: h }, w ? `Game opens at ${w} × ${h}` : 'Minecraft picks the size');
  };
  $('fullscreen').onclick = () => save({ fullscreen: !settings.fullscreen },
    !settings.fullscreen ? 'Starts in fullscreen' : 'Starts in a window');
  $('closeOnLaunch').onclick = () => save({ closeOnLaunch: !settings.closeOnLaunch });
  $('reopenOnClose').onclick = () => save({ reopenOnClose: settings.reopenOnClose === false });
  $('keepLogs').onclick = () => save({ keepLogs: !settings.keepLogs });
  const runCloud = async () => {
    cloudState.busy = true; paintCloud();
    const sum = await window.pp.cloudSync().catch(() => null);
    cloudState.busy = false;
    if (sum) { cloudState.last = sum; if (sum.ok) { cloudState.lastAt = sum.at; cloudState.files = sum.files; } }
    paintCloud();
    if (sum && !sum.ok && sum.note) note(sum.note, false);
    else if (sum && sum.ok) note(`Cloud saves synced - ${sum.down} down, ${sum.up} up`);
  };
  $('cloudSync').onclick = async () => {
    if (!tierState.premium) { note('Cloud saves come with Premium.', false); return; }
    const on = !settings.cloudSync;
    await save({ cloudSync: on }, on ? 'Cloud saves on - syncing now' : 'Cloud saves off - nothing more is sent');
    if (on) runCloud();
  };
  $('cloudNow').onclick = () => runCloud();
  $('betaUpdates').onclick = async () => {
    if (!tierState.premium) { note('Beta updates come with Premium.', false); return; }
    const on = !settings.betaUpdates;
    await save({ betaUpdates: on }, on
      ? 'Beta updates on - the newest test build installs on your next PLAY'
      : 'Beta updates off - the normal build comes back on your next PLAY');
    loadUpdate();
    drawVersions();
  };

  // Start with Windows lives in the OS, so it is asked, not remembered.
  const li = $('loginItem');
  window.pp?.loginItem?.().then((r) => {
    swap(li, r?.on);
    if (r?.reason === 'dev') { li.disabled = true; li.title = 'Only in the installed launcher'; }
  }).catch(() => {});
  li.onclick = async () => {
    const r = await window.pp?.loginItem?.(li.getAttribute('aria-pressed') !== 'true').catch(() => null);
    if (r?.ok) { swap(li, r.on); note(r.on ? 'Opens when you sign in to Windows' : 'No longer starts with Windows'); }
  };

  $('notesOpen').onclick = () => window.pp?.open?.(PATCH_NOTES);
  $('helpOpen').onclick = () => window.pp?.open?.(DISCORD);
}

/* Pinged one at a time rather than all at once. Four servers is nothing, but
   a list of twenty opening twenty sockets at the moment the page appears is
   the kind of thing a home router notices. */
async function pingAll() {
  for (const s of SERVERS) {
    try {
      pings[s.ip] = await window.pp.pingServer(s.ip);
    } catch {
      pings[s.ip] = { online: false };
    }
    loadServers();
  }
}

/* ---------------- cosmetics page ---------------- */
/*
 * WHAT YOU OWN comes first, and the catalogue is only there to give it a name
 * and a price.
 *
 * This used to be the other way round - draw the catalogue, tick the ones you
 * own - and it had a hole you could drive a cape through: this account owns two
 * capes that were never listed in the store, so they did not appear at all.
 * Owning something you cannot wear because nobody added it to a table is the
 * kind of bug people assume is theft. Grants lead, the catalogue decorates.
 *
 * (The old queries also asked for columns that do not exist - `item` and
 * `created_at`, where the table has `value` and `sort` - so every request 400ed
 * and the page silently read "Store is empty". Both are fixed here. If this
 * page ever goes blank again, check the network tab before the code.)
 */

let CATALOG = [];          // what is for sale, by "kind:value"
let OWNED = [];            // what this account has been granted
let WORN = {};             // { cape, hat, tag }
let cosKind = 'All';
let cosQuery = '';
let cosBusy = '';          // the key mid-equip, so it can show as pending

const keyOf = (kind, value) => `${kind}:${String(value || '').toLowerCase()}`;

/* A file name is not a product name. "Ella_cape_1024x512.png" is the artwork's
   resolution stapled to its subject; nobody wants to read that on a card, and
   two sizes of the same cape would otherwise look like two different capes. */
const cosName = (kind, value) => kind === 'tag'
  ? mcPlain(value).trim()
  : pretty(String(value || '').replace(/\.png$/i, '')
                              .replace(/[_-]?\d{2,5}x\d{2,5}$/i, '')
                              .replace(/[_-]?(hd|sd)$/i, ''));

/* Grants say "headband", the cosmetics row calls the column "hat". The edge
   function accepts either; the two names are kept apart here so the comparison
   against WORN uses the right one. */
const WORN_COLUMN = { cape: 'cape', headband: 'hat', hat: 'hat', tag: 'tag' };

function isWorn(c) {
  const col = WORN_COLUMN[c.kind];
  if (!col) return false;
  return String(WORN[col] || '').toLowerCase() === String(c.value || '').toLowerCase();
}

/* ---- Minecraft colour codes ----
 * Nearly every tag in the catalogue is something like
 * "&b&k--&d&lOWNER&b&k----". Printed raw it looks like the page is broken, and
 * stripped to plain text every tag in the store looks identical. So the codes
 * are rendered: colours, bold, italic, underline and strikethrough.
 *
 * &k is "obfuscated" - scrambling characters. That is animation, and a store
 * page is not the place to run a timer per row, so it is drawn as a steady
 * shimmer instead. It reads as "this bit moves in game" without twenty
 * intervals fighting for the main thread.
 */
const MC_COLOURS = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', a: '#55FF55', b: '#55FFFF',
  c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF'
};

function mcHtml(raw) {
  // Animated codes (client 2.64.0) come out as one span per letter with
  // data-fx; fxTick() below repaints them, with the same maths as the game.
  return parseTag(raw).map((p) => {
    const css = [];
    const data = p.fx ? ` data-fx="${p.fx}" data-i="${p.i}" data-n="${p.n}" data-a="${p.a}" data-b="${p.b}" data-base="${p.base == null ? '' : p.base}"` : '';
    if (p.fx) css.push('color:' + fxColour(p.fx, p.i, p.n, 0, p.a, p.b, p.base));
    else if (p.ck) css.push('color:' + MC_COLOURS[p.ck]);
    if (p.bold) css.push('font-weight:700');
    if (p.italic) css.push('font-style:italic');
    const deco = [p.under && 'underline', p.strike && 'line-through'].filter(Boolean);
    if (deco.length) css.push('text-decoration:' + deco.join(' '));
    return `<span class="${p.obf ? 'mcobf' : ''}"${data} style="${css.join(';')}">${esc(p.text)}</span>`;
  }).join('') || esc(String(raw || ''));
}

/* ---------- animated tag codes (client 2.64.0) ----------
   The same three codes and the same maths as the game's TagFx:
     &q    rainbow sliding along the letters
     &gXY  gradient from colour X to colour Y, flowing (e.g. &gdb)
     &s    a bright band sweeping across the current colour
   They start a run like a colour code does (and reset formats); &l &o &n &m &k
   after them apply on top. parseTag() turns a tag into pieces; each animated
   letter is its own piece carrying what fxColour() needs every frame. */
const FX_PAL = { "0": 0x000000, "1": 0x0000AA, "2": 0x00AA00, "3": 0x00AAAA, "4": 0xAA0000, "5": 0xAA00AA,
  "6": 0xFFAA00, "7": 0xAAAAAA, "8": 0x555555, "9": 0x5555FF, a: 0x55FF55, b: 0x55FFFF, c: 0xFF5555,
  d: 0xFF55FF, e: 0xFFFF55, f: 0xFFFFFF };
function parseTag(raw) {
  const text = raw == null ? "" : String(raw), out = [];
  let colour = null, ck = null, fx = "", a = 0, b = 0, bold = false, italic = false, under = false, strike = false, obf = false;
  let run = [], buf = "";
  const fmt = () => ({ colour, ck, bold, italic, under, strike, obf });
  const flush = () => { if (buf) { out.push({ text: buf, ...fmt() }); buf = ""; } };
  const endRun = () => { run.forEach((p, i) => { p.i = i; p.n = run.length; out.push(p); }); run = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === "&" || ch === "§") && i + 1 < text.length) {
      const c = text[i + 1].toLowerCase();
      const isG = c === "g" && i + 3 < text.length && FX_PAL[text[i + 2].toLowerCase()] !== undefined
                  && FX_PAL[text[i + 3].toLowerCase()] !== undefined;
      if (FX_PAL[c] !== undefined || c === "r" || c === "q" || c === "s" || isG) {
        flush(); endRun();
        bold = italic = under = strike = obf = false;
        if (FX_PAL[c] !== undefined) { colour = FX_PAL[c]; ck = c; fx = ""; }
        else if (c === "r") { colour = null; ck = null; fx = ""; }
        else if (c === "q") fx = "q";
        else if (c === "s") fx = "s";
        else { fx = "g"; a = FX_PAL[text[i + 2].toLowerCase()]; b = FX_PAL[text[i + 3].toLowerCase()]; i += 2; }
        i++; continue;
      }
      if ("lonmk".includes(c)) {
        flush();
        if (c === "l") bold = true; else if (c === "o") italic = true; else if (c === "n") under = true;
        else if (c === "m") strike = true; else obf = true;
        i++; continue;
      }
    }
    if (fx) run.push({ text: ch, ...fmt(), fx, a, b, base: colour });
    else buf += ch;
  }
  flush(); endRun();
  return out;
}
function fxHex(n) { return "#" + (n & 0xFFFFFF).toString(16).padStart(6, "0"); }
function fxMix(x, y, f) {
  f = Math.max(0, Math.min(1, f));
  const m = (s) => Math.round(((x >> s) & 255) * (1 - f) + ((y >> s) & 255) * f);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
function fxHsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), u = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, u, p], [q, v, p], [p, v, u], [p, q, v], [u, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}
function fxColour(fx, i, n, t, a, b, base) {
  if (fx === "q") { let h = (i * 0.07 - t * 0.35) % 1; if (h < 0) h += 1; return fxHex(fxHsv(h, 0.75, 1)); }
  if (fx === "g") { const p = n <= 1 ? 0 : i / (n - 1); const f = (p * 0.5 + t * 0.25) % 1; return fxHex(fxMix(a, b, f < 0.5 ? f * 2 : 2 - f * 2)); }
  const c = base == null ? 0xFFFFFF : base, cyc = 2.6, pos = ((t % cyc) / cyc) * 1.8 - 0.4;
  const p = n <= 1 ? 0.5 : i / (n - 1);
  return fxHex(fxMix(c, 0xFFFFFF, 0.8 * Math.max(0, 1 - Math.abs(p - pos) * 5)));
}
function fxTick() {
  const t = (Date.now() % 600000) / 1000;
  document.querySelectorAll("[data-fx]").forEach((el) => {
    const d = el.dataset;
    el.style.color = fxColour(d.fx, +d.i, +d.n, t, +d.a, +d.b, d.base === "" ? null : +d.base);
  });
}

setInterval(fxTick, 60);

/** A tag with its codes taken out, for searching and for the activity line. */
function mcPlain(raw) {
  return String(raw || '').replace(/[&§][gG][0-9a-fA-F]{2}/g, '').replace(/[&§][0-9a-fk-orqsA-FK-ORQS]/g, '');
}

/* Written to BOTH notes on purpose. One lives on the cosmetics page and one in
   the home column, and the home column is hidden everywhere except home - so a
   failure reported only there was a failure reported to nobody, which is how
   "I clicked equip and nothing happened" gets reported as a dead button. */
function cosNote(text, good = false) {
  [$('cosNote'), $('cosPageNote')].forEach((el) => {
    if (!el) return;
    el.style.color = good ? 'var(--good)' : 'var(--pink)';
    el.textContent = text;
  });
  clearTimeout(cosNote._t);
  cosNote._t = setTimeout(() => {
    [$('cosNote'), $('cosPageNote')].forEach((el) => { if (el) el.textContent = ''; });
  }, 4000);
}

async function loadCosmetics(name) {
  CATALOG = await rest('/rest/v1/cosmetic_catalog'
    + '?select=id,kind,value,label,price,premium_only,color'
    + '&listed=eq.true&order=sort.asc');

  OWNED = [];
  WORN = {};

  if (name) {
    const who = encodeURIComponent(String(name).toLowerCase());
    const [grants, worn] = await Promise.all([
      rest(`/rest/v1/cosmetic_grants?select=kind,value,color&player=eq.${who}`),
      rest(`/rest/v1/cosmetics?select=tag,tag_color,hat,cape&player=eq.${who}`)
    ]);
    OWNED = Array.isArray(grants) ? grants : [];
    WORN = (Array.isArray(worn) && worn[0]) || {};
  }

  drawCosCats();
  drawCosmetics();
  paintHomeCosmetic();
  Fit.player(name || account?.name || '');
  Fit.wear(cosTrying);
}

/**
 * Everything worth showing: what you own, then what is for sale that you do
 * not. Owned items that were never listed still appear - that is the whole
 * point - and they simply have no price.
 */
function cosList() {
  const cat = new Map(CATALOG.map((c) => [keyOf(c.kind, c.value), c]));
  const seen = new Set();
  const out = [];

  OWNED.forEach((g) => {
    const k = keyOf(g.kind, g.value);
    if (seen.has(k)) return;
    seen.add(k);
    const listed = cat.get(k);
    out.push({
      kind: g.kind,
      value: g.value,
      label: listed?.label || cosName(g.kind, g.value),
      price: listed?.price || '',
      colour: g.color ?? listed?.color ?? 6,
      owned: true
    });
  });

  CATALOG.forEach((c) => {
    const k = keyOf(c.kind, c.value);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({
      kind: c.kind,
      value: c.value,
      label: c.label || cosName(c.kind, c.value),
      price: c.price || '',
      premium: !!c.premium_only,
      colour: c.color ?? 6,
      owned: false
    });
  });

  // Owned first, then worn to the very top: the thing you are wearing is the
  // thing you are most likely to want to take off.
  return out.sort((a, b) =>
    Number(isWorn(b)) - Number(isWorn(a)) ||
    Number(b.owned) - Number(a.owned) ||
    String(a.kind).localeCompare(String(b.kind)) ||
    String(a.label).localeCompare(String(b.label)));
}

const KIND_LABEL = { cape: 'CAPES', tag: 'TAGS', headband: 'HEADBANDS', hat: 'HATS' };

function drawCosCats() {
  const box = $('cosCats');
  if (!box) return;
  box.textContent = '';
  const kinds = ['All', ...new Set(cosList().map((c) => c.kind).filter(Boolean))];
  kinds.forEach((k) => {
    const b = document.createElement('button');
    b.className = 'cat' + (k === cosKind ? ' on' : '');
    b.textContent = k === 'All' ? 'ALL' : (KIND_LABEL[k] || k.toUpperCase());
    b.onclick = () => { cosKind = k; drawCosCats(); drawCosmetics(); };
    box.appendChild(b);
  });
}

/*
 * THE WARDROBE (reworked 30 Sep 2026).
 *
 * The old page was one flat grid where owned, worn, for sale and broken all
 * looked the same: two "SilkPVP Cape" tiles reading "artwork missing", a pink
 * GET next to a pink EQUIP, and no way to see anything on before buying it.
 *
 * Now: you on the left in 3D, wearing what is on; your collection and the
 * shop as two separate sections on the right. Clicking a card TRIES IT ON -
 * nothing is equipped until EQUIP - and owned items whose file was never
 * uploaded are listed in one line instead of as dead tiles.
 */
let cosTrying = null;                 // the card being previewed, or null

function drawCosmetics() {
  const box = $('cosGrid');
  if (!box) return;
  box.textContent = '';

  const all = cosList();
  const match = (c) =>
    (cosKind === 'All' || c.kind === cosKind) &&
    (!cosQuery || (c.label + ' ' + mcPlain(c.value)).toLowerCase().includes(cosQuery));

  // An owned file that is definitely not in the bucket (and the bucket is
  // reachable - some other artwork loaded) is not a card, it is a note.
  const broken = (c) => c.kind !== 'tag' && checkArt(c.value, drawCosmetics) === 'gone' && anyArtLoaded();
  const owned = all.filter((c) => c.owned && !broken(c));
  const missing = all.filter((c) => c.owned && broken(c));
  const shop = all.filter((c) => !c.owned && !broken(c));

  $('cosCount').textContent = owned.length ? `${owned.length} owned · ${shop.length} in the shop`
                                            : `${shop.length} in the shop`;

  const section = (title, sub, list) => {
    const shown = list.filter(match);
    if (!shown.length) return 0;
    const h = document.createElement('div');
    h.className = 'coshead';
    h.innerHTML = `<h2>${esc(title)} <em>${shown.length}</em></h2>${sub ? `<span>${esc(sub)}</span>` : ''}`;
    box.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'cosgrid';
    shown.forEach((c) => grid.appendChild(cosCard(c)));
    box.appendChild(grid);
    return shown.length;
  };

  const a = section('YOUR COLLECTION', 'Click to try on · EQUIP to wear it', owned);
  if (missing.length && (cosKind === 'All' || missing.some((c) => c.kind === cosKind))) {
    const n = document.createElement('p');
    n.className = 'cosmissing';
    n.textContent = `${missing.length} item${missing.length === 1 ? '' : 's'} you own ${missing.length === 1 ? 'has' : 'have'} no artwork uploaded yet (`
      + [...new Set(missing.map((c) => c.label))].join(', ') + '). Staff can fix that in the Discord.';
    box.appendChild(n);
  }
  const b = section('SHOP', 'Try anything on first', shop);

  if (!a && !b) {
    const d = document.createElement('div');
    d.className = 'modempty';
    d.innerHTML = all.length
      ? '<h3>Nothing matches</h3><p>Try another search or category.</p>'
      : '<h3>Nothing to show</h3><p>Sign in to see what you own, or check back '
        + 'once something is listed.</p>';
    box.appendChild(d);
  }
  paintSlots();
}

function cosCard(c) {
  const worn = isWorn(c);
  const busy = cosBusy === keyOf(c.kind, c.value);
  const trying = cosTrying && keyOf(cosTrying.kind, cosTrying.value) === keyOf(c.kind, c.value);

  const card = document.createElement('div');
  card.className = 'cos2' + (worn ? ' worn' : '') + (c.owned ? '' : ' shop') + (trying ? ' trying' : '')
                 + (c.kind === 'tag' ? ' tagcard' : '');
  const state = c.kind === 'tag' ? 'ok' : checkArt(c.value, drawCosmetics);

  const artHtml = c.kind === 'tag'
    ? `<div class="c2art tagart"><span class="plate"><span class="mctag">${mcHtml(c.value)}</span></span></div>`
    : state === 'gone'
    ? `<div class="c2art goneart"><span>${anyArtLoaded() ? 'no artwork' : 'offline'}</span></div>`
    : c.kind === 'cape'
    ? `<div class="c2art capeart"><i style="background-image:url('${cosArt(c.value)}');${CAPE_UV}"></i></div>`
    : `<div class="c2art" style="background-image:url('${cosArt(c.value)}')"></div>`;

  const badge = worn ? '<span class="c2badge on">WEARING</span>'
              : !c.owned && c.premium ? '<span class="c2badge prem">PREMIUM</span>'
              : '';
  const sub = c.owned ? (KIND_LABEL[c.kind] || c.kind || '').replace(/S$/, '')
            : (c.price ? c.price : c.premium ? 'Premium' : 'Not for sale');

  card.innerHTML = artHtml + badge
    + `<div class="c2body"><b>${esc(c.label)}</b><span>${esc(String(sub).toUpperCase())}</span></div>`;

  const act = document.createElement('button');
  act.className = 'c2act' + (worn ? ' off' : c.owned ? '' : ' buy');
  act.disabled = busy;
  act.textContent = busy ? '…' : worn ? 'REMOVE' : c.owned ? 'EQUIP'
                  : c.price ? 'GET ' + c.price : c.premium ? 'GET PREMIUM' : 'VIEW';
  act.onclick = (e) => { e.stopPropagation(); cosAction(c, state); };
  card.appendChild(act);

  card.onclick = () => tryOn(c);
  return card;
}

/* What the main button on a card (or the try-on bar) does. */
function cosAction(c, state) {
  const worn = isWorn(c);
  if (!c.owned) {
    window.pp?.open?.(c.premium && !c.price ? 'https://pinkponyclient.com/store.html#premium'
                                            : 'https://pinkponyclient.com/store.html#cosmetics');
    return;
  }
  // Only refuse when we KNOW the file is the problem - see checkArt.
  if (state === 'gone' && !worn && anyArtLoaded()) {
    cosNote(`${c.label} has no artwork uploaded yet.`);
    return;
  }
  equip(c, worn ? '' : c.value);
}

/* ---- the 3D preview ---- */
function tryOn(c) {
  if (!c) { cosTrying = null; Fit.wear(); paintTryBar(); drawCosmetics(); return; }
  const same = cosTrying && keyOf(cosTrying.kind, cosTrying.value) === keyOf(c.kind, c.value);
  cosTrying = same ? null : c;          // clicking it again puts it back
  Fit.wear(cosTrying);
  paintTryBar();
  drawCosmetics();
}

function paintTryBar() {
  const bar = $('tryBar');
  if (!bar) return;
  const c = cosTrying;
  bar.hidden = !c || isWorn(c);
  if (bar.hidden) return;
  $('tryName').textContent = c.label;
  const act = $('tryAct');
  act.textContent = c.owned ? 'EQUIP' : c.price ? 'GET ' + c.price : 'GET PREMIUM';
  act.classList.toggle('buy', !c.owned);
  act.onclick = () => cosAction(c, c.kind === 'tag' ? 'ok' : checkArt(c.value, () => {}));
  $('tryReset').onclick = () => tryOn(null);
}

/* The two slots under the model: what is on, and a way to take it off. */
function paintSlots() {
  const list = cosList();
  const cape = list.find((c) => c.kind === 'cape' && isWorn(c));
  const tag = list.find((c) => c.kind === 'tag' && isWorn(c));
  const set = (id, item, artHtml) => {
    const name = $(id + 'Name'), artEl = $(id + 'Art'), off = $(id + 'Off');
    if (!name) return;
    name.textContent = item ? item.label : 'None';
    artEl.innerHTML = item ? artHtml : '';
    off.hidden = !item;
    off.onclick = () => item && equip(item, '');
  };
  set('slotCape', cape, cape ? `<i style="background-image:url('${cosArt(cape.value)}');${CAPE_UV}"></i>` : '');
  set('slotTag', tag, tag ? `<span class="mctag">${mcHtml(tag.value)}</span>` : '');
}

/*
 * The model. Same approach as the website's fitting room (skinview3d, turn
 * side to side only, the name tag pinned over the head by projecting its
 * position every frame) - but vendored into the launcher rather than loaded
 * from a CDN, because this window has the pp bridge and nothing remote gets
 * to run script in it.
 */
const Fit = (() => {
  let viewer = null, started = false, who = '', tmp = null;
  const canvas = () => $('cosCanvas'), stage = () => $('cosStage');

  function start() {
    if (started) return;
    const st = stage(), cv = canvas();
    if (!st || !cv || !st.clientWidth) return;       // page not visible yet
    started = true;
    if (window.skinview3d) {
      try {
        viewer = new skinview3d.SkinViewer({ canvas: cv, width: st.clientWidth, height: st.clientHeight });
        viewer.fov = 36; viewer.zoom = 0.6;
        viewer.animation = new skinview3d.WalkingAnimation(); viewer.animation.speed = 0.5;
        viewer.controls.enablePan = false; viewer.controls.enableZoom = false;
        viewer.controls.minPolarAngle = viewer.controls.maxPolarAngle = Math.PI / 2;
        viewer.playerObject.rotation.y = Math.PI - 0.55;   // start from behind: capes are on the back
        viewer.autoRotateSpeed = 0.8;
        // Hidden pages measure 0x0; a zero-sized WebGL canvas errors on every
        // frame, so a resize to nothing is ignored.
        new ResizeObserver(() => {
          if (st.clientWidth && st.clientHeight) viewer.setSize(st.clientWidth, st.clientHeight);
        }).observe(st);
      } catch { viewer = null; }
    }
    if (!viewer) { cv.hidden = true; $('cosCtl').hidden = true; }
    $('cosCtl')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !viewer) return;
      if (b.dataset.anim) {
        const walk = b.getAttribute('aria-pressed') !== 'true';
        viewer.animation = walk ? new skinview3d.WalkingAnimation() : new skinview3d.IdleAnimation();
        viewer.animation.speed = walk ? 0.5 : 1;
        b.setAttribute('aria-pressed', String(walk));
      } else if (b.hasAttribute('data-spin')) {
        viewer.autoRotate = !viewer.autoRotate; b.setAttribute('aria-pressed', String(viewer.autoRotate));
      } else if (b.hasAttribute('data-turn')) {
        viewer.playerObject.rotation.y += Math.PI;
      }
    });
    requestAnimationFrame(track);
    player(who);
    wear(cosTrying);
  }

  /* Keep the tag over the head, wherever the model has turned to. */
  function track() {
    const nt = $('cosNt');
    const head = viewer?.playerObject?.skin?.head;
    if (nt && head && !canvas().hidden) {
      if (!tmp) tmp = head.position.clone();
      head.getWorldPosition(tmp); tmp.y += 6.4; tmp.project(viewer.camera);
      const w = canvas().clientWidth, h = canvas().clientHeight;
      const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
      nt.style.transform = `translate(${Math.round(x - nt.offsetWidth / 2)}px, ${Math.round(y - nt.offsetHeight)}px)`;
    }
    requestAnimationFrame(track);
  }

  function player(name) {
    who = /^[A-Za-z0-9_]{3,16}$/.test(name || '') ? name : '';
    const n = $('cosNtName'); if (n) n.textContent = who || 'Steve';
    const skin = `https://mc-heads.net/skin/${who || 'MHF_Steve'}`;
    if (viewer) viewer.loadSkin(skin).catch(() => viewer.loadSkin('https://mc-heads.net/skin/MHF_Steve').catch(() => {}));
    else if (started) {
      const flat = $('cosFlat'); flat.hidden = false;
      flat.src = `https://mc-heads.net/body/${who || 'MHF_Steve'}/300`;
    }
  }

  /* Put the worn things on, with `trying` swapped in over its own slot. */
  function wear(trying) {
    const list = cosList();
    const worn = (kind) => list.find((c) => c.kind === kind && isWorn(c));
    const cape = trying?.kind === 'cape' ? trying : worn('cape');
    const tag = trying?.kind === 'tag' ? trying : worn('tag');

    const tagEl = $('cosNtTag');
    if (tagEl) { tagEl.innerHTML = tag ? mcHtml(tag.value) : ''; tagEl.hidden = !tag; }
    const hint = $('cosStage');
    if (hint) hint.classList.toggle('previewing', !!trying && !isWorn(trying));

    if (!viewer) return;
    if (cape && checkArt(cape.value, () => {}) !== 'gone') {
      viewer.loadCape(cosArt(cape.value)).catch(() => viewer.resetCape());
      if (trying?.kind === 'cape') viewer.playerObject.rotation.y = Math.PI - 0.55;
    } else {
      viewer.resetCape();
    }
  }

  return { start, player, wear };
})();

const cosArt = (file) => art(file);

/*
 * Does this cosmetic's artwork actually exist?
 *
 * A grant is just a filename, and nothing checks the file was ever uploaded -
 * this account has a cape granted as "Ella_cape_1024x512.png" which is not in
 * the bucket at all. Equipping it puts nothing on your back, and the tile
 * showed an empty box, which reads as "still loading" forever.
 *
 * background-image cannot report a failure, so each file is probed once with a
 * real Image and the answer cached. Once, not per redraw: the grid redraws on
 * every search keystroke.
 */
const artState = new Map();          // file -> 'ok' | 'checking' | 'gone'

/** Did anything at all load? If not, the problem is the connection, not the file. */
function anyArtLoaded() {
  for (const v of artState.values()) if (v === 'ok') return true;
  return false;
}

function checkArt(file, onDone) {
  if (!file) return 'gone';
  const known = artState.get(file);
  if (known) return known;

  artState.set(file, 'checking');
  const img = new Image();
  img.onload = () => { artState.set(file, 'ok'); onDone(); };
  img.onerror = () => { artState.set(file, 'gone'); onDone(); };
  img.src = cosArt(file);
  return 'checking';
}

/*
 * Crop a cape sheet to its outside panel - the only part anybody sees.
 *
 * A cape file is a 64x32 atlas: the outside is the 10x16 block at (1,1), and
 * the rest is the inside, the four edge strips, and dead space. Dropping the
 * whole file into a tile as background:cover showed a scaled-down slice of the
 * middle of the atlas, which is why the thumbnails looked blurry and cropped
 * wrong - the launcher was displaying a texture sheet, not a cape.
 *
 *   width  10/64 of the sheet  ->  background-size x = 100/(10/64) = 640%
 *   height 16/32               ->                   y = 100/(16/32) = 200%
 *
 * Background-position in per-cent is a fraction of the LEFTOVER space, not of
 * the image, so the offsets are x0/(1-w) rather than x0. That is the bit that
 * is easy to get wrong and lands you one strip to the left.
 */
const CAPE_UV = 'background-size:640% 200%;background-position:'
              + (1 / 64) / (1 - 10 / 64) * 100 + '% '
              + (1 / 32) / (1 - 16 / 32) * 100 + '%';

/**
 * Put something on, or take it off with an empty value.
 *
 * The local copy is only changed once the SERVER agrees, the same rule the
 * game's Wardrobe follows. Showing it equipped and finding out it was refused
 * is how this page ends up disagreeing with what everybody else can see.
 */
async function equip(c, value) {
  cosBusy = keyOf(c.kind, c.value);
  drawCosmetics();

  const res = await window.pp?.equip?.(c.kind, value).catch(() => null);
  cosBusy = '';

  if (!res?.ok) {
    cosNote({
      no_code:       'Add your access code in Settings first.',
      not_signed_in: 'Sign in first.',
      // The server would call this "code_in_use", which sounds like a ban. It
      // is not - the launcher just has not seen the game write its hardware id
      // yet, and there is nothing to fix except launching once.
      no_hwid:       'Launch the game once first, then you can equip from here.',
      not_owned:     "You don't own that.",
      invalid_code:  "That code isn't active any more.",
      code_in_use:   'That code is locked to another PC. Staff can reset it.',
      wrong_account: 'That code is bound to another Minecraft account.',
      bad_kind:      "The server didn't recognise that item type.",
      offline:       "Can't reach Pink Pony right now."
    }[res?.reason] || "Couldn't equip that.");
    drawCosmetics();
    return;
  }

  const col = WORN_COLUMN[c.kind];
  if (col) WORN[col] = value;

  cosNote(value ? `${c.label} equipped.` : `${c.label} removed.`, true);
  if (cosTrying && keyOf(cosTrying.kind, cosTrying.value) === keyOf(c.kind, c.value)) cosTrying = null;
  Fit.wear(cosTrying);
  paintTryBar();
  drawCosmetics();
  paintHomeCosmetic();
  loadActivity();
}

/**
 * The card in the home column shows what you are ACTUALLY wearing.
 *
 * It used to be hardcoded to "Pony Rider / Epic Skin" with a dead EQUIP button
 * and a dead wardrobe button beside it - the same invented-data problem as the
 * placeholder friends. It looked like a feature and was a picture of one.
 *
 * Note this is the RIGHT COLUMN card (.feature, #featSkin), not the "featured
 * cosmetic" panel in the hero (.panel.feat, #featArt). They look similar and
 * mean opposite things: one is what you own and have on, the other is
 * something from the store you probably do not.
 */
function paintHomeCosmetic() {
  const card = document.querySelector('.feature');
  if (!card) return;

  const artEl = $('featSkin');
  const nameEl = card.querySelector('.finfo b');
  const subEl = card.querySelector('.finfo > span');
  const equipBtn = card.querySelector('.equip');
  const wardrobeBtn = card.querySelector('.wardrobe');

  if (wardrobeBtn) {
    wardrobeBtn.title = 'Open cosmetics';
    wardrobeBtn.onclick = () => showPage('cosmetics');
  }

  const list = cosList();
  const on = list.find((c) => isWorn(c));
  const ownedCount = list.filter((c) => c.owned).length;

  const setArt = (item) => {
    if (!artEl) return;
    artEl.style.backgroundImage = '';
    artEl.innerHTML = '';
    if (!item) return;
    if (item.kind === 'tag') {
      artEl.innerHTML = `<span class="mctag big">${mcHtml(item.value)}</span>`;
    } else if (item.kind === 'cape') {
      // Same sheet crop as the store tiles - see CAPE_UV.
      artEl.innerHTML = `<i class="capepanel" style="background-image:url('${art(item.value)}');${CAPE_UV}"></i>`;
    } else {
      artEl.style.backgroundImage = `url('${art(item.value)}')`;
    }
  };

  if (!on) {
    // The PREMIUM badge was part of the hardcoded name, so it goes with it.
    if (nameEl) nameEl.textContent = ownedCount ? 'Nothing equipped' : 'No cosmetics yet';
    if (subEl) {
      subEl.textContent = ownedCount
        ? `${ownedCount} owned - pick one in Cosmetics`
        : 'Anything you are given shows up here';
    }
    setArt(null);
    if (equipBtn) {
      equipBtn.textContent = ownedCount ? 'CHOOSE' : 'BROWSE';
      equipBtn.disabled = false;
      equipBtn.onclick = () => showPage('cosmetics');
    }
    return;
  }

  if (nameEl) nameEl.textContent = on.label;
  if (subEl) subEl.textContent = String(on.kind || '').toUpperCase();
  setArt(on);

  if (equipBtn) {
    equipBtn.textContent = 'REMOVE';
    equipBtn.disabled = false;
    equipBtn.onclick = () => equip(on, '');
  }
}

/* ---------------- notifications ---------------- */
let updateInfo = { latest: '', installed: '' };
let setupState = { noCode: false, premiumUntil: '' };

/*
 * The bell had a permanent pink dot and no menu behind it - it announced
 * unread things forever and could not tell you what they were.
 *
 * Everything listed here is something the launcher ALREADY knows, and every
 * row goes somewhere you can act on it. Nothing is generated to fill the list:
 * when there is nothing to say, the dot is off and the menu says so. A bell
 * that always claims news is a bell people stop looking at.
 */
function notifications() {
  const out = [];

  // Somebody is waiting on an answer. Top, because it involves another person.
  (friendsState.incoming || []).forEach((name) => {
    out.push({ icon: 'join', text: `${name} wants to be friends`,
               sub: 'Open friends to accept', go: () => { showPage('home'); flashFriends(); } });
  });

  // A build newer than the jar actually installed. Comparing against the
  // INSTALLED version rather than the profile's Minecraft version is the whole
  // point - "1.21.1" does not tell you whether your jar is current.
  if (updateInfo.latest && updateInfo.installed && updateInfo.latest !== updateInfo.installed) {
    out.push({ icon: 'up', text: `Pink Pony ${updateInfo.latest} is out`,
               sub: `You have ${updateInfo.installed} - press LAUNCH to update`,
               go: () => showPage('home') });
  }

  // Setup gaps. These are the two things that make half the launcher inert,
  // and both are one click from here.
  if (!accounts.accounts?.length) {
    out.push({ icon: 'join', text: 'You are not signed in',
               sub: 'Sign in to launch the game', go: () => $('acct')?.click() });
  }
  if (setupState.noCode) {
    out.push({ icon: 'cos', text: 'No access code saved',
               sub: 'Add it in Settings to unlock cosmetics and friends',
               go: () => showPage('settings') });
  }

  // Premium is a month at a time and never renews by itself, so it can run
  // out without anybody doing anything wrong - say so a week ahead.
  if (setupState.premiumUntil) {
    const days = Math.ceil((Date.parse(setupState.premiumUntil) - Date.now()) / 86400000);
    if (Number.isFinite(days) && days <= 7) {
      out.push({ icon: 'up',
                 text: days <= 0 ? 'Premium has ended' : `Premium ends in ${days} day${days === 1 ? '' : 's'}`,
                 sub: 'Open a ticket in the Discord to add a month',
                 go: () => window.pp?.open?.('https://pinkponyclient.com/store.html#premium') });
    }
  }

  return out;
}

function drawNotifications() {
  const list = $('notifList');
  const bell = $('bell');
  if (!list || !bell) return;

  const items = notifications();
  bell.classList.toggle('dot', items.length > 0);
  bell.title = items.length ? `${items.length} notification${items.length === 1 ? '' : 's'}`
                            : 'Notifications';

  list.textContent = '';
  if (!items.length) {
    list.innerHTML = '<p class="notifempty">Nothing needs you right now.</p>';
    return;
  }

  items.forEach((n) => {
    const row = document.createElement('button');
    row.className = 'notifrow';
    row.innerHTML = `<span class="nicon"><svg viewBox="0 0 24 24">${ICONS[n.icon] || ICONS.cos}</svg></span>`
                  + `<span class="nmeta"><b>${esc(n.text)}</b><i>${esc(n.sub)}</i></span>`;
    row.onclick = () => { $('notifMenu').hidden = true; n.go(); };
    list.appendChild(row);
  });
}

/* Draws attention to the friends panel after jumping to it from elsewhere.
   Without this, "open friends to accept" moves you to a page where nothing
   visibly changed and you have to hunt for the thing you were sent to. */
function flashFriends() {
  const box = $('friends');
  if (!box) return;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  box.classList.remove('flash');
  void box.offsetWidth;                 // restart the animation
  box.classList.add('flash');
}

function wireHeaderIcons() {
  const bell = $('bell');
  const menu = $('notifMenu');
  if (bell && menu) {
    bell.onclick = (e) => {
      e.stopPropagation();
      drawNotifications();
      menu.hidden = !menu.hidden;
    };
    document.addEventListener('click', (e) => {
      if (menu.hidden) return;
      if (!menu.contains(e.target) && e.target !== bell && !bell.contains(e.target)) {
        menu.hidden = true;
      }
    });
  }

  const friendsBtn = $('friendsBtn');
  if (friendsBtn) {
    friendsBtn.onclick = () => {
      showPage('home');
      loadFriends();
      flashFriends();
    };
  }
}

/* The last few controls that pointed nowhere. Each of these was a real button
   on screen that swallowed the click - the worst kind, because people press it
   twice and conclude the launcher is broken. */
function wireStrays() {
  const viewAll = $('cosViewAll');
  if (viewAll) viewAll.onclick = (e) => { e.preventDefault(); showPage('cosmetics'); };

  const viewIn = document.querySelector('.panel.feat .solid');
  if (viewIn) viewIn.onclick = () => showPage('cosmetics');

  // There is no history page, and inventing one to satisfy a button would be
  // backwards. The panel already lists everything recorded, so the button says
  // what it can actually do.
  const fullHistory = document.querySelector('.panel .outline.wide');
  if (fullHistory) {
    fullHistory.innerHTML = 'REFRESH';
    fullHistory.onclick = () => loadActivity();
  }

  // Every release's notes, on the website (patchnotes.html, read from the
  // patch_notes table that /clientbuild fills). Opens at the one shown here.
  const patch = document.querySelector('.update .outline');
  if (patch) patch.onclick = () => window.pp?.open?.(
    PATCH_NOTES + (updateInfo.latest ? '#v' + updateInfo.latest : ''));

  // X, YouTube and TikTok have no accounts yet. Rather than leave three links
  // that do nothing, they are removed - they can come back the day there is
  // something behind them.
  document.querySelectorAll('.socials a').forEach((a) => {
    if (a.hasAttribute('data-discord')) return;
    a.remove();
  });
}

const cosSearch = $('cosSearch');
if (cosSearch) {
  cosSearch.oninput = () => { cosQuery = cosSearch.value.trim().toLowerCase(); drawCosmetics(); };
}

/* Coming back to the window re-reads what can change behind its back: the
   jar (the game or a person may have swapped it), the published build and
   the friends list. Throttled, because focus fires on every alt-tab. */
let lastRefresh = Date.now();
window.addEventListener('focus', () => {
  if (Date.now() - lastRefresh < 20000) return;
  lastRefresh = Date.now();
  loadJars();
  loadUpdate();
  loadFriends();
});

/* ---------------- boot ---------------- */
loadActivity();
loadProfiles();
loadVersions();
loadUpdate();
loadJars();
wireJars();
wireShaders();
loadTier();
wireSettings();
loadSettings();
loadCosmetics(null);
loadServers();
wireFriends();
loadFriends();
wireStrays();
wireHeaderIcons();
drawNotifications();
loadTiles(null);
loadFeatured();

/*
 * The launcher's own version, in Settings.
 *
 * Asked for after a round of "I think I'm on 1.1.1" - which is not a thing
 * anybody should have to guess about while testing a fix. Read from the
 * packaged app rather than written into the page, so it is the same number
 * electron-updater compares and cannot go stale.
 */
(async () => {
  const el = $('appVersion');
  if (!el) return;
  try {
    const v = await window.pp?.appVersion?.();
    el.textContent = v ? 'v' + v : 'unknown';
    const side = $('sideVer');
    if (side) side.textContent = v ? 'Launcher v' + v : '';
  } catch {
    // An older main process with no handler for this. Saying "unknown" is
    // honest; leaving the em dash looks like the row is still loading.
    el.textContent = 'unknown';
  }
})();

/*
 * The update row in Settings.
 *
 * Every line here comes from an event main.js actually fired. There is no
 * "up to date" written in as a default, because the state that mattered for
 * two weeks was "nothing is even asking" - and a row that says "up to date"
 * when nothing has checked is exactly how that went unnoticed.
 */
(() => {
  const state = $('updState');
  const check = $('updCheck');
  const install = $('updInstall');
  if (!state) return;

  const say = (t) => { state.textContent = t; };

  // The row above is on the Settings page, and nobody is on the Settings page
  // when the launcher opens. So a download and the restart after it also show
  // as a small pill over whatever page is open - otherwise the window closing
  // on its own a few seconds after opening looks exactly like a crash.
  let pill = null;
  const toast = (t) => {
    if (!t) { pill?.remove(); pill = null; return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'updtoast';
      document.body.appendChild(pill);
    }
    pill.textContent = t;
  };

  /* One line, not electron-updater's whole HTTP dump (headers and a stack
     trace filled the Settings page). The full text is in updater.log -
     Settings > About > Launcher files. The usual cause is a release whose
     files are still uploading; the launcher retries by itself. */
  const updateError = (m) => {
    const t = String(m || '');
    if (/latest\.yml|404/i.test(t)) return 'The new version is still being published. Trying again in a few minutes.';
    if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::|network/i.test(t)) return "Couldn't reach GitHub. Trying again in a few minutes.";
    const first = t.split(/\n|\. /)[0].slice(0, 140);
    return `Couldn't check for updates: ${first}`;
  };

  window.pp?.onUpdate?.((s) => {
    switch (s?.state) {
      case 'dev':         say('Updates are off in a dev build.'); if (check) check.disabled = true; break;
      case 'checking':    say('Checking for updates…'); break;
      case 'current':     say('You are on the newest version.'); break;
      case 'found':       say(`Version ${s.version} found. Downloading…`);
                          toast(`Downloading update ${s.version}…`); break;
      case 'downloading': say(`Downloading… ${s.percent}%`);
                          toast(`Downloading update… ${s.percent}%`); break;
      case 'ready':
        // Only reached while the game is running - otherwise it installs
        // straight away (see 'installing').
        say(`Version ${s.version} is ready. It installs when you close the game.`);
        toast('');
        break;
      case 'installing':
        say(`Updating to ${s.version}… the launcher will be right back.`);
        toast(`Updating to ${s.version} - back in a few seconds`);
        if (check) check.disabled = true;
        break;
      case 'error':
        toast('');
        // The reason goes on screen. "Update failed" with no cause is the
        // kind of message that gets three rounds of guessing.
        say(updateError(s.message));
        break;
      default: break;
    }
  });

  check?.addEventListener('click', async () => {
    check.disabled = true;
    say('Checking for updates…');
    const r = await window.pp?.updateCheck?.().catch(() => null);
    if (r && !r.ok && r.reason === 'dev') say('Updates are off in a dev build.');
    setTimeout(() => { check.disabled = false; }, 3000);
  });

  install?.addEventListener('click', () => window.pp?.updateInstall?.());
})();

// savedAccount refreshes the active session first, then the list is read so
// the switcher shows the refreshed name.
window.pp?.savedAccount?.().then(() => loadAccounts());

// Switched from the game's title screen: the chip should say who is playing now.
window.pp?.onAccountsChanged?.(() => loadAccounts());

/*
 * TERMS OF SERVICE, once per version of the Terms.
 *
 * The gate reads the same settings everything else does. main.js also refuses
 * to launch until it is accepted, so closing this with devtools gets nobody
 * into the game - it only gets them a launcher that says "accept the Terms".
 */
(function terms() {
  const gate = document.getElementById('tosGate');
  const open = () => window.pp?.settingsRead?.().then((s) => window.pp?.open?.(s?.termsUrl || 'https://pinkponyclient.com/terms.html'));
  document.getElementById('tosRead')?.addEventListener('click', open);
  document.getElementById('termsOpen')?.addEventListener('click', open);
  document.getElementById('tosQuit')?.addEventListener('click', () => window.pp?.win?.('close'));
  document.getElementById('tosAgree')?.addEventListener('click', async () => {
    const s = await window.pp?.settingsRead?.().catch(() => null);
    if (!s) return;
    const saved = await window.pp?.settingsWrite?.({ termsAccepted: s.termsVersion }).catch(() => null);
    if (saved && saved.termsAccepted === s.termsVersion) {
      gate.hidden = true;
      const note = document.getElementById('termsNote');
      if (note) note.textContent = `You agreed to the Terms of ${s.termsVersion}.`;
    }
  });
  window.pp?.settingsRead?.().then((s) => {
    if (!s) return;
    const note = document.getElementById('termsNote');
    if (s.termsAccepted === s.termsVersion) {
      if (note) note.textContent = `You agreed to the Terms of ${s.termsVersion}.`;
    } else if (gate) {
      gate.hidden = false;
      document.getElementById('tosAgree')?.focus();
    }
  }).catch(() => {});
})();

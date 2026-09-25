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
  $('sideVer').textContent = 'v' + v;
  $('updVer').textContent = 'v' + v;
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
  $('profName').textContent = profile.name;
  const label = $('modsFor');
  // The mods list shows the ACTIVE profile's folder, so the heading says which
  // one that is. Without it "Mods" on a profiles page reads as "all mods".
  if (label) label.textContent = (profile.name || 'default').toUpperCase();
  setVersion(profile.mc);
}

/* Versions we do not build a client for yet.
 *
 * Shown, greyed, on purpose. A launcher that lists only 1.21.1 looks like it
 * cannot do anything else; one that lists everything and then fails on nine of
 * them out of ten looks broken. Saying "soon" is the only version of this that
 * is both useful and true.
 *
 * Anything here that later appears in client_builds drops out of this list
 * automatically - the live set wins, so this never has to be pruned by hand.
 */
/* WHAT WE ACTUALLY INTEND TO BUILD, and nothing else.
 *
 * This listed nine lines at first, copied from Lunar. That reads as a wishlist
 * rather than a plan, and every greyed tile is a promise somebody will hold
 * you to - "when is 1.16?" has no good answer if the honest one is "never".
 *
 * 1.8.9 is here because it genuinely exists - it just runs through Forge and
 * Orbit today rather than through this launcher. Anything added below should
 * clear the same bar: work that is actually planned.
 */
const SOON = ['1.8.9'];

/* A VERSION IS A PROFILE. There is no naming step and no Create button.
 *
 * The first cut had a profile list, a version grid and a "name your profile"
 * form - three controls for what is really one decision. Nobody wants to name
 * anything; they want to play 1.21 and have their 1.21 mods there. So the
 * version tile IS the profile: clicking one switches to it, and creates its
 * folder the first time.
 *
 * Grouped by line because that is how people talk about Minecraft - nobody
 * plays "1.21.1", they play 1.21. The exact point release only appears as a
 * row of chips once a line has more than one build, which today it never does.
 */
const LINES = ['1.21', '1.8'];
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

  const live = {};
  mcVersions.forEach((v) => { (live[lineOf(v)] ||= []).push(v); });

  const order = LINES.slice();
  Object.keys(live).forEach((l) => { if (!order.includes(l)) order.unshift(l); });
  SOON.forEach((v) => { const l = lineOf(v); if (!order.includes(l)) order.push(l); });

  const activeLine = lineOf(profile.mc);

  order.forEach((l) => {
    const have = live[l];
    const on = have && l === activeLine;
    // Mods are counted per profile by main.js, so this is the real number for
    // this version's folder rather than a guess.
    const mine = have && profiles.find((p) => lineOf(p.mc) === l);

    const b = document.createElement('button');
    b.className = 'vertile' + (have ? '' : ' soon') + (on ? ' on' : '');
    b.innerHTML = `<b>${esc(l)}</b><i>${
      on   ? 'Playing &middot; ' + (mine?.mods || 0) + ' mod' + (mine?.mods === 1 ? '' : 's')
      : have ? 'Available'
      : 'Coming soon'}</i>`;

    if (have) b.onclick = () => useVersion(have[0]);
    else b.disabled = true;
    grid.appendChild(b);
  });

  // Point releases, only when the line in play actually has more than one.
  const picks = $('verPicks');
  if (picks) {
    picks.textContent = '';
    const have = live[activeLine];
    picks.hidden = !have || have.length < 2;
    if (have && have.length > 1) {
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
  if (!box) return;
  const jars = (await window.pp?.modsScan?.().catch(() => [])) || [];
  box.textContent = '';

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

  const hint = $('modsHint');
  if (hint) {
    hint.textContent = `${profile.name} · ${profile.mc} — drop a jar from `
      + 'Modrinth or CurseForge into the folder and rescan.';
  }

  if (!jars.length) {
    box.innerHTML = '<div class="modempty"><h3>No jars yet</h3>'
      + '<p>Open the folder, drop mods in, and rescan.</p></div>';
    return;
  }

  jars.forEach((j) => {
    const row = document.createElement('div');
    row.className = 'jar' + (j.enabled ? '' : ' off');
    row.innerHTML =
      `<span class="jarmeta">
         <b>${esc(j.name)}
           ${j.managed ? '<span class="jartag">PINK PONY</span>' : ''}
           ${j.version ? `<span class="jarver">${esc(j.version)}</span>` : ''}</b>
         <i>${esc(j.description || j.file)}</i>
       </span>`;

    const toggle = document.createElement('button');
    toggle.className = 'sw2';
    toggle.setAttribute('aria-pressed', String(j.enabled));
    toggle.setAttribute('aria-label', j.name);
    toggle.onclick = async () => {
      await window.pp.modsFile('toggle', j.file);
      loadJars();
    };
    row.appendChild(toggle);

    const del = document.createElement('button');
    del.className = 'more';
    del.textContent = '\u00d7';
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

    box.appendChild(row);
  });
}

function wireJars() {
  const folder = $('modsFolder');
  if (!folder) return;
  folder.onclick = () => window.pp?.modsFolder?.();
  $('modsRescan').onclick = () => loadJars();
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
  // The profiles page draws its version tiles from this, so it has to repaint
  // when the list arrives - the first render happens before this resolves.
  drawVersions();
}

async function loadUpdate() {
  const rows = await rest('/rest/v1/client_builds?select=client_version,notes,updated_at'
                          + '&listed=eq.true&mc_version=eq.' + encodeURIComponent(version.value));
  const build = rows[0];
  const title = document.querySelector('.update h3');
  const list = document.querySelector('.ticks');
  const tag = $('updVer');

  if (!build) {
    if (title) title.textContent = 'No build yet';
    if (list) list.innerHTML = '<li>Nothing published for this version.</li>';
    return;
  }

  if (tag) tag.textContent = 'v' + build.client_version;
  if (title) title.textContent = 'Pink Pony ' + build.client_version;
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
/* One tier since 2026-09-25: Premium, $5 a month, never auto-charged. The
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

  head.textContent = 'PREMIUM';
  if (premium) {
    body.textContent = ends ? 'Active until ' + until(ends) + '.' : 'Active - no end date.';
    button.textContent = ends ? 'ADD A MONTH' : 'MANAGE';
  } else {
    body.textContent = 'The client, every mod and the Premium tags. $5 a month, never auto-charged.';
    button.textContent = 'GET PREMIUM';
  }

  button.onclick = () => window.pp?.open?.('https://pinkponyclient.com/purchase.html');

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
  if (changed) { loadServers(); loadServerPage(); pingAll(); }
  else { loadServerPage(); }
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

/* ---------------- mods page ---------------- */
/* The module list is NOT defined here. The game writes modules.json listing
   what this build actually supports, and this page edits the enabled flags.
   A list in this file would drift from the jar within a week. */

let MODS = [];
let modCat = 'All';
let modQuery = '';

async function loadMods() {
  const doc = await window.pp?.modsRead?.().catch(() => null);
  MODS = Array.isArray(doc?.modules) ? doc.modules : [];
  drawCats();
  drawMods(doc?.missing);
}

function drawCats() {
  const box = $('modCats');
  if (!box) return;
  box.textContent = '';
  const cats = ['All', ...new Set(MODS.map((m) => m.category).filter(Boolean))];
  cats.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'cat' + (c === modCat ? ' on' : '');
    b.textContent = c === 'All' ? 'ALL' : c.toUpperCase();
    b.onclick = () => { modCat = c; drawCats(); drawMods(); };
    box.appendChild(b);
  });
}

function drawMods(missing) {
  const box = $('mods');
  if (!box) return;
  box.textContent = '';

  const shown = MODS.filter((m) =>
    (modCat === 'All' || m.category === modCat) &&
    (!modQuery || (m.name + ' ' + (m.description || '')).toLowerCase().includes(modQuery)));

  $('modCount').textContent =
    MODS.length ? `${MODS.filter((m) => m.enabled).length} of ${MODS.length} on` : '';

  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'modempty';
    d.innerHTML = missing
      ? '<h3>Run the game once</h3><p>The client writes the list of modules it supports '
        + 'when it starts. Launch once and they will all be here.</p>'
      : '<h3>Nothing matches</h3><p>Try a different search or category.</p>';
    box.appendChild(d);
    return;
  }

  shown.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'mod' + (m.enabled ? ' on' : '');
    card.innerHTML =
      `<span class="modmeta"><b>${esc(m.name)}</b><i>${esc(m.description || '')}</i>
         <span class="modcat">${esc((m.category || '').toUpperCase())}</span></span>`;

    const sw = document.createElement('button');
    sw.className = 'sw2';
    sw.setAttribute('aria-pressed', String(!!m.enabled));
    sw.setAttribute('aria-label', m.name);
    sw.onclick = () => toggleMod(m, sw, card);
    card.appendChild(sw);
    box.appendChild(card);
  });
}

async function toggleMod(m, sw, card) {
  const next = !m.enabled;
  // Paint first, save second, and put it back if the save fails. A switch that
  // waits on disk before moving feels broken even when it worked.
  m.enabled = next;
  sw.setAttribute('aria-pressed', String(next));
  card.classList.toggle('on', next);
  $('modCount').textContent = `${MODS.filter((x) => x.enabled).length} of ${MODS.length} on`;

  try {
    await window.pp.modsWrite({ [m.id]: next });
  } catch (e) {
    m.enabled = !next;
    sw.setAttribute('aria-pressed', String(!next));
    card.classList.toggle('on', !next);
    launchNote('Could not save that: ' + (e?.message || e));
  }
}

const modSearch = $('modSearch');
if (modSearch) {
  modSearch.oninput = () => { modQuery = modSearch.value.trim().toLowerCase(); drawMods(); };
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
  loadServerPage();
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
  mem.value = settings.memory;
  $('memVal').textContent = gb(settings.memory);
  $('javaPath').textContent = settings.javaPath || 'Automatic';
  $('gameDir').textContent = settings.gameDir || settings.defaultGameDir || '.pinkpony';
  $('codeInput').value = settings.code || '';
  swap($('closeOnLaunch'), settings.closeOnLaunch);
  swap($('keepLogs'), settings.keepLogs);
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
  mem.oninput = () => { $('memVal').textContent = gb(Number(mem.value)); };
  mem.onchange = () => save({ memory: Number(mem.value) }, 'Memory saved');

  document.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.pick;
      const p = await window.pp?.pickPath?.(key === 'javaPath' ? 'file' : 'dir');
      if (p) save({ [key]: p }, 'Saved');
    };
  });
  document.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => save({ [b.dataset.clear]: '' }, 'Cleared');
  });
  document.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = () => window.pp?.showFolder?.(settings?.[b.dataset.open] || '');
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

  $('closeOnLaunch').onclick = () => save({ closeOnLaunch: !settings.closeOnLaunch });
  $('keepLogs').onclick = () => save({ keepLogs: !settings.keepLogs });
}

/* ---------------- servers page ---------------- */
function loadServerPage() {
  const box = $('srvList');
  if (!box) return;
  box.textContent = '';

  if (!SERVERS.length) {
    box.innerHTML = serversLoaded
      ? '<div class="modempty"><h3>No featured servers yet</h3>'
        + '<p>Check back soon. New servers show up here on their own.</p></div>'
      : '<div class="modempty"><h3>Loading servers…</h3></div>';
    $('srvCount').textContent = '';
    return;
  }

  SERVERS.forEach((s) => {
    const p = pings[s.ip];
    const row = document.createElement('div');
    row.className = 'srvcard';
    row.innerHTML =
      `<span class="sico"><svg viewBox="0 0 24 24">${SRVICO}</svg></span>
       <span class="srvmeta">
         <b><span class="ftag">${esc(s.tag)}</span>${esc(s.name)}${p?.version ? ` <span class="vpill">${esc(p.version)}</span>` : ''}</b>
         <i>${esc(s.ip)}</i>
       </span>
       <span class="status">
         <span class="led${p?.online ? '' : ' off'}"></span>
         ${p ? (p.online ? `${p.players}/${p.max}<span class="ms">${p.ms}ms</span>` : 'offline')
             : 'checking…'}
       </span>`;

    const play = document.createElement('button');
    play.className = 'play';
    play.textContent = 'PLAY';
    play.title = 'Start the game and join ' + s.name;
    play.onclick = () => { showPage('home'); startGame(s.ip); };
    row.appendChild(play);

    box.appendChild(row);
  });

  const up = SERVERS.filter((s) => pings[s.ip]?.online).length;
  $('srvCount').textContent = `${up} of ${SERVERS.length} up`;
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
    loadServerPage();
  }
}

function wireServers() {
  const r = $('srvRefresh');
  if (r) r.onclick = () => { loadFeaturedServers().then(pingAll); };
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
  const text = String(raw || '');
  let out = '';
  let st = { colour: '', bold: false, italic: false, under: false, strike: false, obf: false };
  let buf = '';

  const flush = () => {
    if (!buf) return;
    const css = [];
    if (st.colour) css.push('color:' + st.colour);
    if (st.bold) css.push('font-weight:700');
    if (st.italic) css.push('font-style:italic');
    const deco = [st.under && 'underline', st.strike && 'line-through'].filter(Boolean);
    if (deco.length) css.push('text-decoration:' + deco.join(' '));
    out += `<span class="${st.obf ? 'mcobf' : ''}" style="${css.join(';')}">${esc(buf)}</span>`;
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Section sign as well as ampersand: the same string turns up both ways
    // depending on whether it came from Discord or straight out of the game.
    if ((ch === '&' || ch === '§') && i + 1 < text.length) {
      const c = text[i + 1].toLowerCase();
      if (MC_COLOURS[c]) {
        flush();
        // A colour resets formatting in Minecraft. Getting this wrong makes
        // every tag after the first bold code stay bold forever.
        st = { colour: MC_COLOURS[c], bold: false, italic: false,
               under: false, strike: false, obf: false };
        i++; continue;
      }
      if ('klmnor'.includes(c)) {
        flush();
        if (c === 'r') st = { colour: '', bold: false, italic: false,
                              under: false, strike: false, obf: false };
        else if (c === 'k') st.obf = true;
        else if (c === 'l') st.bold = true;
        else if (c === 'm') st.strike = true;
        else if (c === 'n') st.under = true;
        else if (c === 'o') st.italic = true;
        i++; continue;
      }
    }
    buf += ch;
  }
  flush();
  return out || esc(text);
}

/** A tag with its codes taken out, for searching and for the activity line. */
function mcPlain(raw) {
  return String(raw || '').replace(/[&§][0-9a-fk-orA-FK-OR]/g, '');
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

function drawCosCats() {
  const box = $('cosCats');
  if (!box) return;
  box.textContent = '';
  const kinds = ['All', ...new Set(cosList().map((c) => c.kind).filter(Boolean))];
  kinds.forEach((k) => {
    const b = document.createElement('button');
    b.className = 'cat' + (k === cosKind ? ' on' : '');
    b.textContent = k.toUpperCase();
    b.onclick = () => { cosKind = k; drawCosCats(); drawCosmetics(); };
    box.appendChild(b);
  });
}

function drawCosmetics() {
  const box = $('cosGrid');
  if (!box) return;
  box.textContent = '';

  const all = cosList();
  const shown = all.filter((c) =>
    (cosKind === 'All' || c.kind === cosKind) &&
    (!cosQuery || (c.label + ' ' + mcPlain(c.value)).toLowerCase().includes(cosQuery)));

  const mine = all.filter((c) => c.owned).length;
  $('cosCount').textContent = mine
    ? `${mine} owned of ${all.length}`
    : `${all.length} in the store`;

  if (!shown.length) {
    const d = document.createElement('div');
    d.className = 'modempty';
    d.innerHTML = all.length
      ? '<h3>Nothing matches</h3><p>Try another search or category.</p>'
      : '<h3>Nothing to show</h3><p>Sign in to see what you own, or check back '
        + 'once something is listed.</p>';
    box.appendChild(d);
    return;
  }

  shown.forEach((c) => box.appendChild(cosCard(c)));
}

function cosCard(c) {
  const worn = isWorn(c);
  const busy = cosBusy === keyOf(c.kind, c.value);

  const card = document.createElement('div');
  card.className = 'cos' + (worn ? ' worn' : '') + (c.owned ? '' : ' lockedcard');

  // Three different things, three different tiles.
  //
  //   tag        has no artwork - it IS text - so it is drawn rather than
  //              pointed at a PNG that does not exist and left broken
  //   cape       a 64x32-layout SHEET, not a picture. Showing the whole file
  //              puts the inside panel and the edge strips on screen and
  //              squeezes the visible part into a corner. CAPE_UV crops to the
  //              one panel people actually see.
  //   everything else   a plain image
  // Tags are text and always exist; everything else is a file that might not.
  const state = c.kind === 'tag' ? 'ok' : checkArt(c.value, drawCosmetics);

  const art = c.kind === 'tag'
    ? `<div class="cosart tagart"><span class="mctag">${mcHtml(c.value)}</span>`
    : state === 'gone'
    ? `<div class="cosart goneart"><span>${anyArtLoaded() ? 'artwork<br>missing' : 'offline'}</span>`
    : c.kind === 'cape'
    ? `<div class="cosart capeart"><i style="background-image:url('${cosArt(c.value)}');${CAPE_UV}"></i>`
    : `<div class="cosart" style="background-image:url('${cosArt(c.value)}')">`;

  const badge = worn ? '<span class="wornbadge">EQUIPPED</span>'
              : c.owned ? '<span class="owned">OWNED</span>'
              : `<span class="locked">${esc(c.price || (c.premium ? 'PREMIUM' : 'LOCKED'))}</span>`;

  card.innerHTML = art + badge + '</div>'
    + `<div class="cosbody"><b>${esc(c.label)}</b>`
    + `<span>${esc(String(c.kind || '').toUpperCase())}</span></div>`;

  const act = document.createElement('button');
  act.className = 'cosact' + (worn ? ' off' : '');
  act.disabled = busy;
  act.textContent = busy ? '…' : worn ? 'REMOVE' : c.owned ? 'EQUIP' : 'GET';

  act.onclick = () => {
    if (!c.owned) { window.pp?.open?.('https://pinkponyclient.com'); return; }
    // Only refuse when we KNOW the file is the problem.
    //
    // A failed image tells you nothing on its own - with no internet every
    // cosmetic fails, and blocking on that turns "you are offline" into "your
    // cosmetics do not exist", which is a far worse lie than a missing
    // thumbnail. If some other artwork loaded fine, this one really is absent
    // and equipping it would put an invisible cosmetic on your back.
    if (state === 'gone' && !worn && anyArtLoaded()) {
      cosNote(`${c.label} has no artwork uploaded yet.`);
      return;
    }
    equip(c, worn ? '' : c.value);
  };

  card.appendChild(act);
  return card;
}

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
                 go: () => window.pp?.open?.('https://pinkponyclient.com/purchase.html') });
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

  // Patch notes get posted in Discord, so that is where this goes. A button
  // pointing at a notes page that does not exist would be the same dead click
  // with extra steps.
  const patch = document.querySelector('.update .outline');
  if (patch) patch.onclick = () => window.pp?.open?.(DISCORD);

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

/* ---------------- boot ---------------- */
loadActivity();
loadProfiles();
loadVersions();
loadUpdate();
loadJars();
wireJars();
loadTier();
loadMods();
wireServers();
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
        say(`Couldn't check for updates: ${s.message}`);
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

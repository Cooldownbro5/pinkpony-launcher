# Pink Pony launcher

Electron. Same palette and type as pinkponyclient.com, so the launcher and the
site read as one product.

    npm install
    npm start

## What is real

- The window, the custom title bar, the page rail, the launch stage
- News, pulled from the same `banners` table the website uses — post an update
  with `/setbanner` and it appears here too
- "Your stuff", read from `cosmetic_grants` for the signed-in account
- IPC plumbing between the window and the main process

## What is stubbed

`sign-in` and `launch` in `main.js`. Both throw with a message naming the
missing piece, rather than failing silently — a Play button that does nothing
is harder to diagnose than one that says why.

    npm i msmc minecraft-launcher-core

- **msmc** — Microsoft login. Needs an Azure app registration with the
  Minecraft scopes, and Microsoft has to approve third-party use before it
  works at all. Start that form early; it is the long pole and no amount of
  code shortens it.
- **minecraft-launcher-core** — version manifest, libraries, assets, natives,
  and the java command line.

## Security notes, before this ships

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
  renderer draws remote content, so it must never have filesystem access.
  Everything privileged goes through the named channels in `preload.js`.
- The Microsoft token must be encrypted with `safeStorage` before release.
  The stub writes plain JSON, which is fine on your own machine and is a live
  session token for somebody's Microsoft account on anyone else's.

## Still to design

- Which mod jar goes with which Minecraft version — the version picker has to
  choose both, and that is the same multi-version problem the mod has.
- Whether the launcher installs Java 21 itself or refuses politely.

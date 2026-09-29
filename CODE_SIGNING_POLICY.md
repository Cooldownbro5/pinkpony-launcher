# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Only the Pink Pony launcher in this repository is signed: the Windows installer
(`PinkPony-Setup.exe`) and the program it installs. Every signed file is built
by the GitHub Actions workflow in `.github/workflows/release.yml`, on
GitHub-hosted runners, straight from the source in this repository. Nothing
built on a personal computer is signed.

## Team roles

| Role | Who |
|---|---|
| Committers and reviewers | [Cooldownbro5](https://github.com/Cooldownbro5) |
| Approvers | [Cooldownbro5](https://github.com/Cooldownbro5) |

Every release has to be approved by hand in SignPath before it is signed.
All team members use two-factor authentication on GitHub and SignPath.

## Privacy policy

The launcher only sends information to the services below, and only to do
what the user runs it for. It does not sell data or send it anywhere else.

- **Microsoft, Xbox Live and Mojang** - signing in to the user's own Minecraft
  account, and downloading Minecraft, its libraries, assets and Java.
  The Microsoft sign-in is kept encrypted on the user's computer.
- **Pink Pony's servers (Supabase)** - the user's Pink Pony access code, a
  hardware ID for the one-PC lock, the Minecraft name and ID, friends and
  cosmetics, to check the licence and run those features.
- **Fabric (meta.fabricmc.net) and Modrinth (api.modrinth.com)** - downloading
  the Fabric loader and Fabric API.
- **mc-heads.net** - player heads and skins shown in the launcher (Minecraft
  names or IDs only).
- **Featured Minecraft servers** - a standard server-list ping to show whether
  they are online and how many are playing.
- **GitHub** - checking for and downloading launcher updates.

The full terms and what is stored are at <https://pinkponyclient.com/terms.html>.

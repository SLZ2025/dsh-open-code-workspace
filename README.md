# dsh-open-code-workspace

Open a VS Code `.code-workspace` file from the **DeepSeek Harness** sidebar and get
all of its folders as one multi-root Workspace — the same idea as VS Code's
*File → Open Workspace from File…*.

<!-- prettier-ignore -->
| Before | After |
| ------ | ----- |
| A `.code-workspace` file listing several repositories | One Workspace whose root contains every folder as a junction/symlink |

## What it adds

A small branch icon appears in the sidebar **工作区 / Workspaces** header, just
left of the search icon. Clicking it:

1. opens the native file dialog filtered to `*.code-workspace`,
2. reads the file's `folders` (JSON with comments and trailing commas are fine),
3. materializes them as one directory of **junctions** (Windows) or **symlinks**
   (macOS/Linux), and
4. registers that directory as a Workspace and starts a blank Session in it.

Because the entries are links, every edit lands in the real repository. Nothing
is copied, and the file itself is never executed.

## Requirements

* DeepSeek Harness with the **Web** client (Desktop app included), `plugin_manager`
  available to install bundles.
* A platform dialog helper: PowerShell on Windows, `osascript` on macOS,
  `zenity` or `kdialog` on Linux.

## Install

Published on npm as `dsh-open-code-workspace`. Install it from the **Plugins** page,
or hand the package spec to the installer (`dsh-open-code-workspace@0.1.0`). The
bundle is a normal DSH bundle whose patch inserts one row:

```yaml
- insert:
    - id: dsh-open-code-workspace
      name: dsh-open-code-workspace
```

For a local checkout, point the installer at this directory instead of the package
name (e.g. `plugin_manager install_bundle` with the absolute path). The Host half
activates immediately; **refresh the Web page** so the client half loads.

## Usage

1. Refresh the page once after installation.
2. In the sidebar, find **工作区**, then click the open-folder icon between the title
   and the search icon.
3. Pick a `.code-workspace` file (for example `C:\projects\acme.code-workspace`).
4. The Workspace appears with one entry per folder, and a new Session opens there.

The button hides itself while the header's search field is expanded, so it never
overlaps the shipped controls.

## Where the aggregate directory lives

```
$DSH_HOME/multiroot/<file-title>-<folder-list-hash>/
    frontend  -> C:\projects\web-app   (junction / symlink)
    backend   -> C:\projects\api
```

Override the root with `DSH_OPEN_CODE_WORKSPACE_ROOT`. Editing the file's folder
list opens a new farm directory (the hash is part of the name), so an old farm
never shows stale folders; delete `$DSH_HOME/multiroot` whenever you like.

## How it works

See [`docs/DETAIL.md`](docs/DETAIL.md) for the Slot reasoning, the two Host routes,
and the safety notes. In short: the client half registers a button in
`shell.overlay` and anchors it to `[data-sidebar-workspace-header]`; the Host half
owns the native dialog and the junction farm, because a browser can do neither and
a `resource` route only answers `GET`/`HEAD`.

## Troubleshooting

* **No button** — refresh the page; collapse the sidebar search field; widen the
  sidebar so the header actions are visible.
* **`打开失败：picker-unavailable`** — install `zenity`/`kdialog` (Linux) or check the
  dialog command for your platform.
* **`farm-failed` / `EPERM`** — the volume refuses reparse points / symlinks.

## Development

```bash
node --check index.js
node --check client.js
node test/smoke.mjs
```

The smoke test drives both Host handlers with a stub Cordis context and a temporary
`.code-workspace` file; it creates real junctions in a temp directory.

## License

MIT

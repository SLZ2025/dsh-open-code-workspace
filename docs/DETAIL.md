# How dsh-open-code-workspace works

## The gap it fills

DSH already opens a Session in a working directory, and a Workspace is one
directory. VS Code's `.code-workspace` file is a *list* of folders; nothing in
DSH turns that list into one thing you can open. This plugin adds exactly that:
**one file → one Workspace that contains every folder it lists.**

## Where the button lives, and why

The `工作区` section header belongs to `@deepseek-ai/dsh-client-ui-workspace`,
which fills the single Slot `sidebar.workspaces` and exposes no toolbar Slot.
Replacing that Slot would mean re-implementing the whole session browser, so the
button is registered in the frame-wide Slot `shell.overlay` instead — a
click-through layer with no layout duty — and positions itself on the header's
first action button (`[data-sidebar-workspace-header]`) on every animation frame
where the DOM changes. It hides itself while the search field is expanded, so it
never fights the shipped controls for space.

The overlay button is a normal React component from the frozen shell module
table (`react` only — no other client package is required).

## The two Host routes

The browser cannot run a native file dialog and cannot create junctions, so both
live in the Host half. They are `handler` routes rather than `resource` routes
because a resource route only answers `GET`/`HEAD` over HTTP:

| Route                            | Method | Purpose                                        |
| -------------------------------- | ------ | ---------------------------------------------- |
| `/dsh-open-code-workspace/pick`     | POST   | Show the OS file dialog, return `{ path }`.     |
| `/dsh-open-code-workspace/multiroot`| POST   | Read `.code-workspace`, build the farm, return it. |

`pick` shells out once per platform: PowerShell `OpenFileDialog` on Windows,
`osascript` `choose file` on macOS, `zenity` (falling back to `kdialog`) on
Linux. Cancelling answers `{ path: null }`; a second click while a dialog is open
answers `409 picker-busy`.

Both routes run `ctx.connection.authorizeIndex(request, response)` before doing
anything else. That is the same browser-session check DSH's own pages go through:
a request without the authenticated session cookie gets DSH's `401` (or the token
redirect), so a Web page that is not the DSH UI cannot open a file dialog or
create links on the machine.

`multiroot` accepts only an absolute path to an existing `*.code-workspace`
file. It parses the file with a small JSONC reader (VS Code allows `//`, `/* */`
comments and trailing commas), resolves each folder against the file's own
directory, skips missing folders, and materializes the rest as one directory:

```
$DSH_HOME/multiroot/<file title>-<folder-list hash>/
    frontend  -> C:\projects\web-app   (junction / symlink)
    backend   -> C:\projects\api
    ...
```

The hash is derived from the resolved folder list, so editing the file to add or
remove a folder opens a **new** farm instead of reusing the old links; the old
farm is left on disk untouched and can be deleted at any time.

The farm directory is then registered through the client service `workspaces`
and a blank Session starts there. Because every entry is a link, edits land in
the real repositories; nothing is copied.

`DSH_OPEN_CODE_WORKSPACE_ROOT` overrides the farm root.

## Safety notes

* Both routes require the authenticated DSH browser session
  (`ctx.connection.authorizeIndex`); unauthenticated or cross-site requests are
  refused before any dialog or link work happens.
* The Host only ever reads the file the user chose in the dialog; there is no
  endpoint that lists arbitrary directories.
* Request bodies are capped at 8 KiB and paths at 4096 characters.
* Only links are created; the plugin never deletes anything inside the farm root
  (a junction is not a symlink to Node, so removal is not always safe).
* The farm is derived state: deleting it and clicking the button again recreates
  it.

## Troubleshooting

* **The button is missing** — collapse the sidebar search field; the button hides
  while the header's search input is expanded, and it needs the sidebar wide
  enough to show the header actions.
* **`打开失败：picker-unavailable`** — the platform dialog helper could not start.
  On Linux install `zenity` or `kdialog`; on macOS check that `osascript` exists.
* **`farm-failed` / `EPERM`** — junction or symlink creation was refused. On
  Windows this normally means the target volume does not allow reparse points.

## Removing it

Disable the bundle in **Plugins**, then delete `$DSH_HOME/multiroot` if you do not
want the farm directories around.

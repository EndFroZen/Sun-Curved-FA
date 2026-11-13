# Sun Curved Deploy YAML Manual

## 1. Overview: how YAML becomes sh and runs

You write a single YAML file that says "how I want this deployed". Sun Curved turns that YAML into a complete bash script and runs it on the target machine over the SSH connection you are already logged in to. Same idea as Kubernetes: the YAML is a declaration, the actual steps are the program's job.

When you press **Apply** on the Deploy page, this happens in order:

1. **Validate the YAML in the app.** If something is wrong, a red message shows above the editor and nothing is sent to the machine
2. **Save the YAML** on the machine at `~/EndFroZen/SunCurved/deployments/<name>.yaml`
3. **Precheck:** fetch the tag list from git and see which targets have uncommitted changes
4. **Confirm popup:** pick a tag and tick the box to discard uncommitted changes (if any)
5. **Compile to bash:** the chosen tag, the answers about uncommitted changes and the sudo password go into the script
6. **Run:** the whole script is piped into `bash -l -s` on the machine; output appears in the Deploy log line by line while it runs (top right of the Deploy log: **Mounts** prints what is mounted on the machine, **Clear** clears the log, **Full** makes it full screen, **Exit** or Esc puts it back)
7. **Record the result:** writes the tag, ok or failed, and the time to `~/EndFroZen/SunCurved/state/<name>`

To keep your work without deploying, press **Save** (or Ctrl+S) instead. It saves the YAML even if it is unfinished; only `metadata.name` has to be valid, since that is the file name. The remaining errors stay in red until you fix them before Apply.

**Only 2 files are created on the target machine per deployment:**

| File | Holds | Written by |
| --- | --- | --- |
| `~/EndFroZen/SunCurved/deployments/<name>.yaml` | The YAML you wrote | The app, on Save or Apply |
| `~/EndFroZen/SunCurved/state/<name>` | `<tag> ok\|failed <date time>` | The script, when it finishes |

Apply writes no `.sh` file to disk. The script only lives in bash's memory while it runs (if you want a file to run yourself, use **⋯ → Save sh to the machine**, see section 9). So the sudo password never sits in any file and never shows in `ps`. To see the script that will actually run, press the **sh** tab in the view bar.

## 2. YAML basics you need

YAML uses indentation to say what belongs under what. The most important rule: **indent with 2 spaces, never Tab**. In the app's editor, pressing Tab already inserts 2 spaces.

### Map (key: value)

```yaml
metadata:          # a key with things inside ends with : and a new line
  name: my-app     # indented 2 spaces = under metadata
```

- Always put 1 space after `:`, e.g. `name: my-app`, not `name:my-app`
- Keys on the same level must have exactly the same indentation
- Keys are case sensitive: `envFrom` is not `envfrom`

### List

Each item starts with `- `. If an item has several keys, the following keys line up with the first key after `- `

```yaml
targets:
  - name: main            # item 1
    path: ~/app-main      # lined up with name (not with -)
  - name: sub             # item 2
    path: ~/app-sub
```

### One-line form (flow style)

These two mean the same thing; use either:

```yaml
auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }

auth:
  user: GITHUB_USERNAME
  token: GITHUB_TOKEN
```

### Comments

Everything after `#` is a comment and is ignored. After a value there must be a space before `#`, e.g. `dirty: ask   # ask first`

### When to use quotes

Most values need none, but use `"..."` when:

- The value starts with `{` `[` `*` `&` `!` `%` `@` or `` ` ``
- The value contains `: ` (colon followed by a space) or ` #`
- You want text instead of a number or true/false, e.g. `version: "1.10"` (without quotes you get 1.1)

### Multi-line commands (`|`)

Use `|` and write the commands on the following lines, indented 2 more spaces. Every line runs in order; if any line fails the deploy stops right away:

```yaml
    build: |
      npm ci
      npm run build
      pm2 reload ecosystem.config.js
```

### Common mistakes

| Wrong | Right | Why |
| --- | --- | --- |
| Indenting with Tab | 2 spaces | YAML forbids Tab |
| `name:main` | `name: main` | Needs a space after `:` |
| List keys lined up with `-` | Lined up with the first key after `- ` | Otherwise they become keys of the level above |
| `version: 1.10` | `version: "1.10"` | Without quotes it becomes the number 1.1 |
| Duplicate key on the same level | Keep only one | YAML reports "Map keys must be unique" |

## 3. Whole-file structure + apiVersion / kind / metadata

Every file looks like this (fields marked `?` are optional):

```yaml
apiVersion: suncurved/v1        # required, fixed value
kind: Deployment                # required, fixed value
metadata:
  name: <name>                  # required
spec:
  envFrom: <env file>           # ?
  sudo: login-password | none   # ? (default none)
  source:
    repo: <git repo>            # required
    auth: { user: VAR, token: VAR }   # ?
    version: tag | <tag name>   # ? (default tag)
    branch: <branch name>       # ? use instead of version if there are no tags
  targets:                      # required, at least 1
    - name: <name>
      path: <git folder>
      dirty: ask | discard | fail   # ? (default ask)
      build: <command>          # ?
      pm2: <process name>       # ?
      mounts:                   # ?
        - from: <source>
          to: <destination>
```

Unknown keys (e.g. a typo like `biuld`) **are silently ignored, not an error**. If something doesn't behave as expected, press the **sh** tab and check whether that step is really in the script.

### apiVersion and kind

Must be exactly `suncurved/v1` and `Deployment`. This stops a real Kubernetes file from being used here by mistake.

### metadata.name

The name of this deployment, used as the file name on the target machine:

- `~/EndFroZen/SunCurved/deployments/<name>.yaml` — the YAML
- `~/EndFroZen/SunCurved/state/<name>` — latest status, e.g. `v1.2.0 ok 2026-11-05 14:03:11`

Rules: lowercase a-z, digits 0-9 and `-` only, must not start or end with `-`, at most 63 characters.

| Name | Result |
| --- | --- |
| `ssw-icare` | ✅ |
| `app2` | ✅ |
| `SSW-iCare` | ❌ has uppercase |
| `my_app` | ❌ has `_` |
| `-app` | ❌ starts with `-` |

**Careful:** Save/Apply with the same name = overwrites the old file. A new name = a new deployment (the old one stays; delete it yourself with ⋯ → Delete this deployment)

## 4. spec.envFrom and spec.sudo

### envFrom — a variables file on the target machine

```yaml
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
```

The script runs `set -a; . "<file>"; set +a` before anything else, so every variable in the file is exported for the build commands and git.

Example file (lives on the server, not in the app):

```bash
GITHUB_USERNAME=sukkla01
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
NODE_ENV=production
```

- `~/` works; it becomes `$HOME/`
- The file must be valid bash: no spaces around `=`; values with spaces need `"..."`
- File missing → the deploy fails on the first line
- **Secrets stay on that machine only.** The app never reads, stores or sends these values back. `chmod 600` this file

### sudo — whether sudo may be used

| Value | Meaning |
| --- | --- |
| `none` (default) | No sudo; `mounts` can't be used |
| `login-password` | Uses the password saved with the connection as the sudo password |

With `login-password`, the app reads the password from Windows Credential Manager when you press Apply and passes it to the script via stdin (not as an argument, so it doesn't show in `ps`). sudo commands run as `printf '%s\n' "$SUDO_PW" | sudo -S -p ''`

Conditions:

- The user's sudo password must **match** the saved login password
- If the connection uses a key file, the saved value is the key's passphrase, not the sudo password — in that case use `sudo: none` and set NOPASSWD in sudoers for `mount`/`umount` instead
- Right now the app only uses sudo for `mounts`. If a `build` command calls `sudo` itself, nobody will type the password (stdin is /dev/null) and it will error

## 5. spec.source — repo, auth, version

### repo

| Written | Actually used |
| --- | --- |
| `github.com/sukkla01/sprdd-ext` | `https://github.com/sukkla01/sprdd-ext.git` |
| `github.com/sukkla01/sprdd-ext.git` | `https://github.com/sukkla01/sprdd-ext.git` |
| `https://gitlab.example.com/a/b.git` | As written (has a scheme) |
| `git@github.com:sukkla01/sprdd-ext.git` | As written (has `@` = SSH) |
| `file:///srv/repos/app.git` | As written |

With no scheme and no `@`, the app adds `https://` in front and `.git` at the end.

**Never put a token in the URL**, e.g. `https://ghp_xxx@github.com/...` — it would end up in the YAML file and in the log. Use `auth` instead.

### auth (optional — not needed for a public repo or an SSH key)

```yaml
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
```

The values are **variable names** from `envFrom`, not the real values (must start with a letter or `_`, followed by letters, digits, `_`). git gets the username/password through a credential helper that reads the variables at run time, so the token is never in the URL, never in a command and never in `.git/config`.

GitHub: the token needs read access to the repo (fine-grained: Contents = Read)

### version

| Value | Behaviour |
| --- | --- |
| `tag` (default) | On Apply the app runs `git ls-remote --tags` and lets you pick a tag in the popup (newest on top, version order: v1.10.0 > v1.9.0) |
| A tag name, e.g. `"v1.2.0"` | Pinned to that tag; the popup shows a single choice |

Good to know:

- `version` only works with **tags**; a commit hash won't work. If the project has no tags, use `branch` instead (see below)
- The tag must be pushed to the remote: `git tag v1.2.0 && git push origin v1.2.0`
- Quote versions that look like numbers, e.g. `"1.10"`
- Checking out a tag leaves the repo in detached HEAD; that's normal

### branch — projects without tags (git pull)

```yaml
  source:
    repo: github.com/me/api
    branch: main
```

- No tag to pick on Apply; it fetches the latest commit of that branch
- Works like `git pull --ff-only` but fetches from `spec.source.repo`: `fetch` → `checkout <branch>` → `merge --ff-only`
- If the local branch has commits not on the remote (diverged) it stops and won't merge; fix it yourself in Terminal
- The state is recorded as `main@a1b2c3d ok <date time>`
- `version` and `branch` can't be used together; in the form pick the **git pull branch** chip

## 6. spec.targets — every field

Each target = one git folder on the target machine, done one at a time **in the order written** (e.g. main project first, then the sub project). Every target deploys the same tag from the same repo.

| Field | Required | Default | What it does |
| --- | --- | --- | --- |
| `name` | ✅ | — | Name in the log; same rules as metadata.name |
| `path` | ✅ | — | An already-cloned folder (`~/` works) |
| `dirty` | — | `ask` | What to do with uncommitted changes |
| `build` | — | no build | bash command run in `path` |
| `pm2` | — | no check | pm2 process name to report the status of |
| `mounts` | — | none | bind mounts (needs `sudo: login-password`) |

### steps — anything, in any order

```yaml
    - name: main
      path: ~/EndFroZen/project/anima_dashboard
      dirty: ask
      steps:
        - unmount: public/cache
        - checkout
        - run: npm ci
        - run: ./build.sh
        - mount: { from: /data/cache, to: public/cache }
        - pm2: { app: anima-dashboard, do: restart }
        - log: deploy $TAG done, check the website
```

| Step | What it does |
| --- | --- |
| `checkout` | Fetches the chosen tag (or git pull with `branch`), using the target's `dirty`. Only once per target |
| `run: <command>` | Runs a bash command in path; `|` for multiple lines |
| `unmount: <to>` | Unmounts if mounted (needs `sudo: login-password`) |
| `mount: { from, to }` | `mount --bind` then checks it stuck (needs `sudo: login-password`) |
| `pm2: { app, do }` | `do` = `restart` / `reload` / `status` (default status), then prints the status |
| `log: <text>` | Writes a message to the Deploy log in blue, prefixed with `## `. `$TAG`, `$BRANCH` and env file variables work; `|` for multiple lines. Not counted as a step (not shown in Flow) |
| `if: { run, then, else }` | Runs `run` as the condition (in path). Exit 0 = **pass**, runs `then` / failure = **fail**, runs `else`, and the deploy **carries on** (doesn't stop). ifs can be nested; `checkout` can't go inside |
| `fail: <text>` | Stops the deploy here, prints `!! text` and records it as failed (use with `else`) |

Runs top to bottom; a failing step = stop. The log shows `==> main: npm ci`

#### if — check for a failed build or your own condition

```yaml
      steps:
        - checkout
        - if:
            run: ./build.sh                 # condition = any command
            then:                           # build passed
              - pm2: { app: my-app, do: restart }
            else:                           # build failed
              - log: build $TAG failed, keeping the old one
              - run: git checkout -q -      # back to the previous commit
              - fail: build failed          # count the deploy as failed too (leave out = success)
```

Examples of your own conditions: `test -f dist/index.html` (file exists?), `[ "$TAG" != v0.0.0 ]`, `curl -fs localhost:3000/health`, `! git diff --quiet HEAD@{1} -- package.json` (package.json changed). `then` or `else` can be left out (but one of them is required).

In a multi-line condition (`|`), whichever line fails = fail right away; the rest isn't run. In Flow, the steps of the branch not taken show dashed and struck through, and there are Simulate buttons for both "pass" and "fail". In the form press **+ if** and add steps under "if pass" / "if fail", or press the ↳ (move) button on any step: move into "if pass" / "if fail" of any if, move out of an if, or on a command step (e.g. `npm run build`) choose "Use this command as an if condition".

"Build failed" is judged by the **exit code**; `2>&1` isn't needed (that only merges errors into the printed output). `npm run build`, `tsc`, `vite build` etc. exit non-zero by themselves when they fail. For your own .sh script, put `set -e` at the top or `exit 1` on failure, otherwise you get the exit code of the last line.

**The old format still works:** a target without `steps` but with `build` / `mounts` / `pm2` runs in the fixed order (unmount → checkout → build → mount → pm2 status). `steps` can't be mixed with the old keys in the same target. In the form, the first time you edit the steps it converts to `steps` for you.

### path

Must be an existing git repo; the app **does not clone it for you**. The first time, clone it yourself in Terminal: `git clone https://github.com/x/y.git ~/Projects/y`. The script always fetches from `spec.source.repo` (not `origin`).

### dirty

"dirty" = `git status --porcelain` is not empty, including new untracked files (`??`), except those in `.gitignore`

| Value | Behaviour |
| --- | --- |
| `ask` | The Apply popup shows the changed files (first 15 lines) and you must tick "discard" before Deploy can be pressed |
| `discard` | Discards without asking: `git reset --hard` + `git clean -fd` |
| `fail` | Stops the deploy right away, touches nothing |

`git clean -fd` really deletes untracked files, but not files in `.gitignore` (e.g. `node_modules`, `.env`). Only use `discard` on folders nobody edits by hand.

### build

Any bash command, run after `cd <path>`; `|` for multiple lines. Runs under `set -Eeo pipefail`; any failing command = stop

```yaml
      build: |
        npm ci
        npm run build
        pm2 reload ssw-icare || pm2 start npm --name ssw-icare -- start
```

- **PATH matches Terminal automatically.** Before starting, the app asks `bash -i` for PATH (loads `~/.bashrc` just like opening Terminal) and uses it. So Go, node/npm/pm2 from nvm that work in Terminal also work in a deploy, nothing extra to set
  - If `.bashrc` has a problem (error, hangs over 10 s), PATH stays the login shell's and the deploy carries on
  - If you set `PATH=...` in the env file, that wins (the env file loads later)
  - Still getting `command not found` or the wrong Go/node version: add a step `which go node pm2; go version` and compare with Terminal
- **stdin is /dev/null.** Commands that prompt (y/n, passwords) get EOF; use non-interactive flags such as `-y`
- Existing scripts like `./ssw-icare-builder.sh` can be called directly
- If you `cd` inside build, the next target `cd`s back by itself, no worries
- Need to switch nginx (blue/green)? Call your switch script directly in build, e.g. `~/switch-3001.sh` (see example 8.4)

### pm2

Only **reports** the status (`pm2 describe <name>`, the status/version lines) and **does not restart it**. If not found it just prints `pm2: <name> not found` and doesn't fail. To reload, put it in `build`

### mounts

```yaml
      mounts:
        - from: /home/ict016/Document/merge-file   # source (full path or ~/)
          to: public/merged-cache                   # destination, relative to path
```

- A `to` not starting with `/` or `~` is relative to the target's `path`
- Before checkout: if `to` is a mountpoint → `umount` (otherwise git would see the mounted files)
- After build: `mkdir -p <to>` → `mount --bind <from> <to>` → checked with `mountpoint`; not mounted = fail
- These mounts disappear on reboot; Apply again (or add them to `/etc/fstab` yourself)
- Put `to` in the repo's `.gitignore`, otherwise the folder made by `mkdir` makes the repo dirty

## 7. The actual order of work, and failures

The compiled script always runs in this order, no matter how you order the keys in the YAML:

**Header (once)**

1. `set -Eeo pipefail` + an ERR trap
2. Create `~/EndFroZen/SunCurved/state/`
3. (If `sudo: login-password`) set up `sudo_cmd`
4. (If `envFrom`) load the env file
5. Set `GIT_URL` and `git_auth`

**Per target (in list order)**

| # | Step in the log | When |
| --- | --- | --- |
| 1 | `==> <name>: unmount` | Has `mounts` |
| 2 | `==> <name>: checkout $TAG` | Always (check dirty → fetch tag → checkout → print commit) |
| 3 | `==> <name>: build` | Has `build` |
| 4 | `==> <name>: mount` | Has `mounts` |
| 5 | `==> <name>: pm2 <app>` | Has `pm2` |

**End:** `==> DEPLOYMENT SUCCESS`, prints the Tag and writes the state `<tag> ok <date time>`

### When a command fails

The first command with a non-zero exit stops the whole script right away (the remaining targets aren't touched) and prints:

```text
!! FAILED at: main: build
```

- `FAILED at` = the latest step name (matches the `==>` line above). Scroll up to the output before it to find the cause
- The state becomes `<tag> failed <date time>` and the list on the left shows it
- **No automatic rollback** — the repo may be left on the new tag that failed to build. Fix it and Apply again (same tag or an older working tag)
- A mount that was unmounted stays unmounted until an Apply gets past the mount step

Exception: commands after `||`, inside `if`, or in a function that handles errors itself won't stop it (bash `set -e` rules)

## 8. Ready-to-use examples

### 8.1 The smallest that works

Public repo, no build — just check out a tag:

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: docs-site
spec:
  source:
    repo: github.com/me/docs-site
  targets:
    - name: main
      path: ~/www/docs-site
```

### 8.2 Node app + pm2, private repo

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: api
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
  source:
    repo: github.com/me/api
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
  targets:
    - name: api
      path: ~/Projects/api
      dirty: fail
      build: |
        npm ci
        npm run build
        pm2 reload api
      pm2: api
```

### 8.3 Pinned version

```yaml
  source:
    repo: github.com/me/api
    version: "v2.4.1"
```

The Apply popup has a single choice: `v2.4.1`

### 8.4 Full example — converted from ssw-icare-controller.sh

Equivalent to the old script: unmount cache → checkout → switch to 3001 + build + switch back to 3000 (in build) → mount → then the sub project

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: ssw-icare
spec:
  envFrom: ~/EndFroZen/CommandCenter/endfrozen.env
  sudo: login-password
  source:
    repo: github.com/sukkla01/sprdd-ext
    auth: { user: GITHUB_USERNAME, token: GITHUB_TOKEN }
    version: tag
  targets:
    - name: main
      path: ~/Projects/ssw-icare
      dirty: ask
      build: |
        ~/EndFroZen/CommandCenter/switch-3001.sh
        ./ssw-icare-builder.sh
        ~/EndFroZen/CommandCenter/switch-3000.sh
      pm2: ssw-icare
      mounts:
        - from: /home/ict016/Document/merge-file
          to: public/merged-cache
    - name: switch
      path: ~/Projects/ssw-icare-switch
      dirty: ask
      build: ./ssw-icare-builder.sh
      pm2: ssw-icare-switch
```

Adjust the paths, pm2 names and mount paths to the real machine before the first Apply — the **sh** tab lets you compare with the old script line by line

What changed from the old script:

| Old script | Now |
| --- | --- |
| Token in the git URL | Credential helper reads it from env at run time |
| `echo $SUDO_PASSWORD \| sudo -S` from the env file | Login password from Credential Manager, passed via stdin |
| `read -p` to pick a tag in the terminal | Tag picker popup in the app |
| y/n prompt when dirty | Checkbox in the popup |

## 9. Using the editor in the app

Open a machine → **Deploy** button → the Deploy page: the left side lists the deployments on that machine (with ok / failed / never status), the right side is the editor and the log

### Form mode and YAML mode

The **[ Form | YAML ]** buttons on the toolbar switch how you edit. Both edit the same file; changes in the form update the YAML right away. The app remembers the mode you used last

| In the form | In the YAML |
| --- | --- |
| Folder button next to Path / Env file / mount | Opens a folder or file picker on the machine, gives a `~/...` path |
| **+ command** / **+ unmount** / **+ mount** / **+ pm2** / **+ if** / **+ stop** | Adds a step to `steps` (mount/unmount turn on sudo automatically); an if has its own "if pass" / "if fail" lists |
| **+ script .sh** | Pick a file on the machine and add it as a `run` step (inside the target's path you get `./filename`) |
| Drag the label in front of a step | Reorder the steps (or use the up/down arrows that appear on hover) |
| **+ Add target** | Adds the next project to `targets` |
| pm2 process name field | Offers names from `pm2 jlist` on the machine. If pm2 isn't installed, **+ pm2** is disabled and existing pm2 rows show a red warning (it won't start the pm2 daemon for you) |
| Tick Repo private | Adds `auth`; the user/token fields offer variable names from the env file (reads names only, never values) |

- Invalid fields get a red border, and the message shows under the toolbar just like YAML mode
- Comments in the YAML are kept, except on things you delete in the form
- If the YAML is broken beyond reading (e.g. bad indentation), the form can't open; fix it in YAML mode first
- An empty field in the form = that key is left out of the YAML

### Autocomplete

Autocomplete knows where the cursor is in the structure (from the indentation) and only offers keys that are valid there

| Do | Get |
| --- | --- |
| Type a letter at the start of a line | The keys for that level, with descriptions |
| Type `key: ` (after the space) | Valid values, e.g. `sudo:` → login-password / none, `dirty:` → ask / discard / fail |
| **Ctrl+Space** on an empty line | Opens the list yourself (empty lines don't pop it up, so it doesn't get in the way) |
| ↑ ↓ then Enter | Inserts the selection / Esc closes |

### Snippets

Entries labelled `snippet` insert a whole block with fields to fill; **Tab** jumps to the next field:

- `- target` — in `targets:`, a new target with name / path
- `- mount` — in `mounts:`, from / to
- `metadata`, `spec`, `source`, `targets` etc. — the key with its inner structure

### Shortcuts

| Key | Does |
| --- | --- |
| Tab / Shift+Tab | Indent / outdent 2 spaces (works on several lines) |
| Ctrl+/ | Toggle comment |
| Ctrl+F | Find / replace |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Alt+↑ / Alt+↓ | Move line |
| Ctrl+S | Save (without deploying) |

### Checked as you type

On every edit the app runs the same validator as Apply and shows red errors under the toolbar (meanings in section 10). No error = ready to Apply

### Toolbar

`Form | YAML ┆ Flow | sh`   📖   ⋯   **Save**   **Apply**

| Part | Does |
| --- | --- |
| **Form** / **YAML** | Edit mode (remembers which you prefer) |
| **Flow** | Shows the steps as a 3D diagram (isometric: blocks joined by pipes, an if splits in two), or switch to "List" at the top right. Click a block to see its commands, press Simulate; lights up during Apply |
| **sh** | The bash script that will really run (read only). The tag shows as `<chosen at deploy>`, the sudo password as `********`. Press Form/YAML to go back to editing |
| 📖 | This manual |
| ⋯ | **Save sh to the machine** and **Delete this deployment** (click twice to confirm) |
| **Save** | Saves the YAML without deploying, even if unfinished (only `metadata.name` must be valid) |
| **Apply** | Deploys the open one |

### Apply several (queue)

In the Deployments list on the left, hover and click the circle in front of a name to pick it. The number in the circle = the run order (the order you clicked). A queue bar appears at the bottom:

- **All** / **Clear** — pick all / remove all
- **On failure** — **Stop the queue** (the rest don't run) or **Skip to the next one** (remembered)
- **Apply N in order**

First it asks the popups (pick tag / discard) for **every one up front**; the popup title shows the position, e.g. `[2/3]`. Cancel = skip that one. Then it runs them **one by one** on its own, no need to watch. The circles change colour with the result (orange = running, green = ok, red = failed, faded = not run) and the log ends with a summary `queue done: …`

- The one open in the editor uses the editor's content (saved first, like Apply), and the Flow lights up when its turn comes. The others use the file saved on the machine
- One at a time because a machine runs one command at a time (parallel builds would also fight over CPU/RAM). Different machines (different tabs) can Apply at the same time

### If the connection drops

Apply and the queue run **on the machine**, not in the app: the whole queue is started there up front (each one waits for the one before, and "On failure" is checked there too), so closing the app or losing the network doesn't stop it. Each run's output goes to `~/EndFroZen/SunCurved/run/<name>/log`.

Reconnect, and a deployment still going shows `deploying… (open to watch)` in the list; click it and the log and Flow replay from the start and keep following. `deploy failed (stopped without finishing)` = the run was killed or the machine restarted. The machine needs `setsid` and GNU `tail` (any normal Linux; not Alpine/busybox).

### Apply — what happens

1. Validate the YAML (invalid = nothing is sent)
2. Save the file to `~/EndFroZen/SunCurved/deployments/<name>.yaml`
3. Precheck: fetch the tag list + check which targets are dirty
4. Popup: pick a tag (top = latest) and tick discard for targets with `dirty: ask` — Cancel works (the file is already saved but nothing runs)
5. Build the real script, pipe it into `bash -l -s` on that machine
6. The log streams in live: `==>` lines = steps, `!!` = failure (red)

### Save sh

Writes the script to `~/EndFroZen/SunCurved/scripts/<name>.sh` (`chmod 700`, only that user can read/run it) so you can run it yourself in Terminal:

```bash
~/EndFroZen/SunCurved/scripts/<name>.sh v1.2.0    # version: tag needs a tag
~/EndFroZen/SunCurved/scripts/<name>.sh           # branch or pinned tag
```

Differences from Apply:
- **No sudo password in the file** — mount/unmount let sudo ask for the password in Terminal
- `dirty: ask` asks `discard these changes in main? [y/N]` in Terminal
- PATH comes from `~/.bashrc`, same as Deploy
- Output stays in Terminal, not the Deploy log, and the Flow doesn't light up, but the state is still recorded
- Press ⋯ → Save sh again after every YAML change; the old file doesn't update itself

### Delete a deployment (⋯ → Delete this deployment)

Deletes only Sun Curved's files (`deployments/<name>.yaml`, `state/<name>` and `scripts/<name>.sh`). **Does not touch the project folder, mounts or pm2**

## 10. All errors and how to fix them

### Errors while writing (shown under the toolbar)

| Message | Cause | Fix |
| --- | --- | --- |
| `YAML: ...` | YAML syntax error, e.g. Tab, misaligned indentation, missing space after `:`, duplicate key | The message ends with the line/column; see section 2 |
| `apiVersion must be "suncurved/v1"` | Missing or misspelt | `apiVersion: suncurved/v1` |
| `kind must be "Deployment"` | Missing or misspelt (capital D) | `kind: Deployment` |
| `metadata.name: lowercase letters, digits and '-' only` | No name, or has uppercase / `_` / spaces | e.g. `my-app` |
| `spec.sudo must be "login-password" or "none"` | Some other value, e.g. `yes` | Pick one of the two |
| `spec.source.repo is required` | No `source.repo` | Add the repo |
| `spec.source.auth: user/token must be env var names` | Put the real token or a name with `-` | Use variable names from envFrom, e.g. `GITHUB_TOKEN` |
| `spec.source: use either version (tags) or branch (git pull), not both` | Both version and branch set | Pick one |
| `spec.source.branch: not a valid branch name` | Branch name has spaces or odd characters | e.g. `main`, `release/1.x` |
| `spec.targets: at least one target` | No `targets` or empty | Add `- name: ... path: ...` |
| `spec.targets[0].name: ...` | Target has no name or breaks the rules | Same rules as metadata.name |
| `spec.targets[0].dirty: ask \| discard \| fail` | Wrong value | Pick one of the three |
| `spec.targets[0].mounts need spec.sudo: login-password` | Has mounts but sudo is none | Set `sudo: login-password` |
| `spec.targets[0].path is required` | No path | Add a path |
| `spec.targets[0].mounts[0].from is required` (or `to`) | Incomplete mount | Set both from and to |

`[0]` = counting from 0, i.e. the first target; `[1]` is the second

### Errors on Apply

| Seen in the log | Usual cause | Fix |
| --- | --- | --- |
| `no tags found` | Repo has no tags, wrong URL, or auth failed | Push a tag; check the repo; check the envFrom variables |
| `No such file or directory` on the first line | The `envFrom` file doesn't exist | Create it or fix the path |
| FAILED at `<name>: checkout` + `not discarding` | Dirty and discard wasn't picked | Commit/stash yourself or tick discard |
| FAILED at `checkout` + `cd: ... No such file` | path doesn't exist / not cloned yet | Clone first (section 6) |
| FAILED at `checkout` + `Authentication failed` | Token wrong/expired/no access | Issue a new token in the env file |
| FAILED at `checkout` + `couldn't find remote ref` | Tag not on the remote | `git push origin <tag>` |
| FAILED at `build` + `command not found` | No node/npm/pm2 even in Terminal | Install it so it works in Terminal first (deploy uses the same PATH as Terminal) |
| FAILED at `unmount`/`mount` + `incorrect password` | sudo password doesn't match the saved login password | Fix the password with the ✎ button or use NOPASSWD |
| FAILED at `pull <branch>` + `Not possible to fast-forward` | Local branch diverged from the remote | Fix it in Terminal, e.g. `git reset --hard origin/<branch>` |
| `mount failed: ...` | from doesn't exist | Create the source folder |
| FAILED at `build` + `Permission denied` | A script called in build isn't executable | `chmod +x` |

## 11. Security, limitations and FAQ

### Security

- Connection passwords live only in **Windows Credential Manager**, not in sqlite and not in the YAML
- The sudo password reaches the script via stdin, not the command line (invisible to `ps`), and is never written to disk on the target machine
- The git token lives in the env file on the target machine and is used through a credential helper; never in the URL or in `.git/config`
- 2FA codes are typed every time and never stored
- The YAML is stored as plain text on the target machine — **never put secrets in the YAML**; put them in the env file and `chmod 600` it
- `build` is a full shell command: whoever can edit the YAML can run anything as that user

### Current limitations

- While the app is watching a deploy, that machine's terminal is blocked until it finishes (same connection)
- No cancel button mid-way yet
- build can't answer prompts (stdin = /dev/null)
- `sudo: login-password` only works when the sudo password = the login password
- Deploys from a tag or a branch (git pull), one repo per deployment
- No automatic rollback, no cloning, no pm2 restart for you (put it in build)

### FAQ

**Is a .sh file created on the machine?** Not on Apply. The script is piped via stdin straight into `bash -l -s` and then gone; you can view it in the sh tab. A file only exists if you press **⋯ → Save sh to the machine** yourself

**Why wrap the script in `{ ... } < /dev/null`?** So bash reads the whole script before running it, and so commands in build (anything that reads stdin) can't eat the rest of the script

**How do I roll back?** Apply again and pick an older working tag in the popup

**Several servers deploy the same project?** Create a deployment with the same name on each machine; the files are separate per machine

**Can I edit the YAML on the target machine myself?** Yes, edit `~/EndFroZen/SunCurved/deployments/<name>.yaml` and press refresh in the app

**Want a step that isn't in the schema?** Put it in `build`; anything bash can do

**What tag was deployed last?** See the status next to the name in the list on the left, or `cat ~/EndFroZen/SunCurved/state/<name>`

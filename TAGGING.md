# Myax Plugin Store — Tagging & Recommended-List Guide

This is how you control what shows up in the Plugin Store, entirely from GitHub —
no edits to the plugin code, no rebuild needed for most changes.

The store has two groups:

- **max2fly Plugins** — discovered automatically from your GitHub repos by a topic.
- **Recommended** — a curated list of third-party plugins you vouch for.

---

## 1. Listing one of your own plugins (topics)

The store calls `GET /users/max2fly/repos` once and keeps every repo that has the
topic **`vencord-plugin`**. That's the whole mechanism — tag a repo and it appears;
remove the tag and it's gone. Forks and non-plugin repos are ignored automatically.

### Add the topic
1. Open the repo on GitHub → the main page.
2. Click the ⚙️ gear next to **About** (top-right of the repo page).
3. In **Topics**, type `vencord-plugin` and press Enter. Save changes.

The repo now shows in the store (its card uses the plugin's real name/description,
read from the repo's `index.tsx`/`index.ts`).

### Requirements for a taggable plugin
- **Standalone repo**: the repo root *is* the plugin (an `index.tsx`/`index.ts`
  that calls `definePlugin(...)`). Monorepos / subfolder plugins are not supported.
- **Dependency-free (clone-and-go)**: the plugin must not declare runtime
  `dependencies` in a `package.json` — it may only use what Vencord already ships
  (and `devDependencies` like vitest are fine). If a repo declares runtime
  dependencies, the store shows it but disables the button with
  **"Needs manual install (has dependencies)"**.

### Platform tags (optional)
If a plugin only works on some hosts/OSes, add one or more of these topics
alongside `vencord-plugin`. The store detects the user's host (Vesktop vs Discord
desktop) and OS and, on an incompatible host, shows the card with a disabled button
and a badge instead of letting them install something that can't work:

| Topic | Meaning / badge |
|-------|-----------------|
| `vesktop-only` | Requires Vesktop |
| `discord-desktop-only` | Requires the Discord desktop app |
| `windows-only` | Windows only |
| `linux-only` | Linux only |
| `macos-only` | macOS only |

No platform topic = works everywhere. You can combine them (e.g.
`vesktop-only` + `windows-only`).

---

## Prerequisites (plugin dependencies)

A plugin can declare that it needs **other Vencord plugins** to be present, using
Vencord's own `dependencies` field in its `definePlugin` call:

```ts
export default definePlugin({
    name: "MyPlugin",
    dependencies: ["MessageEventsAPI", "SomeOtherPlugin"],
    // …
});
```

The store reads that array (from the repo's `index.tsx`/`index.ts`, for both your
own and recommended plugins) and resolves each name when you install:

- **Built-in Vencord plugins / APIs** (e.g. `MessageEventsAPI`, `CommandsAPI`) and
  anything you already have installed are ignored — they're already loaded, so
  there's nothing to do.
- **A prerequisite that is itself in this store** (one of your tagged repos, or an
  entry in `recommended.json`) is installed automatically, in the same action,
  behind a single confirmation ("… also needs: X, which will be installed too.").
- **A prerequisite the store doesn't carry** can't be auto-installed; the store
  tells you to install it manually ("Requires X, which isn't in this store …").

Prerequisites are matched by the plugin's **real internal `definePlugin({ name })`**,
not the card's display name — which is why the store resolves recommended entries'
real names from their source. This is separate from the `package.json` runtime-deps
check in §1: `dependencies` here means *other plugins*, while a `package.json`
`dependencies` block means *npm packages* and still disables the card entirely.

---

## 2. Adding a recommended third-party plugin (the manifest)

Recommended plugins aren't yours, so they won't have your topic. Instead they live
in a curated JSON file in **this** repo: `recommended.json`. The store fetches it
live from
`https://raw.githubusercontent.com/max2fly/VencordMyaxPluginStore/main/recommended.json`,
so **adding an entry only requires pushing that file** — nobody has to rebuild the
store. (If the fetch ever fails, the store falls back to the copy bundled with the
plugin.)

### Format
The only required field is `repo`. The card's **name, description, and author are
read automatically from the plugin's own `index.tsx`/`index.ts`** (the same
`definePlugin({ name, description })` the store already reads for your own plugins;
the author defaults to the repo owner). So the minimal entry is just:

```json
{
  "plugins": [
    { "repo": "someuser/CoolPlugin" }
  ]
}
```

`displayName` / `description` / `author` remain accepted as **optional overrides** —
provide one only when you want the card to show something other than what the plugin
declares. Platform flags are manifest-only (they can't be inferred from the source):

```json
{
  "plugins": [
    {
      "repo": "someuser/CoolPlugin",
      "displayName": "Cool Plugin",
      "description": "A friendlier one-line summary than the plugin's own.",
      "author": "someuser",
      "platforms": ["windows", "linux"],
      "vesktopOnly": false,
      "discordDesktopOnly": false
    }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `repo` | **yes** | `owner/name`. The store installs it from `https://github.com/owner/name.git`. Entries missing `repo` are ignored. |
| `displayName` | no | Override for the card title. Omit to use the plugin's real `definePlugin({ name })` (falling back to the repo name). Purely cosmetic — the real internal name is still resolved from disk after cloning. |
| `description` | no | Override for the one-line description. Omit to use the plugin's `definePlugin({ description })` (falling back to empty). |
| `author` | no | Override for the shown author. Omit to use the repo owner (the part before `/`). |
| `platforms` | no | Array of `"windows"` / `"linux"` / `"macos"`. Omit = any OS. Manifest-only. |
| `vesktopOnly` | no | `true` → "Requires Vesktop". Manifest-only. |
| `discordDesktopOnly` | no | `true` → "Requires the Discord desktop app". Manifest-only. |

### Requirements for a recommended plugin
Same as your own: it must be a **standalone, dependency-free** repo (repo root is
the plugin, no runtime npm deps). Don't recommend monorepo/subfolder plugins — the
store clones the whole repo into `src/userplugins/<name>`.

### Steps
1. Edit `recommended.json` in this repo, adding an object to the `plugins` array.
2. Commit & push to the `main` branch of `max2fly/VencordMyaxPluginStore`.
3. Done — it appears in every user's store under **Recommended** on their next
   store open (no rebuild).

---

## Quick reference

- **Show one of my plugins:** add topic `vencord-plugin` to the repo.
- **Mark compatibility:** add `vesktop-only` / `windows-only` / etc. topics.
- **Recommend someone else's plugin:** add an entry to `recommended.json` and push.
- **A plugin won't install (greyed out):** either incompatible with the user's host
  (badge says why) or it declares runtime dependencies ("Needs manual install").

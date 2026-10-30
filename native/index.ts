/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";

import { parseDefinePluginMeta, parsePackageJsonDeps } from "../github";
import type { GitResult, Platform } from "../types";
import { git, userpluginsDir, validateRepoName } from "./git";

function invalid<T = string>(repoName: string): GitResult<T> {
    return { ok: false, message: `Invalid plugin name: ${repoName}` };
}

/** Map the Node platform id onto the store's Platform union. */
export async function getPlatform(_event: IpcMainInvokeEvent): Promise<Platform> {
    switch (process.platform) {
        case "win32":
            return "windows";
        case "darwin":
            return "macos";
        default:
            return "linux";
    }
}

/** Names of directories under userpluginsDir() that are git working copies. */
export async function listInstalled(_event: IpcMainInvokeEvent): Promise<string[]> {
    const dir = userpluginsDir();

    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const installed: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            // `.git` can be a directory or (for submodules/worktrees) a file.
            await stat(join(dir, entry.name, ".git"));
            installed.push(entry.name);
        } catch {
            // Not a git repo; skip.
        }
    }
    return installed;
}

/** Clone a plugin repo into userpluginsDir() under `repoName`. */
export async function clonePlugin(_event: IpcMainInvokeEvent, cloneUrl: string, repoName: string): Promise<GitResult> {
    if (!validateRepoName(repoName)) return invalid(repoName);

    const dir = userpluginsDir();
    await mkdir(dir, { recursive: true });

    // No `--branch`: recommended entries use defaultBranch "HEAD", i.e. let the
    // remote pick its own default branch. The `--` terminator stops git from
    // parsing a leading-dash cloneUrl/repoName (the spec regex permits a leading
    // `-`) as an option.
    return git(["clone", "--", cloneUrl, repoName], dir);
}

/** Fast-forward-only pull of an installed plugin. */
export async function pullPlugin(_event: IpcMainInvokeEvent, repoName: string): Promise<GitResult> {
    if (!validateRepoName(repoName)) return invalid(repoName);

    const dir = userpluginsDir();
    return git(["-C", join(dir, repoName), "pull", "--ff-only"], dir);
}

/**
 * Auto-fix a pull collision: stash the local changes (`-u` also stashes untracked
 * files) so they're PRESERVED in `git stash` — never discarded — then fast-forward
 * pull. "No local changes to save" is not a failure: nothing to stash, so proceed
 * to the pull. Returns the pull result (or the stash error if the stash itself failed).
 */
export async function stashAndPull(_event: IpcMainInvokeEvent, repoName: string): Promise<GitResult> {
    if (!validateRepoName(repoName)) return invalid(repoName);

    const repoDir = join(userpluginsDir(), repoName);

    const stashed = await git(["-C", repoDir, "stash", "push", "-u"], repoDir);
    if (!stashed.ok && !/no local changes to save/i.test(stashed.message)) return stashed;

    return git(["-C", repoDir, "pull", "--ff-only"], repoDir);
}

/**
 * Auto-fix a missing userplugins directory. `clonePlugin` already creates it on
 * install; this is the explicit, user-triggered recreate action for the error banner.
 */
export async function ensureUserpluginsDir(_event: IpcMainInvokeEvent): Promise<GitResult> {
    const dir = userpluginsDir();
    try {
        await mkdir(dir, { recursive: true });
        return { ok: true, value: dir };
    } catch (error: any) {
        return { ok: false, message: error?.message || "failed to create userplugins directory", error };
    }
}

/** Fetch and report whether the local checkout is behind its upstream. */
export async function getStatus(
    _event: IpcMainInvokeEvent,
    repoName: string
): Promise<GitResult<{ behind: boolean; localHash: string; }>> {
    if (!validateRepoName(repoName)) return invalid(repoName);

    const repoDir = join(userpluginsDir(), repoName);

    const fetched = await git(["fetch"], repoDir);
    if (!fetched.ok) return fetched;

    const count = await git(["rev-list", "--count", "HEAD..@{u}"], repoDir);
    if (!count.ok) return count;

    const head = await git(["rev-parse", "HEAD"], repoDir);
    if (!head.ok) return head;

    return { ok: true, value: { behind: Number(count.value) > 0, localHash: head.value } };
}

/**
 * Remove an installed plugin directory.
 *
 * Validates the name FIRST and bails before any filesystem call, so a
 * traversal attempt like `../evil` can never reach `fs.rm`.
 */
export async function removePlugin(_event: IpcMainInvokeEvent, repoName: string): Promise<GitResult> {
    if (!validateRepoName(repoName)) return invalid(repoName);

    const target = join(userpluginsDir(), repoName);
    try {
        await rm(target, { recursive: true, force: true });
        return { ok: true, value: target };
    } catch (error: any) {
        return { ok: false, message: error?.message || "failed to remove plugin", error };
    }
}

/**
 * Resolve the plugin's REAL internal name from its `definePlugin({name})` on disk,
 * so the store enables it by the key Vencord's registry uses — not the GitHub UI
 * displayName. Returns null if the name is invalid, no entry file exists, or on error.
 */
export async function parseInstalledPluginName(_event: IpcMainInvokeEvent, repoName: string): Promise<string | null> {
    if (!validateRepoName(repoName)) return null;

    const dir = join(userpluginsDir(), repoName);
    for (const entry of ["index.tsx", "index.ts"]) {
        try {
            const contents = await readFile(join(dir, entry), "utf8");
            const meta = parseDefinePluginMeta(contents);
            return meta.name ?? null;
        } catch {
            // Entry file missing or unreadable; try the next candidate.
        }
    }
    return null;
}

/** Whether the cloned plugin's package.json declares runtime dependencies. */
export async function declaresDepsLocal(_event: IpcMainInvokeEvent, repoName: string): Promise<boolean> {
    if (!validateRepoName(repoName)) return false;

    try {
        const json = await readFile(join(userpluginsDir(), repoName, "package.json"), "utf8");
        return parsePackageJsonDeps(json);
    } catch {
        return false;
    }
}

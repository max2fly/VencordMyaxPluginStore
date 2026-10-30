/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile as cpExecFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { GitResult } from "../types";

const execFile = promisify(cpExecFile);

/** Repo directory names we accept: no separators, no traversal, no empties. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * True only for a plain directory name (letters, digits, `.`, `_`, `-`).
 * Rejects `.`/`..`, slashes, backslashes, absolute paths and the empty string,
 * so a caller-supplied name can never escape the userplugins directory.
 */
export function validateRepoName(name: string): boolean {
    return REPO_NAME_RE.test(name) && name !== "." && name !== "..";
}

/** A Flatpak-sandboxed Discord needs git run on the host via `flatpak-spawn`. */
function isFlatpak(): boolean {
    return process.platform === "linux" && /discord/i.test(process.env.FLATPAK_ID ?? "");
}

/**
 * Run git in `cwd` with an argument array and NO shell. Passing the args as an
 * array with `execFile` (never a single string through a shell) means a value
 * like a repo name or URL is handed to git verbatim and cannot inject shell
 * metacharacters — this is the key hardening over MLE's `shell:true` helper.
 */
export async function git(args: string[], cwd: string): Promise<GitResult> {
    // macOS GUI apps launch with a minimal PATH that often omits Homebrew's git.
    if (process.platform === "darwin" && !(process.env.PATH ?? "").split(":").includes("/usr/local/bin")) {
        process.env.PATH = `/usr/local/bin:${process.env.PATH ?? ""}`;
    }

    try {
        const result = isFlatpak()
            ? await execFile("flatpak-spawn", ["--host", "git", ...args], { cwd })
            : await execFile("git", args, { cwd });

        return { ok: true, value: result.stdout.trim() };
    } catch (error: any) {
        return { ok: false, message: (error?.stderr || error?.message) || "git command failed", error };
    }
}

/**
 * Absolute path to Vencord's `src/userplugins` root.
 *
 * Mirrors MLE's `join(__dirname, "..", "src", "userplugins")`: at runtime this
 * native module is bundled a level above the Vencord source tree, so one `..`
 * reaches the repo root. The exact runtime path is verified in the Task 7
 * end-to-end manual checklist, not by unit tests.
 */
export function userpluginsDir(): string {
    return join(__dirname, "..", "src", "userplugins");
}

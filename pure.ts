/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { compatibility } from "./platform";
import type { HostKind, InstallState, Platform, PluginEntry } from "./types";

export const DEPS_REASON = "Needs manual install (has dependencies)";

/** The store's own internal `definePlugin({ name })` — see index.tsx. */
export const SELF_PLUGIN_NAME = "MyaxPluginStore";

// ──────────────────────────────── error model ─────────────────────────────────

/** The auto-fix a classified error can offer. */
export type FixKind = "stash-pull" | "recreate-dir";

/**
 * A surfaced store error. `message` is always the raw underlying message (never
 * lost); `fix`, when present, is run from the error notification's onClick (via
 * `runFix` in ./store).
 */
export interface StoreError {
    message: string;
    fix?: { kind: FixKind; description: string; repoName?: string; };
}

// git prints these (case-insensitively) when a fast-forward pull collides with
// local work; the safe fix is to stash the local changes and pull.
const COLLISION_PATTERNS = [
    "would be overwritten",
    "local changes",
    "not possible to fast-forward",
    "divergent",
    "need to specify how to reconcile",
    "unstaged changes"
];

// A missing working tree / userplugins directory surfaces as one of these; the
// fix is to recreate the directory.
const MISSING_DIR_PATTERNS = ["enoent", "no such file or directory"];

/**
 * Classify a raw git/native error message into a `StoreError`, attaching an
 * auto-fix when the message matches a known-recoverable pattern. Pure: no I/O, no
 * Vencord globals. The raw `message` is always preserved so the UI can show it.
 */
export function classifyGitError(message: string, repoName?: string): StoreError {
    const lower = message.toLowerCase();

    if (COLLISION_PATTERNS.some(p => lower.includes(p))) {
        return {
            message,
            fix: {
                kind: "stash-pull",
                description: "Stash your local changes to this plugin and pull the update (your changes are saved to git stash, not deleted).",
                repoName
            }
        };
    }

    if (MISSING_DIR_PATTERNS.some(p => lower.includes(p))) {
        return {
            message,
            fix: { kind: "recreate-dir", description: "Recreate the userplugins folder." }
        };
    }

    return { message };
}

/**
 * Order the plugins an update-all should pull: the behind plugins first, then the
 * store's own entry LAST (only when the caller opts to include it, the store is
 * actually behind, and we have its entry). Pure, so the store-last rule is testable.
 */
export function buildUpdateSequence(
    behind: PluginEntry[],
    includeStore: boolean,
    storeBehind: boolean,
    selfEntry: PluginEntry | null
): PluginEntry[] {
    const sequence = [...behind];
    if (includeStore && storeBehind && selfEntry) sequence.push(selfEntry);
    return sequence;
}

/**
 * Drop the store's own entry from the catalog so it never lists (or offers to
 * update) itself. Matched by the real internal plugin name, not the repo name.
 */
export function excludeSelf(entries: PluginEntry[]): PluginEntry[] {
    return entries.filter(e => e.pluginName !== SELF_PLUGIN_NAME);
}

/**
 * Derive the per-plugin install state shown in the catalog.
 *
 * Incompatible when the host/OS requirements fail OR the plugin declares runtime
 * dependencies (those must be installed by hand). Otherwise installed (carrying
 * whether an update is available) when its working copy is present, else
 * not-installed. Keyed by `repoName` — the on-disk directory name.
 */
export function computeStates(
    entries: PluginEntry[],
    installed: string[],
    statuses: Map<string, { behind: boolean; }>,
    host: HostKind,
    platform: Platform
): Map<string, InstallState> {
    const states = new Map<string, InstallState>();

    for (const entry of entries) {
        const compat = compatibility(entry.reqs, host, platform);
        if (!compat.ok) {
            // Platform-incompatible: still installable behind a warning confirm.
            states.set(entry.repoName, { kind: "incompatible", reason: compat.reason, installable: true });
        } else if (entry.declaresDeps) {
            // Declares runtime npm deps: must be installed by hand — stays disabled.
            states.set(entry.repoName, { kind: "incompatible", reason: DEPS_REASON, installable: false });
        } else if (installed.includes(entry.repoName)) {
            states.set(entry.repoName, {
                kind: "installed",
                updateAvailable: statuses.get(entry.repoName)?.behind ?? false
            });
        } else {
            states.set(entry.repoName, { kind: "not-installed" });
        }
    }

    return states;
}

/**
 * Return a copy of `states` with every repo in `repoNames` that is currently
 * `installed` marked as up to date (`updateAvailable:false`). Repos that aren't
 * installed (or absent) are left untouched. Pure, so the snapshot-freshening that
 * kills the post-update "needs an update" flash (increment 5.E) is unit-testable.
 */
export function markUpdated(
    states: Map<string, InstallState>,
    repoNames: string[]
): Map<string, InstallState> {
    const next = new Map(states);
    for (const repoName of repoNames) {
        const state = next.get(repoName);
        if (state?.kind === "installed") next.set(repoName, { kind: "installed", updateAvailable: false });
    }
    return next;
}

/**
 * Resolve a plugin's declared prerequisites against the catalog and what's already
 * present. Pure: `isPresent` and `catalog` are injected so this is unit-testable
 * (call site passes `name => name in Vencord.Plugins.plugins` and the cached catalog).
 *
 * For each required plugin NAME: if already present (built-in Vencord API plugin or
 * already installed) it's satisfied and skipped; else if a catalog entry declares that
 * `pluginName` it's queued for install (deduped by repo); else it's unknown to the store
 * and the user must install it manually.
 */
export function resolvePrereqs(
    entry: PluginEntry,
    catalog: PluginEntry[],
    isPresent: (name: string) => boolean
): { toInstall: PluginEntry[]; missingUnknown: string[]; } {
    const toInstall: PluginEntry[] = [];
    const missingUnknown: string[] = [];
    const seenRepos = new Set<string>();

    for (const name of entry.requires) {
        if (isPresent(name)) continue;

        const match = catalog.find(c => c.pluginName === name);
        if (match) {
            if (!seenRepos.has(match.repo)) {
                seenRepos.add(match.repo);
                toInstall.push(match);
            }
        } else {
            missingUnknown.push(name);
        }
    }

    return { toInstall, missingUnknown };
}

/**
 * Reapply the stored enable for every pending plugin that is now known to Vencord
 * (i.e. has been loaded by the preceding restart). Returns the plugin names that
 * were reconciled so the caller can prune them from the pending list.
 */
export function reconcilePendingEnables(
    pending: { repoName: string; pluginName: string; }[],
    isKnown: (name: string) => boolean,
    setEnabled: (name: string, v: boolean) => void
): string[] {
    const reconciled: string[] = [];

    for (const { pluginName } of pending) {
        if (isKnown(pluginName)) {
            setEnabled(pluginName, true);
            reconciled.push(pluginName);
        }
    }

    return reconciled;
}

/**
 * Decide what the startup update check should do. Generic over the entry shape so
 * it serves both full `PluginEntry` catalogs and the leaner stored managed records.
 */
export function planUpdateCheck<T>(
    outdated: T[],
    autoUpdate: boolean
):
    | { action: "none"; }
    | { action: "notify"; count: number; }
    | { action: "auto"; entries: T[]; } {
    if (outdated.length === 0) return { action: "none" };
    if (autoUpdate) return { action: "auto", entries: outdated };
    return { action: "notify", count: outdated.length };
}

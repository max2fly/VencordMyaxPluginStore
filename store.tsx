/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Text } from "@components/Text";
import { relaunch } from "@utils/native";
import { Alerts, SettingsRouter } from "@webpack/common";

import { fetchAuthorRepos, fetchPluginMeta, filterPluginRepos, repoToEntry } from "./github";
import { fetchRecommended, mergeCatalog } from "./manifest";
import { Native } from "./nativeClient";
import { currentHost } from "./platform";
import { buildUpdateSequence, classifyGitError, computeStates, excludeSelf, markUpdated, planUpdateCheck, resolvePrereqs, SELF_PLUGIN_NAME } from "./pure";
import type { StoreError } from "./pure";
import { settings } from "./settings";
import type { GitResult, InstallState, PluginEntry } from "./types";

// The three pure functions live in ./pure (which imports only ./types and
// ./platform, both free of Vencord globals) so they can be unit-tested without
// evaluating this module's Vencord-coupled imports. Re-exported here so existing
// consumers can keep importing them from ./store.
export { computeStates, planUpdateCheck, reconcilePendingEnables, resolvePrereqs } from "./pure";
export type { FixKind, StoreError } from "./pure";
export { currentHost };

/**
 * Result of a store action. Actions no longer pop an error Alert on a native
 * failure; they RETURN the classified error so the caller can surface it via
 * `notifyError` — a Vencord notification whose click runs the fix (visible even when
 * the store tab is closed). A user-cancelled confirm is a no-op success, not an error.
 */
export type OpResult = { ok: true; } | { ok: false; error: StoreError; };

// The entry that drives a fix action: StoreError.fix made non-optional.
type StoreFix = NonNullable<StoreError["fix"]>;

// How long to wait before silently retrying a failed catalog LOAD (GitHub outage /
// 5xx / rate-limit). Exported so StoreTab's open-tab retry shares one source of truth.
export const CATALOG_RETRY_MS = 5 * 60 * 1000;

// ──────────────────────────── launch-prime module state ───────────────────────
// The store's own catalog entry, captured in buildCatalog BEFORE excludeSelf drops
// it, so update-all can self-update the store LAST. null until the first build.
let selfEntry: PluginEntry | null = null;
// Whether the store's own checkout is behind upstream (from getStoreUpdate).
let storeBehind = false;
// The ready catalog snapshot computed at launch priming, so StoreTab can open
// instantly instead of re-running the whole load. null until primeStore runs.
let snapshot: { entries: PluginEntry[]; states: Map<string, InstallState>; } | null = null;
// Whether the one-time launch auto-update/notify has already run. Set once the first
// SUCCESSFUL prime completes; guards both a still-queued catalog retry and a race with
// StoreTab populating the snapshot from re-running the launch auto-update twice.
let launchCheckDone = false;

/** The ready snapshot computed at launch, or null if priming hasn't finished. */
export function getSnapshot(): { entries: PluginEntry[]; states: Map<string, InstallState>; } | null {
    return snapshot;
}

/** Whether the store's own checkout was behind upstream at the last check. */
export function getStoreBehind(): boolean {
    return storeBehind;
}

// ──────────────────────────── impure orchestration ────────────────────────────
// Not unit-tested; integration-verified by the Task 7 checklist.

/**
 * Enable (or disable) a plugin by name, creating its settings entry first if the
 * plugin isn't in the registry yet — the de-risk for the "enabled after one
 * restart" guarantee. Pattern from src/plugins/consoleShortcuts/index.ts.
 */
export function setPluginEnabled(name: string, v: boolean): void {
    (Vencord.Settings.plugins[name] ??= { enabled: v }).enabled = v;
}

// The expensive GitHub catalog (author repos + per-repo raw metadata + recommended)
// is cached for the session. Post-op reloads reuse it; only local listInstalled/
// getStatus recompute, so install/update/uninstall still reflect immediately. The
// Refresh button forces a refetch (force = true), which invalidates on success.
let catalogCache: PluginEntry[] | null = null;

/**
 * Build the full catalog: author repos (enriched) merged with the recommended
 * manifest. Cached per session; `force` refetches and replaces the cache. A failed
 * fetch is never cached, so the next call retries.
 */
export async function buildCatalog(force = false): Promise<GitResult<PluginEntry[]>> {
    if (!force && catalogCache) return { ok: true, value: catalogCache };

    const repos = await fetchAuthorRepos();
    if (!repos.ok) return repos;

    const author: PluginEntry[] = [];
    for (const repo of filterPluginRepos(repos.value)) {
        const meta = await fetchPluginMeta(repo);
        author.push(repoToEntry(repo, meta));
    }

    const recommended = await fetchRecommended();
    const merged = mergeCatalog(author, recommended);
    // Capture the store's own entry BEFORE excludeSelf drops it, so update-all can
    // self-update the store last. Matched by the real internal plugin name.
    selfEntry = merged.find(e => e.pluginName === SELF_PLUGIN_NAME) ?? null;
    // Drop the store's own repo (if it carries the vencord-plugin topic) before
    // caching, so the cached catalog already excludes it everywhere.
    const entries = excludeSelf(merged);
    catalogCache = entries;
    return { ok: true, value: entries };
}

/**
 * Rebuild Vencord and offer to relaunch. On build failure show an error card and
 * stop; on success prompt to restart now.
 */
export async function rebuildAndRestart(successBody: string): Promise<void> {
    const res = await VencordNative.updater.rebuild();
    if (!res.ok) {
        Alerts.show({
            title: "Rebuild failed",
            body: "Couldn't rebuild Vencord. Check the console for details, then try again.",
            confirmText: "Okay"
        });
        return;
    }

    Alerts.show({
        title: "Restart required",
        body: successBody,
        confirmText: "Restart now",
        cancelText: "Later",
        onConfirm: relaunch
    });
}

/**
 * Clone a single plugin, resolve its REAL internal definePlugin({name}) from disk —
 * the key Vencord's registry uses (the GitHub displayName is only a fallback, never
 * the enable key) — record it as managed + pending-enable, and enable it immediately.
 * Does NOT rebuild; the caller rebuilds once for the whole batch.
 */
async function cloneAndRecord(entry: PluginEntry): Promise<GitResult<void>> {
    const res = await Native.clonePlugin(entry.cloneUrl, entry.repoName);
    if (!res.ok) return res;

    const parsed = await Native.parseInstalledPluginName(entry.repoName);
    const pluginName = parsed ?? entry.displayName;

    settings.store.managed = [
        ...settings.store.managed,
        { repo: entry.repo, repoName: entry.repoName, pluginName }
    ];
    settings.store.pendingEnable = [
        ...settings.store.pendingEnable,
        { repoName: entry.repoName, pluginName }
    ];
    setPluginEnabled(pluginName, true);

    return { ok: true, value: undefined };
}

/**
 * Install a plugin, resolving its declared prerequisites from the cached catalog.
 * When there's anything to warn about — a platform-incompatibility reason, prereqs
 * that will be installed too, or prereqs the store doesn't know — a single
 * confirmation dialog gathers all of it. A compatible, prereq-free install proceeds
 * one-click with NO dialog. On confirm, every prereq then the entry itself is cloned
 * + enabled, followed by a SINGLE rebuild.
 */
export async function install(entry: PluginEntry, opts?: { incompatibleReason?: string; }): Promise<OpResult> {
    // Use the cached catalog (cheap) + Vencord's live plugin registry to resolve
    // which prereqs are already present vs. must be installed vs. unknown.
    const cat = await buildCatalog();
    const catalog = cat.ok ? cat.value : [];
    const { toInstall, missingUnknown } = resolvePrereqs(
        entry,
        catalog,
        name => name in Vencord.Plugins.plugins
    );

    const proceed = async (): Promise<OpResult> => {
        for (const prereq of [...toInstall, entry]) {
            const res = await cloneAndRecord(prereq);
            if (!res.ok) return { ok: false, error: classifyGitError(res.message, prereq.repoName) };
        }
        await rebuildAndRestart("A new plugin was installed. Restart to finish enabling it.");
        return { ok: true };
    };

    const hasPrereqs = toInstall.length > 0;
    const needsWarning = opts?.incompatibleReason !== undefined || hasPrereqs || missingUnknown.length > 0;
    if (!needsWarning) return proceed();

    const lines: string[] = [];
    if (opts?.incompatibleReason)
        lines.push(`This plugin is marked incompatible: ${opts.incompatibleReason}. Install anyway?`);
    if (hasPrereqs)
        lines.push(`\`${entry.displayName}\` also needs: ${toInstall.map(p => `\`${p.displayName}\``).join(", ")}, which will be installed too.`);
    if (missingUnknown.length > 0)
        lines.push(`Requires ${missingUnknown.map(n => `\`${n}\``).join(", ")}, which isn't in this store — install it manually.`);

    // Resolve only once the operation (or a cancel/dismiss) finishes, so the caller's
    // post-op reload + busy indicator track the real work rather than the dialog open.
    // A cancel/dismiss is a no-op success — not an error.
    return new Promise<OpResult>(resolve => {
        let proceeding = false;
        Alerts.show({
            title: `Install ${entry.displayName}?`,
            // Render each part as its own paragraph: a plain string with "\n\n"
            // collapses to a single run of text in a React node, so the separate
            // warnings would otherwise jam together on one line.
            body: (
                <>
                    {lines.map((line, i) => (
                        <Text key={i} tag="p">{line}</Text>
                    ))}
                </>
            ),
            confirmText: hasPrereqs ? "Install all" : "Install",
            cancelText: "Cancel",
            onConfirm: () => { proceeding = true; void proceed().then(resolve); },
            onCancel: () => resolve({ ok: true }),
            onCloseCallback: () => { if (!proceeding) resolve({ ok: true }); }
        });
    });
}

/**
 * Options for pullThenRebuild's completion step. `body` is the restart-prompt text.
 * In the default (`notify` falsy) path a successful batch rebuilds and pops the
 * Alerts restart prompt (manual update / update-all). With `notify:true` it rebuilds
 * and instead fires a single "auto-updated" notification whose click relaunches —
 * used by the launch auto-update so a background (store-closed) update doesn't try to
 * pop a modal. `names` are the display names shown in that notification.
 */
interface RebuildMode {
    body: string;
    notify?: boolean;
    names?: string[];
}

/**
 * Pull a sequence of repos in order, then rebuild + surface the restart ONCE for the
 * whole batch. Stops on the FIRST failure, returning its classified error (repos
 * already pulled stay pulled). Only rebuilds when at least one repo was pulled. On a
 * fully-successful batch it also freshens the launch snapshot in place (increment
 * 5.E) so reopening the tab shows the updated repos as up to date with no stale flash.
 * Shared by update(entry) (single repo) and updateAll (many).
 */
async function pullThenRebuild(repoNames: string[], mode: RebuildMode): Promise<OpResult> {
    let pulled = 0;
    for (const repoName of repoNames) {
        const res = await Native.pullPlugin(repoName);
        if (!res.ok) return { ok: false, error: classifyGitError(res.message, repoName) };
        pulled++;
    }

    if (pulled > 0) {
        freshenSnapshot(repoNames);
        if (mode.notify) {
            // Launch/background path: rebuild silently, then one toast whose click
            // relaunches — no modal (the store tab may well be closed).
            const res = await VencordNative.updater.rebuild();
            if (!res.ok) {
                notifyError({ message: "Couldn't rebuild Vencord after auto-update. Open the console for details, then update manually." });
            } else {
                showNotification({
                    title: "Plugin Store",
                    body: `Auto-updated: ${(mode.names ?? []).join(", ")}. Click to restart and apply.`,
                    onClick: relaunch
                });
            }
        } else {
            await rebuildAndRestart(mode.body);
        }
    }
    return { ok: true };
}

/**
 * Freshen the launch snapshot after a successful pull so a reopened tab shows the
 * pulled repos as up to date immediately (no ~2s "needs an update" flash before the
 * background reload recomputes). Marks each pulled installed repo updateAvailable:false
 * and clears storeBehind if the store's own repo was in the pulled set. (increment 5.E)
 */
function freshenSnapshot(repoNames: string[]): void {
    if (snapshot) snapshot = { entries: snapshot.entries, states: markUpdated(snapshot.states, repoNames) };
    if (selfEntry && repoNames.includes(selfEntry.repoName)) storeBehind = false;
}

/** Fast-forward a single installed plugin, then rebuild + offer restart. */
export async function update(entry: PluginEntry): Promise<OpResult> {
    return pullThenRebuild([entry.repoName], { body: "A plugin was updated. Restart to apply the changes." });
}

/**
 * Check whether the store's OWN checkout is behind upstream, caching the result in
 * the module `storeBehind` (read back via getStoreBehind). Requires buildCatalog to
 * have run at least once so selfEntry is captured; if the store isn't a git checkout
 * getStatus fails and we report not-behind.
 */
export async function getStoreUpdate(): Promise<boolean> {
    if (!selfEntry) {
        storeBehind = false;
        return false;
    }

    const status = await Native.getStatus(selfEntry.repoName);
    storeBehind = status.ok && status.value.behind;
    return storeBehind;
}

/**
 * Update every behind plugin, then (if includeStore && the store is behind) the
 * store itself LAST, as a single sequential batch with ONE restart prompt at the
 * end. Stops on the first failure and returns its classified error. A no-op (empty
 * sequence) returns ok with no rebuild.
 */
export async function updateAll(behind: PluginEntry[], includeStore: boolean, opts: { notify?: boolean; } = {}): Promise<OpResult> {
    const sequence = buildUpdateSequence(behind, includeStore, storeBehind, selfEntry);
    return pullThenRebuild(sequence.map(e => e.repoName), {
        body: "Plugins were updated. Restart to apply the changes.",
        notify: opts.notify,
        names: sequence.map(e => e.displayName)
    });
}

/** Update only the store itself (store updated last via updateAll). */
export async function updateStore(): Promise<OpResult> {
    return updateAll([], true);
}

/**
 * Run a classified error's auto-fix. `recreate-dir` recreates the userplugins
 * folder; `stash-pull` stashes the plugin's local changes (preserved in git stash)
 * and pulls, then rebuilds + offers restart on success. Returns an OpResult,
 * classifying any native failure.
 */
export async function applyFix(fix: StoreFix): Promise<OpResult> {
    if (fix.kind === "recreate-dir") {
        const res = await Native.ensureUserpluginsDir();
        return res.ok ? { ok: true } : { ok: false, error: classifyGitError(res.message) };
    }

    // stash-pull
    if (!fix.repoName)
        return { ok: false, error: { message: "Can't apply this fix: no plugin was specified." } };

    const res = await Native.stashAndPull(fix.repoName);
    if (!res.ok) return { ok: false, error: classifyGitError(res.message, fix.repoName) };

    await rebuildAndRestart("Your local changes were stashed and the plugin was updated. Restart to apply the changes.");
    return { ok: true };
}

/**
 * Surface a store error as a Vencord notification. Replaces the old in-store banner,
 * so op/launch/refresh/cold-load failures are visible even when the tab is closed and
 * nothing can hang stale (the error is a one-shot toast, not retained UI state). A
 * fixable error invites the fix on click; otherwise the click opens the store.
 */
export function notifyError(error: StoreError): void {
    showNotification({
        title: "Plugin Store",
        body: error.fix ? `${error.message} — click to fix` : error.message,
        onClick: () => (error.fix ? void runFix(error) : openStoreTab())
    });
}

/**
 * Run a fixable error's auto-fix from a notification click. `stash-pull` first
 * confirms (it moves local changes to git stash) then applies; `recreate-dir` applies
 * immediately. Each outcome produces a follow-up notification (applyFix itself does
 * the native fix and, for stash-pull, the rebuild + restart prompt).
 */
export async function runFix(error: StoreError): Promise<void> {
    if (!error.fix) return;
    const fix = error.fix;

    if (fix.kind === "stash-pull") {
        Alerts.show({
            title: "Stash local changes?",
            body: "This stashes your local changes to the plugin (saved to git stash, not deleted) and pulls the update. Continue?",
            confirmText: "Stash & update",
            cancelText: "Cancel",
            // applyFix rebuilds + pops its own "Restart required" modal on success, so
            // that modal is the sole success signal here — a toast would double up (and
            // "Restarting…" would lie if the user picks "Later"). Only surface failure.
            onConfirm: () => void applyFix(fix).then(result => {
                if (!result.ok) notifyError(result.error);
            })
        });
        return;
    }

    // recreate-dir: apply immediately, no confirm.
    const result = await applyFix(fix);
    if (result.ok) showNotification({ title: "Plugin Store", body: "Recreated the userplugins folder — try the install again." });
    else notifyError(result.error);
}

/**
 * Confirm, then remove the working copy FIRST, then disable + drop from managed only
 * on success, then rebuild + offer restart. The post-confirm order is unchanged.
 */
export async function uninstall(entry: PluginEntry): Promise<OpResult> {
    const proceed = async (): Promise<OpResult> => {
        // Do the fallible filesystem op before touching persisted state: a failed
        // remove must not desync managed/enabled from what's actually on disk.
        const res = await Native.removePlugin(entry.repoName);
        if (!res.ok) return { ok: false, error: classifyGitError(res.message, entry.repoName) };

        // Disable by the real stored plugin name, not the UI displayName.
        const managedEntry = settings.store.managed.find(m => m.repoName === entry.repoName);
        const pluginName = managedEntry?.pluginName ?? entry.displayName;
        setPluginEnabled(pluginName, false);
        settings.store.managed = settings.store.managed.filter(m => m.repoName !== entry.repoName);

        await rebuildAndRestart("A plugin was removed. Restart to apply the changes.");
        return { ok: true };
    };

    // Resolve only once the operation (or a cancel/dismiss) finishes, so the caller's
    // post-op reload + busy indicator track the real work rather than the dialog open.
    // A cancel/dismiss is a no-op success — not an error.
    return new Promise<OpResult>(resolve => {
        let proceeding = false;
        Alerts.show({
            title: `Uninstall ${entry.displayName}?`,
            body: "This removes the plugin and rebuilds Vencord.",
            confirmText: "Uninstall",
            cancelText: "Cancel",
            onConfirm: () => { proceeding = true; void proceed().then(resolve); },
            onCancel: () => resolve({ ok: true }),
            onCloseCallback: () => { if (!proceeding) resolve({ ok: true }); }
        });
    });
}

/**
 * Best-effort open of the store's settings section. The store registers that
 * section in Task 6/7; until its key is wired here this falls back to opening
 * Vencord settings. Integration-verified in Task 7 — kept deliberately simple.
 */
export function openStoreTab(): void {
    try {
        SettingsRouter.openUserSettings();
    } catch {
        // no-op: integration-verified in Task 7
    }
}

/**
 * Startup update check. Desktop-only. Fetches status for each managed plugin,
 * collects the ones behind their upstream, then either auto-updates them (one
 * rebuild for the batch — never per plugin), notifies, or does nothing.
 */
export async function checkForUpdatesAndNotify(): Promise<void> {
    if (IS_WEB) return;

    const outdated: typeof settings.store.managed = [];
    for (const managed of settings.store.managed) {
        const status = await Native.getStatus(managed.repoName);
        if (status.ok && status.value.behind) outdated.push(managed);
    }

    const plan = planUpdateCheck(outdated, settings.store.autoUpdate);
    if (plan.action === "notify") {
        showNotification({
            title: "Plugin updates available",
            body: `${plan.count} plugin(s) can be updated`,
            onClick: openStoreTab
        });
    } else if (plan.action === "auto") {
        // Pull each behind plugin, then rebuild ONCE for the whole batch — calling
        // the full update() per plugin would rebuild (and prompt) repeatedly.
        for (const managed of plan.entries) {
            const res = await Native.pullPlugin(managed.repoName);
            if (!res.ok)
                console.warn(`[MyaxPluginStore] auto-update: failed to pull ${managed.repoName}: ${res.message}`);
        }
        await rebuildAndRestart("Installed plugins were updated. Restart to apply the changes.");
    }
}

/**
 * Launch priming. Desktop-only. Computes the full ready snapshot exactly like
 * StoreTab's loadCatalog (buildCatalog → listInstalled/getPlatform/currentHost →
 * per-installed getStatus → computeStates) into the module `snapshot` so the tab
 * opens instantly, and records whether the store itself is behind (`storeBehind`).
 *
 * Then, if autoUpdate is on, it auto-updates the INSTALLED behind plugins (NOT the
 * store — the store self-update stays user-initiated); success fires an "auto-updated"
 * restart notification and any failure a notifyError, WITHOUT throwing. If autoUpdate
 * is off it keeps the existing notify behavior.
 */
export async function primeStore(): Promise<void> {
    if (IS_WEB) return;
    // The launch auto-update/notify must run at most once. A still-queued retry (or a
    // StoreTab reload that already primed the snapshot) must not re-run it.
    if (launchCheckDone) return;

    const cat = await buildCatalog();
    if (!cat.ok) {
        // Catalog build failed (GitHub outage / 5xx / rate-limit). Leave the snapshot
        // null and SILENTLY retry in 5 minutes so the store self-heals when the outage
        // ends — no toast (launch-time noise the user can't act on yet) and no
        // launchCheckDone, so the retry keeps going until a load actually succeeds.
        setTimeout(() => void primeStore(), CATALOG_RETRY_MS);
        return;
    }

    const entries = cat.value;
    const installed = await Native.listInstalled();
    const platform = await Native.getPlatform();
    const host = currentHost();

    const statuses = new Map<string, { behind: boolean; }>();
    for (const entry of entries) {
        if (!installed.includes(entry.repoName)) continue;
        const status = await Native.getStatus(entry.repoName);
        if (status.ok) statuses.set(entry.repoName, { behind: status.value.behind });
    }

    const states = computeStates(entries, installed, statuses, host, platform);
    snapshot = { entries, states };

    // Cache whether the store itself is behind (drives the Pass-2 store-update banner).
    await getStoreUpdate();

    if (settings.store.autoUpdate) {
        const behind = entries.filter(e => {
            const state = states.get(e.repoName);
            return state?.kind === "installed" && state.updateAvailable;
        });
        // Store NOT included on launch: don't auto-replace the store itself. notify:true
        // so a successful background update pops the "auto-updated" restart toast (and a
        // failure a notifyError) instead of a modal the user may never see.
        const result = await updateAll(behind, false, { notify: true });
        if (!result.ok) notifyError(result.error);
    } else {
        // Not auto-updating: keep the existing notify-on-launch behavior.
        await checkForUpdatesAndNotify();
    }

    // Launch check succeeded: mark it done so a queued retry (or a StoreTab reload that
    // raced ahead) won't re-run the one-time launch auto-update/notify.
    launchCheckDone = true;
}

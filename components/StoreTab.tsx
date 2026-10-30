/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "../styles.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { Switch } from "@components/Switch";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { TextInput, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { Native } from "../nativeClient";
import { currentHost } from "../platform";
import { settings } from "../settings";
import {
    buildCatalog,
    CATALOG_RETRY_MS,
    computeStates,
    getSnapshot,
    getStoreBehind,
    getStoreUpdate,
    install,
    notifyError,
    type OpResult,
    type StoreError,
    uninstall,
    update,
    updateAll,
    updateStore
} from "../store";
import type { InstallState, PluginEntry } from "../types";
import { StoreCard } from "./StoreCard";

const cl = classNameFactory("vc-myax-");
const logger = new Logger("MyaxPluginStore", "#a6d189");

interface Loaded {
    entries: PluginEntry[];
    states: Map<string, InstallState>;
}

type LoadState =
    | { status: "loading"; }
    | { status: "error"; error: StoreError; }
    | { status: "ready"; data: Loaded; };

/** Fetch the catalog, compute per-plugin install states. Desktop-only; never called on web. */
async function loadCatalog(force = false): Promise<LoadState> {
    const cat = await buildCatalog(force);
    // buildCatalog only yields a message string; a cold/refresh load carries no
    // auto-fix (fixes are only attached to op failures), so wrap it as a plain StoreError.
    if (!cat.ok) return { status: "error", error: { message: cat.message } };

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
    return { status: "ready", data: { entries, states } };
}

function Group({
    title,
    entries,
    states,
    search,
    onInstall,
    onUpdate,
    onUninstall
}: {
    title: string;
    entries: PluginEntry[];
    states: Map<string, InstallState>;
    search: string;
    onInstall(entry: PluginEntry, incompatibleReason?: string): void;
    onUpdate(entry: PluginEntry): void;
    onUninstall(entry: PluginEntry): void;
}) {
    const q = search.toLowerCase();
    const matching = q
        ? entries.filter(e =>
            e.displayName.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q))
        : entries;

    return (
        <>
            <Heading tag="h4" className={classes(Margins.top20, Margins.bottom8)}>{title}</Heading>
            {matching.length
                ? (
                    <div className="vc-plugins-grid">
                        {matching.map(entry => {
                            const state = states.get(entry.repoName) ?? { kind: "not-installed" };
                            // Carry the reason only for an installable-incompatible entry, so
                            // install() raises the single warning+prereq confirmation dialog.
                            const reason = state.kind === "incompatible" && state.installable ? state.reason : undefined;
                            return (
                                <StoreCard
                                    key={entry.repoName}
                                    entry={entry}
                                    state={state}
                                    onInstall={() => onInstall(entry, reason)}
                                    onUpdate={() => onUpdate(entry)}
                                    onUninstall={() => onUninstall(entry)}
                                />
                            );
                        })}
                    </div>
                )
                : <Paragraph>No plugins here yet.</Paragraph>}
        </>
    );
}

function StoreTabInner() {
    // Instant open: seed from the launch-primed snapshot if priming already ran, so
    // the grid shows immediately; otherwise start on the loading screen. The useEffect
    // reload then refreshes non-destructively (keeps the grid when it was seeded).
    const [load, setLoad] = useState<LoadState>(() => {
        const snap = getSnapshot();
        return snap ? { status: "ready", data: snap } : { status: "loading" };
    });
    const [search, setSearch] = useState("");
    const [busy, setBusy] = useState<Map<string, InstallState>>(new Map());
    // A refresh/post-op reload that runs while ready data is already showing: the
    // grid stays rendered, this drives the "Refreshing…" indicator AND disables the
    // card actions, and a failure here surfaces as a notification (non-destructive:
    // the grid stays) instead of the error screen.
    const [refreshing, setRefreshing] = useState(false);
    // Tracks the non-per-entry ops (update-all/store). All op failures now surface as
    // Vencord notifications (notifyError), not retained in-store state.
    const [opInFlight, setOpInFlight] = useState(false);
    // Whether the store's own checkout is behind upstream. Seeded from the launch
    // check and refreshed after every successful reload.
    const [storeBehind, setStoreBehind] = useState(() => getStoreBehind());
    const { autoUpdate } = settings.use(["autoUpdate"]);

    // The memoized reload closes over `load` once; a ref gives it the *current*
    // load status so it can tell a cold first load (show the loading screen) from
    // a refresh over existing ready data (keep the grid) without a stale closure.
    const loadRef = useRef(load);
    loadRef.current = load;

    // Single-op gate. Mirrors opInFlight into a ref (synced each render, like loadRef)
    // so the op entry points can read the *current* flag without a stale closure and
    // refuse to start a second op — two ops both ending in rebuildAndRestart() would
    // otherwise fire concurrent VencordNative.updater.rebuild() calls.
    const opInFlightRef = useRef(opInFlight);
    opInFlightRef.current = opInFlight;

    // Pending silent catalog-load retry (GitHub outage). A failed load schedules a
    // reload(true) here instead of toasting; a successful load, a manual Retry, and
    // unmount all clear it so at most one retry is ever outstanding and none leaks
    // after the tab closes.
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Cached reload (force=false) for the initial load and post-op reloads: only the
    // local listInstalled/getStatus recompute, so install state reflects immediately
    // while the expensive GitHub catalog is reused. The Refresh/Retry buttons force
    // a refetch (force=true), which invalidates the cache.
    const reload = useCallback((force = false) => {
        // Prior ready data present → non-destructive refresh: keep the grid, show the
        // spinner. No prior data (cold open) → the full-screen loading state.
        const hadReady = loadRef.current.status === "ready";
        if (hadReady) setRefreshing(true);
        else setLoad({ status: "loading" });
        setBusy(new Map());

        const finish = (next: LoadState) => {
            // A catalog-LOAD failure is SILENT (no toast) and auto-retries every 5
            // minutes until it succeeds, so the store self-heals when a GitHub outage
            // ends. A failed refresh keeps the old grid (non-destructive); a failed cold
            // load swaps to the full-page error screen (which also shows the auto-retry
            // notice + a manual Retry).
            if (next.status === "error") {
                if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
                retryTimerRef.current = setTimeout(() => reload(true), CATALOG_RETRY_MS);
                if (!hadReady) setLoad(next);
            } else {
                // Loaded successfully: cancel any pending retry and show the grid.
                if (retryTimerRef.current) {
                    clearTimeout(retryTimerRef.current);
                    retryTimerRef.current = null;
                }
                setLoad(next);
            }
            setRefreshing(false);
            // Refresh the store-behind flag off the latest on-disk state.
            if (next.status === "ready") getStoreUpdate().then(setStoreBehind).catch(() => { });
        };

        loadCatalog(force).then(finish).catch(err => {
            logger.error("Failed to load catalog", err);
            finish({ status: "error", error: { message: String(err?.message ?? err) } });
        });
    }, []);

    useEffect(() => reload(), [reload]);

    // Cancel any pending silent retry when the tab unmounts, so no timer fires (and
    // calls reload on an unmounted component) after the store is closed.
    useEffect(() => () => {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    }, []);

    const runOp = useCallback(
        (entry: PluginEntry, op: Extract<InstallState, { kind: "busy"; }>["op"], action: (e: PluginEntry) => Promise<OpResult>) => {
            if (opInFlightRef.current) return;
            setOpInFlight(true);
            setBusy(prev => new Map(prev).set(entry.repoName, { kind: "busy", op }));
            // install/update/uninstall end by prompting a restart inside store.tsx; a
            // native failure comes back as { ok:false } → surface it as a notification
            // (fixable errors offer the fix on click). The post-op reload then reflects
            // the new on-disk state.
            action(entry)
                .then(result => { if (!result.ok) notifyError(result.error); })
                .catch(err => {
                    logger.error(`Failed to ${op} ${entry.repoName}`, err);
                    notifyError({ message: String(err?.message ?? err) });
                })
                .finally(() => { setOpInFlight(false); reload(); });
        },
        [reload]
    );

    // Run a store-wide op (update-all/update-store) that has no single entry: toggle
    // the in-flight flag, surface a failure as a notification, reload afterwards.
    const runStoreOp = useCallback((action: () => Promise<OpResult>) => {
        if (opInFlightRef.current) return;
        setOpInFlight(true);
        action()
            .then(result => { if (!result.ok) notifyError(result.error); })
            .catch(err => {
                logger.error("Store operation failed", err);
                notifyError({ message: String(err?.message ?? err) });
            })
            .finally(() => { setOpInFlight(false); reload(); });
    }, [reload]);

    const onInstall = useCallback(
        (e: PluginEntry, incompatibleReason?: string) =>
            runOp(e, "installing", incompatibleReason ? x => install(x, { incompatibleReason }) : install),
        [runOp]
    );
    const onUpdate = useCallback((e: PluginEntry) => runOp(e, "updating", update), [runOp]);
    const onUninstall = useCallback((e: PluginEntry) => runOp(e, "uninstalling", uninstall), [runOp]);

    if (load.status === "loading")
        return <Paragraph className={Margins.top16}>Loading the plugin store…</Paragraph>;

    if (load.status === "error") {
        // Whole catalog failed with no grid to fall back on: this is the page state
        // (not a hidden banner), so keep the full-page screen. Catalog-load failures are
        // SILENT (no toast) and auto-retry every 5 minutes from reload's finish, so the
        // store self-heals when a GitHub outage ends; the manual Retry stays for an
        // impatient user. Cold/refresh loads carry no auto-fix (fixes attach only to op
        // failures), so there's no fix button here.
        const onRetry = () => {
            // Clear the pending auto-retry so a manual Retry doesn't stack a second loop.
            if (retryTimerRef.current) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
            reload(true);
        };
        return (
            <div className={Margins.top16}>
                <Paragraph>Couldn't load the plugin store: {load.error.message}</Paragraph>
                <Paragraph>Retrying automatically every 5 minutes.</Paragraph>
                <div className={classes(cl("actions"), Margins.top8)}>
                    <Button onClick={onRetry}>Retry</Button>
                </div>
            </div>
        );
    }

    const { entries, states } = load.data;
    // Overlay busy states on the computed ones. While ANY op is in flight OR a refresh
    // is running, every card's action is disabled: a store-wide update has no single
    // `busy` entry, and a live Update button during the post-op/post-fix background
    // refresh would let the user start a second op and trigger a concurrent rebuild.
    // The acting entry keeps its real op label; the rest show a disabled placeholder.
    // The GRID stays rendered throughout (increment-3 non-destructive refresh) — only
    // the buttons go disabled.
    const effectiveStates = new Map(states);
    if (opInFlight || refreshing)
        for (const entry of entries) effectiveStates.set(entry.repoName, { kind: "busy", op: "updating" });
    for (const [repoName, state] of busy) effectiveStates.set(repoName, state);

    const authorEntries = entries.filter(e => e.source === "author");
    const recommendedEntries = entries.filter(e => e.source === "recommended");

    // Installed plugins that are behind upstream — the update-all targets.
    const behindEntries = entries.filter(e => {
        const st = states.get(e.repoName);
        return st?.kind === "installed" && st.updateAvailable;
    });
    // Any op/refresh in flight disables the toolbar + banner actions.
    const inFlight = refreshing || opInFlight || busy.size > 0;
    const canUpdateAll = behindEntries.length > 0 || storeBehind;

    return (
        <>
            {storeBehind && (
                <div className={cl("store-banner")}>
                    <Paragraph className={cl("store-banner-text")}>A Plugin Store update is available.</Paragraph>
                    <Button
                        variant="positive"
                        disabled={inFlight}
                        onClick={() => runStoreOp(updateStore)}
                    >
                        Update store
                    </Button>
                </div>
            )}

            <div className={cl("toolbar")}>
                <TextInput
                    inputClassName={cl("search")}
                    placeholder="Search plugins…"
                    value={search}
                    onChange={setSearch}
                />
                <Button
                    variant="secondary"
                    onClick={() => {
                        // Supersede any pending silent auto-retry so Refresh doesn't stack a second loop.
                        if (retryTimerRef.current) {
                            clearTimeout(retryTimerRef.current);
                            retryTimerRef.current = null;
                        }
                        reload(true);
                    }}
                    disabled={inFlight}
                >
                    {refreshing ? "Refreshing…" : "Refresh"}
                </Button>
                <Button
                    variant="positive"
                    onClick={() => runStoreOp(() => updateAll(behindEntries, storeBehind))}
                    disabled={inFlight || !canUpdateAll}
                >
                    Update all
                </Button>
                <label className={cl("autoupdate")}>
                    <Span size="md" weight="medium">Automatically update installed plugins</Span>
                    <Switch checked={autoUpdate} onChange={value => (settings.store.autoUpdate = value)} />
                </label>
            </div>

            <Group
                title="max2fly Plugins"
                entries={authorEntries}
                states={effectiveStates}
                search={search}
                onInstall={onInstall}
                onUpdate={onUpdate}
                onUninstall={onUninstall}
            />
            <Group
                title="Recommended"
                entries={recommendedEntries}
                states={effectiveStates}
                search={search}
                onInstall={onInstall}
                onUpdate={onUpdate}
                onUninstall={onUninstall}
            />
        </>
    );
}

export function StoreTab() {
    return (
        <ErrorBoundary>
            {IS_WEB
                ? (
                    <Paragraph className={Margins.top16}>
                        The Plugin Store needs the desktop app with a source install. It isn't
                        available on the web version of Discord.
                    </Paragraph>
                )
                : <StoreTabInner />}
        </ErrorBoundary>
    );
}

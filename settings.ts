/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

/** A plugin whose enable must be reapplied after the next restart loads it. */
export interface PendingEnable {
    repoName: string;
    pluginName: string;
}

/** A plugin this store installed; the persistent record that drives updates. */
export interface ManagedEntry {
    repo: string;
    repoName: string;
    pluginName: string;
}

export const settings = definePluginSettings({
    // Hidden flag (OptionType.CUSTOM so it stays off the settings cog); the
    // toggle lives on the store page itself. store.ts reads settings.store.autoUpdate.
    // Defaults ON: installed plugins auto-update on launch unless the user turns it off.
    autoUpdate: {
        type: OptionType.CUSTOM,
        default: true
    },
    // Hidden stored JSON state (OptionType.CUSTOM), the pattern used by
    // src/plugins/pinDms and src/plugins/textReplace. Transient: pruned once a
    // pending plugin has loaded and its enable has been reapplied.
    pendingEnable: {
        type: OptionType.CUSTOM,
        default: [] as PendingEnable[]
    },
    // Persistent record of every plugin the store installed; added on install,
    // removed on uninstall. Drives the startup update check.
    managed: {
        type: OptionType.CUSTOM,
        default: [] as ManagedEntry[]
    }
});

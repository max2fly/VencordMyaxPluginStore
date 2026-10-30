/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CloudDownloadIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { Logger } from "@utils/Logger";
import { removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";

import { StoreTab } from "./components/StoreTab";
import { settings } from "./settings";
import { primeStore, reconcilePendingEnables } from "./store";

const SECTION_KEY = "vencord_myax_store";

export default definePlugin({
    name: "MyaxPluginStore",
    description: "Browse and one-click install/update max2fly's Vencord plugins and recommended third-party ones.",
    authors: [{ name: "max2fly", id: 236950175480807424n }],
    settings,

    start() {
        SettingsPlugin.customEntries.push({
            key: SECTION_KEY,
            title: "Plugin Store",
            Component: StoreTab,
            Icon: CloudDownloadIcon
        });

        // Reapply the stored enable for any plugin this store installed before the
        // preceding restart, now that Vencord has loaded it, then drop the ones we
        // reconciled from the pending list (reassign so the settings proxy persists).
        const done = reconcilePendingEnables(
            settings.store.pendingEnable,
            name => name in Vencord.Plugins.plugins,
            (name, v) => { (Vencord.Settings.plugins[name] ??= { enabled: v }).enabled = v; }
        );
        settings.store.pendingEnable = settings.store.pendingEnable.filter(p => !done.includes(p.pluginName));

        // Desktop-only launch priming (snapshot for instant open + store-behind
        // check + the startup update check it subsumes), delayed so it doesn't
        // contend with boot.
        if (!IS_WEB)
            setTimeout(() => {
                primeStore().catch(e => new Logger("MyaxPluginStore").error("prime failed", e));
            }, 15_000);
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, e => e.key === SECTION_KEY);
    }
});

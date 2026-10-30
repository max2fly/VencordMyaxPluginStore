/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type Platform = "windows" | "linux" | "macos";

export type HostKind = "vesktop" | "discord-desktop";

export interface PlatformReqs {
    vesktopOnly: boolean;
    discordDesktopOnly: boolean;
    platforms: Platform[] | null;
}

export interface RecommendedEntry {
    repo: string;
    /** Optional overrides; absent fields are read from the plugin's own source. */
    displayName?: string;
    description?: string;
    author?: string;
    platforms?: string[];
    vesktopOnly?: boolean;
    discordDesktopOnly?: boolean;
}

export interface RepoInfo {
    fullName: string;
    name: string;
    description: string;
    topics: string[];
    defaultBranch: string;
    cloneUrl: string;
}

export interface PluginEntry {
    repo: string;
    repoName: string;
    cloneUrl: string;
    defaultBranch: string;
    displayName: string;
    description: string;
    author: string;
    source: "author" | "recommended";
    reqs: PlatformReqs;
    declaresDeps: boolean;
    /** The plugin's REAL internal `definePlugin({ name })`; the key Vencord's registry uses. */
    pluginName: string;
    /** Declared prerequisites: the plugin's `definePlugin({ dependencies })` array (plugin names), or `[]`. */
    requires: string[];
}

export type InstallState =
    | { kind: "not-installed"; }
    | { kind: "installed"; updateAvailable: boolean; }
    | { kind: "incompatible"; reason: string; installable: boolean; }
    | { kind: "busy"; op: "installing" | "updating" | "uninstalling"; };

export type GitResult<T = string> =
    | { ok: true; value: T; }
    | { ok: false; message: string; error?: unknown; };

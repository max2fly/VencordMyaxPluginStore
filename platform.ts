/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { HostKind, Platform, PlatformReqs, RecommendedEntry } from "./types";

const OS_TOPICS: Record<string, Platform> = {
    "windows-only": "windows",
    "linux-only": "linux",
    "macos-only": "macos"
};

const OS_LABELS: Record<Platform, string> = {
    windows: "Windows",
    linux: "Linux",
    macos: "macOS"
};

/** Derive platform requirements from a repository's GitHub topics. */
export function parsePlatformReqs(topics: string[]): PlatformReqs {
    const platforms: Platform[] = [];
    for (const topic of topics) {
        const os = OS_TOPICS[topic];
        if (os && !platforms.includes(os)) platforms.push(os);
    }

    return {
        vesktopOnly: topics.includes("vesktop-only"),
        discordDesktopOnly: topics.includes("discord-desktop-only"),
        platforms: platforms.length > 0 ? platforms : null
    };
}

/** Derive platform requirements from a hand-curated recommended entry. */
export function reqsFromRecommended(e: RecommendedEntry): PlatformReqs {
    const platforms = e.platforms?.filter((p): p is Platform => p in OS_LABELS) ?? [];

    return {
        vesktopOnly: e.vesktopOnly ?? false,
        discordDesktopOnly: e.discordDesktopOnly ?? false,
        platforms: platforms.length > 0 ? platforms : null
    };
}

/** Check whether a plugin's requirements are satisfied by the current host/OS. */
export function compatibility(
    reqs: PlatformReqs,
    host: HostKind,
    platform: Platform
): { ok: true; } | { ok: false; reason: string; } {
    if (reqs.vesktopOnly && host !== "vesktop")
        return { ok: false, reason: "Requires Vesktop" };

    if (reqs.discordDesktopOnly && host !== "discord-desktop")
        return { ok: false, reason: "Requires the Discord desktop app" };

    if (reqs.platforms && !reqs.platforms.includes(platform)) {
        const label = reqs.platforms.map(p => OS_LABELS[p]).join("/");
        return { ok: false, reason: `${label} only` };
    }

    return { ok: true };
}

/** The host this plugin is currently running under. Not unit-tested. */
export function currentHost(): HostKind {
    return IS_VESKTOP ? "vesktop" : "discord-desktop";
}

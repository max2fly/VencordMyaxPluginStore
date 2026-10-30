/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { computeStates, excludeSelf, planUpdateCheck, reconcilePendingEnables, resolvePrereqs } from "./pure";
import { PlatformReqs, PluginEntry } from "./types";

const anyReqs: PlatformReqs = { vesktopOnly: false, discordDesktopOnly: false, platforms: null };

function entry(partial: Partial<PluginEntry> & { repoName: string; }): PluginEntry {
    return {
        repo: `max2fly/${partial.repoName}`,
        cloneUrl: `https://github.com/max2fly/${partial.repoName}.git`,
        defaultBranch: "main",
        displayName: partial.repoName,
        description: "",
        author: "max2fly",
        source: "author",
        reqs: anyReqs,
        declaresDeps: false,
        pluginName: partial.repoName,
        requires: [],
        ...partial
    };
}

describe("computeStates", () => {
    it("marks a compatible, installed, up-to-date entry as installed without update", () => {
        const e = entry({ repoName: "Foo" });
        const states = computeStates([e], ["Foo"], new Map(), "vesktop", "windows");
        expect(states.get("Foo")).toEqual({ kind: "installed", updateAvailable: false });
    });

    it("marks an installed entry that is behind as updateAvailable", () => {
        const e = entry({ repoName: "Foo" });
        const states = computeStates([e], ["Foo"], new Map([["Foo", { behind: true }]]), "vesktop", "windows");
        expect(states.get("Foo")).toEqual({ kind: "installed", updateAvailable: true });
    });

    it("marks a platform-incompatible entry as incompatible with the platform reason", () => {
        const e = entry({
            repoName: "WinOnly",
            reqs: { vesktopOnly: false, discordDesktopOnly: false, platforms: ["windows"] }
        });
        const states = computeStates([e], [], new Map(), "vesktop", "linux");
        expect(states.get("WinOnly")).toEqual({ kind: "incompatible", reason: "Windows only", installable: true });
    });

    it("marks a compatible entry that declares dependencies as incompatible and NOT installable", () => {
        const e = entry({ repoName: "HasDeps", declaresDeps: true });
        const states = computeStates([e], [], new Map(), "vesktop", "windows");
        expect(states.get("HasDeps")).toEqual({
            kind: "incompatible",
            reason: "Needs manual install (has dependencies)",
            installable: false
        });
    });

    it("marks a compatible, not-installed entry as not-installed", () => {
        const e = entry({ repoName: "Bar" });
        const states = computeStates([e], ["Foo"], new Map(), "vesktop", "windows");
        expect(states.get("Bar")).toEqual({ kind: "not-installed" });
    });
});

describe("resolvePrereqs", () => {
    const present = (names: string[]) => (name: string) => names.includes(name);

    it("skips a prerequisite that is already present", () => {
        const e = entry({ repoName: "Needs", requires: ["ApiPlugin"] });
        const result = resolvePrereqs(e, [], present(["ApiPlugin"]));
        expect(result).toEqual({ toInstall: [], missingUnknown: [] });
    });

    it("queues a prerequisite that matches a catalog entry's pluginName", () => {
        const e = entry({ repoName: "Needs", requires: ["Helper"] });
        const helper = entry({ repoName: "HelperRepo", pluginName: "Helper" });
        const result = resolvePrereqs(e, [helper, e], present([]));
        expect(result.toInstall).toEqual([helper]);
        expect(result.missingUnknown).toEqual([]);
    });

    it("reports an unknown prerequisite the store doesn't carry", () => {
        const e = entry({ repoName: "Needs", requires: ["Ghost"] });
        const result = resolvePrereqs(e, [e], present([]));
        expect(result.toInstall).toEqual([]);
        expect(result.missingUnknown).toEqual(["Ghost"]);
    });

    it("dedupes catalog prerequisites by repo", () => {
        const helper = entry({ repoName: "HelperRepo", pluginName: "Helper" });
        // Two distinct required names both resolving to the same catalog repo.
        const alias = entry({ repoName: "HelperRepo", pluginName: "HelperAlias" });
        const e = entry({ repoName: "Needs", requires: ["Helper", "HelperAlias"] });
        const result = resolvePrereqs(e, [helper, alias, e], present([]));
        expect(result.toInstall).toHaveLength(1);
        expect(result.toInstall[0].repo).toBe(helper.repo);
    });

    it("mixes present, catalog, and unknown prerequisites", () => {
        const helper = entry({ repoName: "HelperRepo", pluginName: "Helper" });
        const e = entry({ repoName: "Needs", requires: ["ApiPlugin", "Helper", "Ghost"] });
        const result = resolvePrereqs(e, [helper, e], present(["ApiPlugin"]));
        expect(result.toInstall).toEqual([helper]);
        expect(result.missingUnknown).toEqual(["Ghost"]);
    });
});

describe("excludeSelf", () => {
    it("drops the store's own entry, matched by internal pluginName", () => {
        const self = entry({ repoName: "VencordMyaxPluginStore", pluginName: "MyaxPluginStore" });
        const other = entry({ repoName: "Other", pluginName: "Other" });
        expect(excludeSelf([self, other])).toEqual([other]);
    });

    it("leaves the catalog untouched when the store isn't in it", () => {
        const a = entry({ repoName: "A", pluginName: "A" });
        const b = entry({ repoName: "B", pluginName: "B" });
        expect(excludeSelf([a, b])).toEqual([a, b]);
    });
});

describe("reconcilePendingEnables", () => {
    it("enables only the known pending plugin and returns its name", () => {
        const setEnabled = vi.fn();
        const pending = [
            { repoName: "KnownRepo", pluginName: "Known" },
            { repoName: "UnknownRepo", pluginName: "Unknown" }
        ];
        const reconciled = reconcilePendingEnables(pending, name => name === "Known", setEnabled);

        expect(reconciled).toEqual(["Known"]);
        expect(setEnabled).toHaveBeenCalledTimes(1);
        expect(setEnabled).toHaveBeenCalledWith("Known", true);
    });
});

describe("planUpdateCheck", () => {
    const e1 = entry({ repoName: "One" });
    const e2 = entry({ repoName: "Two" });

    it("returns none when nothing is outdated", () => {
        expect(planUpdateCheck([], false)).toEqual({ action: "none" });
    });

    it("returns notify with a count when autoUpdate is off", () => {
        expect(planUpdateCheck([e1, e2], false)).toEqual({ action: "notify", count: 2 });
    });

    it("returns auto with the entries when autoUpdate is on", () => {
        expect(planUpdateCheck([e1], true)).toEqual({ action: "auto", entries: [e1] });
    });
});

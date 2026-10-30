/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { buildUpdateSequence, classifyGitError, markUpdated } from "./pure";
import { InstallState, PlatformReqs, PluginEntry } from "./types";

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

describe("classifyGitError", () => {
    // Every collision pattern git may print, as it appears in a real stderr line.
    const collisions: [name: string, message: string][] = [
        ["would be overwritten", "error: Your local changes to the following files would be overwritten by merge:"],
        ["local changes", "Please commit your local changes before you merge."],
        ["not possible to fast-forward", "fatal: Not possible to fast-forward, aborting."],
        ["divergent", "fatal: Need to specify how to reconcile divergent branches."],
        ["need to specify how to reconcile", "hint: You have divergent branches and need to specify how to reconcile them."],
        ["unstaged changes", "error: cannot pull with rebase: You have unstaged changes."]
    ];

    it.each(collisions)("classifies a %s collision as a stash-pull fix carrying the repoName", (_name, message) => {
        const result = classifyGitError(message, "SomePlugin");
        expect(result.message).toBe(message);
        expect(result.fix).toBeDefined();
        expect(result.fix!.kind).toBe("stash-pull");
        expect(result.fix!.repoName).toBe("SomePlugin");
        expect(result.fix!.description).toMatch(/stash/i);
    });

    it("matches collision patterns case-insensitively", () => {
        const result = classifyGitError("YOUR LOCAL CHANGES WOULD BE OVERWRITTEN", "P");
        expect(result.fix?.kind).toBe("stash-pull");
    });

    it("leaves repoName undefined on a stash-pull fix when none is given", () => {
        const result = classifyGitError("local changes present");
        expect(result.fix?.kind).toBe("stash-pull");
        expect(result.fix?.repoName).toBeUndefined();
    });

    it("classifies an ENOENT error as a recreate-dir fix (no repoName)", () => {
        const message = "ENOENT: no such file or directory, open '/foo/src/userplugins'";
        const result = classifyGitError(message);
        expect(result.message).toBe(message);
        expect(result.fix?.kind).toBe("recreate-dir");
        expect(result.fix).not.toHaveProperty("repoName");
    });

    it("classifies a 'no such file or directory' error as recreate-dir", () => {
        const result = classifyGitError("fatal: could not open: no such file or directory");
        expect(result.fix?.kind).toBe("recreate-dir");
    });

    it("returns no fix for an unrecognized error but preserves the message", () => {
        const message = "fatal: unable to access 'https://github.com/...': Could not resolve host";
        const result = classifyGitError(message, "P");
        expect(result).toEqual({ message });
        expect(result.fix).toBeUndefined();
    });

    it("always preserves the raw message verbatim", () => {
        for (const [, message] of collisions) {
            expect(classifyGitError(message).message).toBe(message);
        }
        const unknown = "some other failure";
        expect(classifyGitError(unknown).message).toBe(unknown);
    });
});

describe("buildUpdateSequence", () => {
    const a = entry({ repoName: "A" });
    const b = entry({ repoName: "B" });
    const self = entry({ repoName: "StoreRepo", pluginName: "MyaxPluginStore" });

    it("returns just the behind plugins when the store isn't included", () => {
        expect(buildUpdateSequence([a, b], false, true, self)).toEqual([a, b]);
    });

    it("appends the store entry LAST when included and behind", () => {
        expect(buildUpdateSequence([a, b], true, true, self)).toEqual([a, b, self]);
    });

    it("omits the store when it isn't behind, even if included", () => {
        expect(buildUpdateSequence([a], true, false, self)).toEqual([a]);
    });

    it("omits the store when there's no captured self entry", () => {
        expect(buildUpdateSequence([a], true, true, null)).toEqual([a]);
    });

    it("returns an empty sequence for no behind plugins and no store update", () => {
        expect(buildUpdateSequence([], true, false, self)).toEqual([]);
        expect(buildUpdateSequence([], false, true, self)).toEqual([]);
    });

    it("returns store-only when nothing else is behind but the store is", () => {
        expect(buildUpdateSequence([], true, true, self)).toEqual([self]);
    });

    it("does not mutate the input array", () => {
        const behind = [a];
        buildUpdateSequence(behind, true, true, self);
        expect(behind).toEqual([a]);
    });
});

describe("markUpdated", () => {
    const states = (): Map<string, InstallState> => new Map<string, InstallState>([
        ["A", { kind: "installed", updateAvailable: true }],
        ["B", { kind: "installed", updateAvailable: false }],
        ["C", { kind: "not-installed" }],
        ["D", { kind: "incompatible", reason: "nope", installable: false }]
    ]);

    it("clears updateAvailable for installed repos in the set", () => {
        const next = markUpdated(states(), ["A"]);
        expect(next.get("A")).toEqual({ kind: "installed", updateAvailable: false });
    });

    it("leaves installed repos not in the set untouched", () => {
        const next = markUpdated(states(), ["A"]);
        expect(next.get("B")).toEqual({ kind: "installed", updateAvailable: false });
    });

    it("ignores repos that aren't installed (not-installed / incompatible)", () => {
        const next = markUpdated(states(), ["C", "D"]);
        expect(next.get("C")).toEqual({ kind: "not-installed" });
        expect(next.get("D")).toEqual({ kind: "incompatible", reason: "nope", installable: false });
    });

    it("ignores repoNames absent from the map", () => {
        const next = markUpdated(states(), ["Z"]);
        expect(next.has("Z")).toBe(false);
    });

    it("returns a new map and does not mutate the input", () => {
        const input = states();
        const next = markUpdated(input, ["A"]);
        expect(next).not.toBe(input);
        expect(input.get("A")).toEqual({ kind: "installed", updateAvailable: true });
    });

    it("handles a batch of several repos", () => {
        const next = markUpdated(states(), ["A", "B"]);
        expect(next.get("A")).toEqual({ kind: "installed", updateAvailable: false });
        expect(next.get("B")).toEqual({ kind: "installed", updateAvailable: false });
    });
});

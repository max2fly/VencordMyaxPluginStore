/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    fetchRecommended,
    MANIFEST_RAW_URL,
    mergeCatalog,
    parseRecommended,
    recommendedToEntry
} from "./manifest";
import { PluginEntry } from "./types";

describe("parseRecommended", () => {
    it("reads .plugins and drops entries missing repo", () => {
        const json = '{"plugins":[{"repo":"a/b","displayName":"B","description":"d","author":"x"},{"displayName":"bad"}]}';
        const entries = parseRecommended(json);
        expect(entries).toHaveLength(1);
        expect(entries[0].repo).toBe("a/b");
    });

    it("returns [] for missing or non-array .plugins", () => {
        expect(parseRecommended("{}")).toEqual([]);
        expect(parseRecommended('{"plugins":"nope"}')).toEqual([]);
    });

    it("returns [] for invalid JSON", () => {
        expect(parseRecommended("not json")).toEqual([]);
    });
});

describe("recommendedToEntry", () => {
    it("maps a recommended entry into a PluginEntry", () => {
        const entry = recommendedToEntry({
            repo: "foo/bar",
            displayName: "Bar",
            description: "a bar plugin",
            author: "foo"
        });

        expect(entry).toEqual({
            repo: "foo/bar",
            repoName: "bar",
            cloneUrl: "https://github.com/foo/bar.git",
            defaultBranch: "HEAD",
            displayName: "Bar",
            description: "a bar plugin",
            author: "foo",
            source: "recommended",
            reqs: { vesktopOnly: false, discordDesktopOnly: false, platforms: null },
            declaresDeps: false,
            pluginName: "bar",
            requires: []
        });
    });

    it("fills displayName/description/author/requires from fetched meta when the entry omits them", () => {
        const e = recommendedToEntry(
            { repo: "owner/name" },
            { name: "RealName", description: "fetched desc", dependencies: ["Dep"] }
        );
        expect(e).toMatchObject({
            repo: "owner/name",
            repoName: "name",
            displayName: "RealName",
            description: "fetched desc",
            author: "owner",
            pluginName: "RealName",
            requires: ["Dep"]
        });
    });

    it("falls back to repo name/owner/empty when neither the entry nor the fetch provide fields", () => {
        const e = recommendedToEntry({ repo: "owner/name" });
        expect(e).toMatchObject({
            displayName: "name",
            description: "",
            author: "owner",
            pluginName: "name",
            requires: []
        });
    });

    it("lets manifest fields override fetched meta (except pluginName, the real key)", () => {
        const e = recommendedToEntry(
            { repo: "owner/name", displayName: "Override", description: "override desc", author: "someoneElse" },
            { name: "RealName", description: "fetched desc", dependencies: ["Dep"] }
        );
        expect(e).toMatchObject({
            displayName: "Override",
            description: "override desc",
            author: "someoneElse",
            pluginName: "RealName",
            requires: ["Dep"]
        });
    });

    it("carries platform requirements through reqsFromRecommended", () => {
        const entry = recommendedToEntry({
            repo: "foo/bar",
            displayName: "Bar",
            description: "d",
            author: "foo",
            vesktopOnly: true,
            platforms: ["linux"]
        });

        expect(entry.reqs).toEqual({ vesktopOnly: true, discordDesktopOnly: false, platforms: ["linux"] });
    });
});

describe("mergeCatalog", () => {
    it("concats and dedupes by repo with the author winning", () => {
        const author = [{ repo: "max2fly/x", source: "author" } as PluginEntry];
        const recommended = [
            { repo: "max2fly/x", source: "recommended" } as PluginEntry,
            { repo: "o/y", source: "recommended" } as PluginEntry
        ];

        const merged = mergeCatalog(author, recommended);
        expect(merged).toHaveLength(2);
        const x = merged.find(e => e.repo === "max2fly/x");
        expect(x!.source).toBe("author");
        expect(merged.find(e => e.repo === "o/y")!.source).toBe("recommended");
    });
});

describe("fetchRecommended", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("fetches and parses the live manifest", async () => {
        const payload = JSON.stringify({
            plugins: [{ repo: "foo/bar", displayName: "Bar", description: "d", author: "foo" }]
        });
        const spy = vi.fn(async () => new Response(payload, { status: 200 }));
        vi.stubGlobal("fetch", spy);

        const entries = await fetchRecommended();
        expect(spy).toHaveBeenCalledWith(MANIFEST_RAW_URL);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            repo: "foo/bar",
            repoName: "bar",
            source: "recommended",
            defaultBranch: "HEAD"
        });
    });

    it("falls back to the bundled manifest on failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
        const entries = await fetchRecommended();
        // Bundled recommended.json ships one curated entry; the raw name/deps
        // resolution also fails here, so it keeps the base pluginName + empty requires.
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            repo: "Syncxv/vc-message-logger-enhanced",
            source: "recommended",
            pluginName: "vc-message-logger-enhanced",
            requires: []
        });
    });

    it("falls back to the bundled manifest on a non-ok response", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
        const entries = await fetchRecommended();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ repo: "Syncxv/vc-message-logger-enhanced", requires: [] });
    });
});

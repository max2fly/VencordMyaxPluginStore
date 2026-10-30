/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    AUTHOR,
    fetchAuthorRepos,
    filterPluginRepos,
    parseDefinePluginDependencies,
    parseDefinePluginMeta,
    parsePackageJsonDeps,
    repoToEntry,
    TOPIC
} from "./github";
import { RepoInfo } from "./types";

function makeRepo(name: string, topics: string[]): RepoInfo {
    return {
        fullName: `${AUTHOR}/${name}`,
        name,
        description: `${name} description`,
        topics,
        defaultBranch: "main",
        cloneUrl: `https://github.com/${AUTHOR}/${name}.git`
    };
}

// The 12 real repos; 6 are plugins, 6 are not.
const PLUGIN_NAMES = [
    "GifManager",
    "QuickReact",
    "BetterUploads",
    "ThemeSync",
    "VoiceTweaks",
    "StatusRotator"
];
const NON_PLUGIN_NAMES = [
    "dotfiles",
    "max2fly.github.io",
    "scripts",
    "notes",
    "sandbox",
    "archive"
];

describe("filterPluginRepos", () => {
    it("keeps only repos tagged with the plugin topic", () => {
        const repos = [
            ...PLUGIN_NAMES.map(n => makeRepo(n, ["vencord-plugin", "whatever"])),
            ...NON_PLUGIN_NAMES.map(n => makeRepo(n, ["misc"]))
        ];

        const kept = filterPluginRepos(repos);
        expect(kept).toHaveLength(6);
        expect(kept.map(r => r.name).sort()).toEqual([...PLUGIN_NAMES].sort());
    });

    it("keeps nothing when no repo is tagged", () => {
        const repos = [...PLUGIN_NAMES, ...NON_PLUGIN_NAMES].map(n => makeRepo(n, ["misc"]));
        expect(filterPluginRepos(repos)).toHaveLength(0);
    });

    it("honours an explicit topic argument", () => {
        const repos = [makeRepo("a", ["custom-topic"]), makeRepo("b", ["vencord-plugin"])];
        expect(filterPluginRepos(repos, "custom-topic").map(r => r.name)).toEqual(["a"]);
    });
});

describe("parseDefinePluginMeta", () => {
    it("extracts name and description from a definePlugin call", () => {
        const source = `export default definePlugin({ name: "Gif Manager", description: "x", authors:[Devs.max2fly] });`;
        expect(parseDefinePluginMeta(source)).toEqual({ name: "Gif Manager", description: "x" });
    });

    it("tolerates single quotes and reversed key order", () => {
        const source = `definePlugin({ description: 'the desc', authors: [], name: 'My Plugin' })`;
        expect(parseDefinePluginMeta(source)).toEqual({ name: "My Plugin", description: "the desc" });
    });

    it("returns {} when there is no definePlugin call", () => {
        expect(parseDefinePluginMeta("export const x = 1;")).toEqual({});
    });

    it("resolves a variable argument: const _p = {...}; definePlugin(_p)", () => {
        const source = [
            'const settings = definePluginSettings({ foo: { bar: 1 } });',
            'const _plugin: PluginDef & Record<string, any> = {',
            '    name: "Oshifier",',
            '    description: "oshi your favorite streamer",',
            '};',
            "export default definePlugin(_plugin);",
            "export { settings };"
        ].join("\n");
        expect(parseDefinePluginMeta(source)).toEqual({ name: "Oshifier", description: "oshi your favorite streamer" });
    });
});

describe("parseDefinePluginDependencies", () => {
    it("extracts plugin names from a double-quoted dependencies array", () => {
        const source = `definePlugin({ name: "X", dependencies: ["MessageEventsAPI", "CommandsAPI"] })`;
        expect(parseDefinePluginDependencies(source)).toEqual(["MessageEventsAPI", "CommandsAPI"]);
    });

    it("tolerates single quotes and whitespace/newlines", () => {
        const source = `definePlugin({\n  name: 'X',\n  dependencies: [\n    'FooApi',\n    'BarApi'\n  ]\n})`;
        expect(parseDefinePluginDependencies(source)).toEqual(["FooApi", "BarApi"]);
    });

    it("returns [] when there is no dependencies key", () => {
        expect(parseDefinePluginDependencies(`definePlugin({ name: "X" })`)).toEqual([]);
    });

    it("returns [] when dependencies is a non-literal (a variable)", () => {
        expect(parseDefinePluginDependencies(`definePlugin({ name: "X", dependencies: someVar })`)).toEqual([]);
    });

    it("returns [] when there is no definePlugin call", () => {
        expect(parseDefinePluginDependencies("export const x = 1;")).toEqual([]);
    });

    it("resolves dependencies from a variable argument", () => {
        const source = [
            'const _plugin: PluginDef = { name: "X", dependencies: ["MessageLoggerEnhanced"] };',
            "export default definePlugin(_plugin);"
        ].join("\n");
        expect(parseDefinePluginDependencies(source)).toEqual(["MessageLoggerEnhanced"]);
    });

    it("isn't truncated by an inlined object that closes with `})` before the keys", () => {
        // `settings: definePluginSettings({...})` closes with `})` BEFORE name/dependencies.
        // A non-greedy body capture would stop there and miss both; the balanced extractor must not.
        const source = `export default definePlugin({
            settings: definePluginSettings({ a: { b: 1 }, c: { d: 2 } }),
            name: "Deep",
            dependencies: ["DepA"],
            start() { const x = { y: 1 }; return x; }
        });`;
        expect(parseDefinePluginDependencies(source)).toEqual(["DepA"]);
        expect(parseDefinePluginMeta(source)).toEqual({ name: "Deep" });
    });
});

describe("parsePackageJsonDeps", () => {
    it("is true when dependencies has at least one key", () => {
        expect(parsePackageJsonDeps('{"dependencies":{"gifenc":"1"}}')).toBe(true);
    });

    it("ignores devDependencies", () => {
        expect(parsePackageJsonDeps('{"devDependencies":{"vitest":"1"}}')).toBe(false);
    });

    it("is false for an empty object", () => {
        expect(parsePackageJsonDeps("{}")).toBe(false);
    });

    it("is false for invalid JSON", () => {
        expect(parsePackageJsonDeps("not json")).toBe(false);
    });
});

describe("fetchAuthorRepos", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("maps HTTP 403 to the rate-limit message", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
        const result = await fetchAuthorRepos();
        expect(result).toEqual({ ok: false, message: "GitHub rate limit reached — try again later" });
    });

    it("maps a thrown fetch to the offline message", async () => {
        const error = new Error("network down");
        vi.stubGlobal("fetch", vi.fn(async () => { throw error; }));
        const result = await fetchAuthorRepos();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toBe("Couldn't reach GitHub");
            expect(result.error).toBe(error);
        }
    });

    it("maps GitHub JSON into RepoInfo on success", async () => {
        const payload = [{
            full_name: "max2fly/GifManager",
            name: "GifManager",
            description: null,
            topics: ["vencord-plugin"],
            default_branch: "main",
            clone_url: "https://github.com/max2fly/GifManager.git"
        }];
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));

        const result = await fetchAuthorRepos();
        expect(result).toEqual({
            ok: true,
            value: [{
                fullName: "max2fly/GifManager",
                name: "GifManager",
                description: "",
                topics: ["vencord-plugin"],
                defaultBranch: "main",
                cloneUrl: "https://github.com/max2fly/GifManager.git"
            }]
        });
    });

    it("requests the author's repos with per_page=100", async () => {
        const spy = vi.fn(async () => new Response("[]", { status: 200 }));
        vi.stubGlobal("fetch", spy);
        await fetchAuthorRepos();
        expect(spy).toHaveBeenCalledWith(`https://api.github.com/users/${AUTHOR}/repos?per_page=100`);
    });
});

describe("repoToEntry", () => {
    it("prefers the plugin's declared name and carries over reqs/deps/requires", () => {
        const repo = makeRepo("GifManager", ["vencord-plugin", "vesktop-only"]);
        const entry = repoToEntry(repo, {
            name: "Gif Manager",
            description: "d",
            dependencies: ["CommandsAPI"],
            declaresDeps: true
        });

        expect(entry).toEqual({
            repo: `${AUTHOR}/GifManager`,
            repoName: "GifManager",
            cloneUrl: repo.cloneUrl,
            defaultBranch: "main",
            displayName: "Gif Manager",
            description: "d",
            author: AUTHOR,
            source: "author",
            reqs: { vesktopOnly: true, discordDesktopOnly: false, platforms: null },
            declaresDeps: true,
            pluginName: "Gif Manager",
            requires: ["CommandsAPI"]
        });
    });

    it("falls back to the repo name for pluginName and [] requires when meta is bare", () => {
        const repo = makeRepo("GifManager", ["vencord-plugin"]);
        const entry = repoToEntry(repo, { declaresDeps: false });
        expect(entry.displayName).toBe("GifManager");
        expect(entry.description).toBe(repo.description);
        expect(entry.declaresDeps).toBe(false);
        expect(entry.pluginName).toBe("GifManager");
        expect(entry.requires).toEqual([]);
    });
});

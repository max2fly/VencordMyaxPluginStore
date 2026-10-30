/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parsePlatformReqs } from "./platform";
import { GitResult, PluginEntry, RepoInfo } from "./types";

export const AUTHOR = "max2fly";
export const TOPIC = "vencord-plugin";

const RAW_BASE = "https://raw.githubusercontent.com";

interface GitHubRepoJson {
    full_name: string;
    name: string;
    description: string | null;
    topics?: string[];
    default_branch: string;
    clone_url: string;
}

/** Fetch every public repo of an author in one call (GitHub caps at 100). */
export async function fetchAuthorRepos(author: string = AUTHOR): Promise<GitResult<RepoInfo[]>> {
    const url = `https://api.github.com/users/${author}/repos?per_page=100`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch (error) {
        return { ok: false, message: "Couldn't reach GitHub", error };
    }

    if (res.status === 403)
        return { ok: false, message: "GitHub rate limit reached — try again later" };

    if (!res.ok)
        return { ok: false, message: `GitHub request failed (${res.status})` };

    try {
        const json = (await res.json()) as GitHubRepoJson[];
        const value = json.map<RepoInfo>(r => ({
            fullName: r.full_name,
            name: r.name,
            description: r.description ?? "",
            topics: r.topics ?? [],
            defaultBranch: r.default_branch,
            cloneUrl: r.clone_url
        }));
        return { ok: true, value };
    } catch (error) {
        return { ok: false, message: "Couldn't read GitHub's response", error };
    }
}

/** Keep only repos whose topics advertise them as a Vencord plugin. */
export function filterPluginRepos(repos: RepoInfo[], topic: string = TOPIC): RepoInfo[] {
    return repos.filter(r => r.topics.includes(topic));
}

/**
 * Return the source of the first `definePlugin({ ... })` object literal, brace-balanced.
 *
 * A non-greedy regex would stop at the first `}` and so truncate the moment a plugin
 * inlines any `foo({...})` or nested object before the keys we read (e.g.
 * `settings: definePluginSettings({...})` placed above `name`/`dependencies`), silently
 * dropping prerequisites. This scans with a brace-depth counter instead, skipping braces
 * inside `'`/`"`/backtick string literals (escapes honoured). Comments are not handled —
 * not needed for entry files. Returns the inner body (between the outer braces), or `null`.
 */
/** Scan the balanced `{...}` object whose opening brace is at `open`; returns the inner body, or `null`. */
function balancedBodyFrom(source: string, open: number): string | null {
    const start = open + 1;
    let depth = 0;
    let str: string | null = null;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (str !== null) {
            if (c === "\\") i++;
            else if (c === str) str = null;
            continue;
        }
        if (c === "'" || c === "\"" || c === "`") str = c;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return source.slice(start, i);
    }
    return null;
}

function extractDefinePluginBody(source: string): string | null {
    const call = /definePlugin\s*\(\s*/.exec(source);
    if (!call) return null;

    const argStart = call.index + call[0].length;

    // Inline object literal: `definePlugin({ ... })`.
    if (source[argStart] === "{") return balancedBodyFrom(source, argStart);

    // Variable argument: `definePlugin(_plugin)` where the object is declared separately,
    // e.g. `const _plugin: PluginDef = { ... }`. Resolve that declaration's object body.
    const ident = /^[A-Za-z_$][\w$]*/.exec(source.slice(argStart));
    if (!ident) return null;
    const escaped = ident[0].replace(/\$/g, "\\$");
    const decl = new RegExp(`(?:const|let|var)\\s+${escaped}\\b[^=]*=\\s*\\{`).exec(source);
    if (!decl) return null;
    return balancedBodyFrom(source, decl.index + decl[0].length - 1);
}

/**
 * Extract `name`/`description` string literals from the first `definePlugin({...})`
 * call in a plugin's entry source. Tolerates single/double quotes and any key order.
 */
export function parseDefinePluginMeta(source: string): { name?: string; description?: string; } {
    const body = extractDefinePluginBody(source);
    if (body === null) return {};

    const pick = (key: string): string | undefined => {
        const m = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`).exec(body);
        return m ? m[2] : undefined;
    };

    const result: { name?: string; description?: string; } = {};
    const name = pick("name");
    const description = pick("description");
    if (name !== undefined) result.name = name;
    if (description !== undefined) result.description = description;
    return result;
}

/**
 * Extract the plugin NAMES from the `dependencies: [ ... ]` array inside the first
 * `definePlugin({...})` call (Vencord's prerequisite field). Tolerates single/double
 * quotes and any key order. Returns `[]` if absent or the value isn't an array literal
 * of string literals (e.g. `dependencies: someVar`).
 */
export function parseDefinePluginDependencies(source: string): string[] {
    const body = extractDefinePluginBody(source);
    if (body === null) return [];

    const arr = /\bdependencies\s*:\s*\[([\s\S]*?)\]/.exec(body);
    if (!arr) return [];

    const names: string[] = [];
    const lit = /(["'])((?:\\.|(?!\1).)*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = lit.exec(arr[1])) !== null) names.push(m[2]);
    return names;
}

/** True iff the parsed package.json declares at least one runtime dependency. */
export function parsePackageJsonDeps(json: string): boolean {
    try {
        const parsed = JSON.parse(json) as { dependencies?: Record<string, unknown>; };
        const deps = parsed?.dependencies;
        return typeof deps === "object" && deps !== null && Object.keys(deps).length > 0;
    } catch {
        return false;
    }
}

async function fetchRaw(fullName: string, branch: string, path: string): Promise<Response | null> {
    try {
        return await fetch(`${RAW_BASE}/${fullName}/${branch}/${path}`);
    } catch {
        return null;
    }
}

/**
 * Enrich a repo with its declared plugin name/description (from the entry file)
 * and whether it ships runtime dependencies (from package.json).
 */
export async function fetchPluginMeta(repo: RepoInfo): Promise<{ name?: string; description?: string; dependencies: string[]; declaresDeps: boolean; }> {
    let meta: { name?: string; description?: string; } = {};
    let dependencies: string[] = [];
    for (const entry of ["index.tsx", "index.ts"]) {
        const res = await fetchRaw(repo.fullName, repo.defaultBranch, entry);
        if (res && res.ok) {
            const text = await res.text();
            meta = parseDefinePluginMeta(text);
            dependencies = parseDefinePluginDependencies(text);
            break;
        }
    }

    let declaresDeps = false;
    const pkg = await fetchRaw(repo.fullName, repo.defaultBranch, "package.json");
    if (pkg && pkg.ok)
        declaresDeps = parsePackageJsonDeps(await pkg.text());

    return { ...meta, dependencies, declaresDeps };
}

/**
 * Lighter raw fetch for recommended entries: resolve only the real internal plugin
 * name, description, and declared prerequisites from the entry file (no package.json
 * fetch — recommended compatibility isn't deps-gated here). Off the GitHub API budget.
 */
export async function fetchPluginNameAndDeps(fullName: string, branch: string): Promise<{ name?: string; description?: string; dependencies: string[]; }> {
    for (const entry of ["index.tsx", "index.ts"]) {
        const res = await fetchRaw(fullName, branch, entry);
        if (res && res.ok) {
            const text = await res.text();
            return { ...parseDefinePluginMeta(text), dependencies: parseDefinePluginDependencies(text) };
        }
    }
    return { dependencies: [] };
}

/** Fold a discovered repo and its parsed metadata into a store entry. */
export function repoToEntry(
    repo: RepoInfo,
    meta: { name?: string; description?: string; dependencies?: string[]; declaresDeps: boolean; }
): PluginEntry {
    return {
        repo: repo.fullName,
        repoName: repo.name,
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        displayName: meta.name ?? repo.name,
        description: meta.description ?? repo.description,
        author: AUTHOR,
        source: "author",
        reqs: parsePlatformReqs(repo.topics),
        declaresDeps: meta.declaresDeps,
        pluginName: meta.name ?? repo.name,
        requires: meta.dependencies ?? []
    };
}

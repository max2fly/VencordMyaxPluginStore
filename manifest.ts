/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchPluginNameAndDeps } from "./github";
import { reqsFromRecommended } from "./platform";
import recommendedJson from "./recommended.json";
import { PluginEntry, RecommendedEntry } from "./types";

/** Raw URL of this repo's `recommended.json` on its default branch. */
export const MANIFEST_RAW_URL =
    "https://raw.githubusercontent.com/max2fly/VencordMyaxPluginStore/main/recommended.json";

/** Read a manifest's `.plugins` array, dropping entries that lack a `repo`. */
export function parseRecommended(json: string): RecommendedEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }

    const plugins = (parsed as { plugins?: unknown; })?.plugins;
    if (!Array.isArray(plugins)) return [];

    return plugins.filter(
        (e): e is RecommendedEntry => typeof e?.repo === "string" && e.repo.length > 0
    );
}

/** Metadata read from a recommended plugin's own source (via raw GitHub). */
export interface RecommendedMeta {
    name?: string;
    description?: string;
    dependencies?: string[];
}

/**
 * Fold a curated recommended entry into a store entry. PURE and network-free: the
 * fetched `meta` (the plugin's own `definePlugin` name/description/dependencies) is
 * injected so the field-precedence can be unit-tested. Precedence per field:
 *   - displayName = manifest override ?? fetched name ?? repo name
 *   - description = manifest override ?? fetched description ?? ""
 *   - author      = manifest override ?? repo OWNER
 *   - pluginName  = fetched internal name ?? repo name (never a manifest override —
 *                   this is the real key Vencord's registry uses)
 *   - requires    = fetched dependencies ?? []
 * An empty `meta` (the fetch failed) cleanly falls back to repo name / owner / "".
 */
export function recommendedToEntry(e: RecommendedEntry, meta: RecommendedMeta = {}): PluginEntry {
    const slash = e.repo.indexOf("/");
    const repoName = slash >= 0 ? e.repo.slice(slash + 1) : e.repo;
    const owner = slash >= 0 ? e.repo.slice(0, slash) : e.repo;

    return {
        repo: e.repo,
        repoName,
        cloneUrl: `https://github.com/${e.repo}.git`,
        // Recommended entries don't pin a branch; "HEAD" lets `git clone` use
        // the repo's own default branch.
        defaultBranch: "HEAD",
        displayName: e.displayName ?? meta.name ?? repoName,
        description: e.description ?? meta.description ?? "",
        author: e.author ?? owner,
        source: "recommended",
        reqs: reqsFromRecommended(e),
        declaresDeps: false,
        pluginName: meta.name ?? repoName,
        requires: meta.dependencies ?? []
    };
}

/**
 * Thin network wrapper around the pure mapper: raw-fetch a recommended entry's
 * source to resolve its real internal name, description, and declared prerequisites,
 * then fold everything (with manifest overrides winning) into a store entry. On any
 * fetch failure the meta is empty, so the entry still renders from repo name/owner.
 */
async function resolveRecommendedEntry(e: RecommendedEntry): Promise<PluginEntry> {
    let meta: RecommendedMeta = {};
    try {
        // Recommended entries don't pin a branch; "HEAD" reads the repo's default.
        meta = await fetchPluginNameAndDeps(e.repo, "HEAD");
    } catch {
        // keep empty meta → recommendedToEntry falls back to repo name/owner/""
    }
    return recommendedToEntry(e, meta);
}

/**
 * Fetch the live recommended manifest, falling back to the bundled copy shipped
 * in this repo on any failure (the fallback is the live path until the manifest
 * repo is published).
 */
export async function fetchRecommended(): Promise<PluginEntry[]> {
    let entries: RecommendedEntry[] | null = null;
    try {
        const res = await fetch(MANIFEST_RAW_URL);
        if (res.ok)
            entries = parseRecommended(await res.text());
    } catch {
        // fall through to the bundled manifest
    }

    if (entries === null) {
        const bundled = recommendedJson as { plugins?: RecommendedEntry[]; };
        entries = (bundled.plugins ?? [])
            .filter(e => typeof e?.repo === "string" && e.repo.length > 0);
    }

    // Resolve each repo's real name/description/prerequisites in parallel (raw.github,
    // off the API budget). Cached once per session via the catalog cache.
    return Promise.all(entries.map(resolveRecommendedEntry));
}

/** Concatenate author and recommended catalogs, deduped by `repo` (author wins). */
export function mergeCatalog(author: PluginEntry[], recommended: PluginEntry[]): PluginEntry[] {
    const byRepo = new Map<string, PluginEntry>();
    for (const entry of recommended) byRepo.set(entry.repo, entry);
    for (const entry of author) byRepo.set(entry.repo, entry);
    return [...byRepo.values()];
}

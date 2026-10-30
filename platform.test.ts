/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { compatibility, parsePlatformReqs, reqsFromRecommended } from "./platform";

describe("parsePlatformReqs", () => {
    it("parses a single OS topic", () => {
        expect(parsePlatformReqs(["vencord-plugin", "windows-only"])).toEqual({
            vesktopOnly: false,
            discordDesktopOnly: false,
            platforms: ["windows"]
        });
    });

    it("parses vesktop-only together with an OS topic", () => {
        expect(parsePlatformReqs(["vencord-plugin", "vesktop-only", "linux-only"])).toEqual({
            vesktopOnly: true,
            discordDesktopOnly: false,
            platforms: ["linux"]
        });
    });

    it("treats the absence of OS topics as any-OS (null)", () => {
        expect(parsePlatformReqs(["vencord-plugin"])).toEqual({
            vesktopOnly: false,
            discordDesktopOnly: false,
            platforms: null
        });
    });
});

describe("compatibility", () => {
    it("rejects a vesktop-only plugin on the Discord desktop app", () => {
        expect(compatibility(
            { vesktopOnly: true, discordDesktopOnly: false, platforms: null },
            "discord-desktop",
            "windows"
        )).toEqual({ ok: false, reason: "Requires Vesktop" });
    });

    it("rejects a Windows-only plugin on Linux", () => {
        expect(compatibility(
            { vesktopOnly: false, discordDesktopOnly: false, platforms: ["windows"] },
            "vesktop",
            "linux"
        )).toEqual({ ok: false, reason: "Windows only" });
    });

    it("accepts an any-OS, any-host plugin", () => {
        expect(compatibility(
            { platforms: null, vesktopOnly: false, discordDesktopOnly: false },
            "vesktop",
            "macos"
        )).toEqual({ ok: true });
    });
});

describe("reqsFromRecommended", () => {
    it("matches the parsed equivalent", () => {
        const reqs = reqsFromRecommended({
            repo: "owner/repo",
            displayName: "Repo",
            description: "desc",
            author: "owner",
            platforms: ["macos"],
            vesktopOnly: true
        });

        expect(reqs).toEqual({
            vesktopOnly: true,
            discordDesktopOnly: false,
            platforms: ["macos"]
        });
        expect(reqs).toEqual(parsePlatformReqs(["vesktop-only", "macos-only"]));
    });
});

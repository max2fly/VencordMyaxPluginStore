/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories (which run before the file body) can see them.
const { execFileMock, rmMock } = vi.hoisted(() => ({
    execFileMock: vi.fn(),
    rmMock: vi.fn()
}));

// The real child_process.execFile is special-cased by util.promisify via a
// custom symbol; our mock mirrors that so `promisify(execFile)` resolves to a
// promise-returning stub we can assert against.
vi.mock("node:child_process", () => {
    const execFile: any = () => {};
    execFile[promisify.custom] = (...args: unknown[]) => execFileMock(...args);
    return { execFile };
});

vi.mock("node:fs/promises", () => ({
    rm: (...args: unknown[]) => rmMock(...args),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => "{}"),
    stat: vi.fn(async () => ({}))
}));

import { git, validateRepoName } from "./git";
import { removePlugin } from "./index";

const origPlatform = process.platform;
function setPlatform(value: string) {
    Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    delete process.env.FLATPAK_ID;
    vi.clearAllMocks();
});

describe("validateRepoName", () => {
    it("accepts a normal name with dots, dashes and digits", () => {
        expect(validateRepoName("good-plugin.1")).toBe(true);
    });

    it("rejects traversal, separators, bare dots and empty", () => {
        for (const bad of ["../evil", "/etc", "a/b", "..", ".", "", "a\\b", "a/../b", " spaced"]) {
            expect(validateRepoName(bad)).toBe(false);
        }
    });
});

describe("git", () => {
    it("returns ok with trimmed stdout on success (no shell, args array)", async () => {
        execFileMock.mockResolvedValue({ stdout: "  abc123\n", stderr: "" });

        const res = await git(["rev-parse", "HEAD"], "/cwd");

        expect(res).toEqual({ ok: true, value: "abc123" });
        expect(execFileMock.mock.calls[0][0]).toBe("git");
        expect(execFileMock.mock.calls[0][1]).toEqual(["rev-parse", "HEAD"]);
        // Must not opt into a shell (shell:true would allow metacharacter injection).
        expect((execFileMock.mock.calls[0][2] as { shell?: unknown; })?.shell).toBeFalsy();
    });

    it("returns not-ok with stderr on rejection", async () => {
        const err = Object.assign(new Error("boom"), { stderr: "fatal: not a repo" });
        execFileMock.mockRejectedValue(err);

        const res = await git(["status"], "/cwd");

        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.message).toBe("fatal: not a repo");
            expect(res.error).toBe(err);
        }
    });

    it("routes through flatpak-spawn on linux when FLATPAK_ID is a Discord sandbox", async () => {
        setPlatform("linux");
        process.env.FLATPAK_ID = "com.discordapp.Discord";
        execFileMock.mockResolvedValue({ stdout: "ok", stderr: "" });

        await git(["pull"], "/cwd");

        expect(execFileMock.mock.calls[0][0]).toBe("flatpak-spawn");
        expect(execFileMock.mock.calls[0][1]).toEqual(["--host", "git", "pull"]);
    });
});

describe("removePlugin", () => {
    it("short-circuits an invalid name without touching the filesystem", async () => {
        const res = await removePlugin({} as never, "../evil");

        expect(res.ok).toBe(false);
        expect(rmMock).not.toHaveBeenCalled();
    });

    it("removes a valid plugin directory recursively", async () => {
        rmMock.mockResolvedValue(undefined);

        const res = await removePlugin({} as never, "good-plugin");

        expect(res.ok).toBe(true);
        expect(rmMock).toHaveBeenCalledTimes(1);
        expect(rmMock.mock.calls[0][1]).toEqual({ recursive: true, force: true });
    });
});

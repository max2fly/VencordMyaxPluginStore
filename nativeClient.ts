/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

/**
 * Renderer-side handle to this plugin's native module (native/index.ts), reached
 * over IPC. The key must match the plugin name registered with Vencord:
 * `MyaxPluginStore`.
 */
export const Native = VencordNative.pluginHelpers.MyaxPluginStore as PluginNative<typeof import("./native")>;

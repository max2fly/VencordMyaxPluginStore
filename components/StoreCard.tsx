/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { Text } from "@components/Text";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";

import type { InstallState, PluginEntry } from "../types";

const cl = classNameFactory("vc-myax-");

const OP_LABEL: Record<Extract<InstallState, { kind: "busy"; }>["op"], string> = {
    installing: "Installing…",
    updating: "Updating…",
    uninstalling: "Uninstalling…"
};

interface StoreCardProps {
    entry: PluginEntry;
    state: InstallState;
    onInstall(): void;
    onUpdate(): void;
    onUninstall(): void;
}

function SourceBadge({ source }: { source: PluginEntry["source"]; }) {
    const isAuthor = source === "author";
    return (
        <div
            className={cl("badge")}
            style={{ backgroundColor: isAuthor ? "var(--brand-500)" : "var(--green-360)" }}
        >
            {isAuthor ? "max2fly" : "Recommended"}
        </div>
    );
}

function Actions({ state, onInstall, onUpdate, onUninstall }: Omit<StoreCardProps, "entry">) {
    switch (state.kind) {
        case "not-installed":
            return (
                <Button size="small" onClick={onInstall}>
                    Install
                </Button>
            );

        case "installed":
            return (
                <div className={cl("actions")}>
                    {state.updateAvailable
                        ? (
                            <Button size="small" variant="positive" onClick={onUpdate}>
                                Update
                            </Button>
                        )
                        : (
                            <Button size="small" variant="secondary" disabled>
                                Installed
                            </Button>
                        )}
                    <Button size="small" variant="dangerSecondary" onClick={onUninstall}>
                        Uninstall
                    </Button>
                </div>
            );

        case "incompatible":
            // Platform-incompatible is installable behind a warning confirm; the
            // reason stays visible in the badge. Deps-incompatible stays disabled.
            return state.installable
                ? (
                    <Button size="small" variant="dangerPrimary" onClick={onInstall}>
                        Install
                    </Button>
                )
                : (
                    <Button size="small" variant="secondary" disabled>
                        {state.reason}
                    </Button>
                );

        case "busy":
            return (
                <Button size="small" variant="secondary" disabled>
                    {OP_LABEL[state.op]}
                </Button>
            );
    }
}

export function StoreCard({ entry, state, onInstall, onUpdate, onUninstall }: StoreCardProps) {
    const updateAvailable = state.kind === "installed" && state.updateAvailable;

    return (
        <div className={classes("vc-addon-card", cl("card"))}>
            <div className="vc-addon-header">
                <div className="vc-addon-name-author">
                    <Text weight="bold" className="vc-addon-name">
                        <div className={cl("title")}>{entry.displayName}</div>
                        <SourceBadge source={entry.source} />
                    </Text>
                    <Paragraph size="md" className="vc-addon-author">
                        {entry.author}
                    </Paragraph>
                </div>
            </div>

            <Paragraph className="vc-addon-note">{entry.description}</Paragraph>

            {(updateAvailable || state.kind === "incompatible") && (
                <div className={cl("tags")}>
                    {updateAvailable && (
                        <div className={cl("badge")} style={{ backgroundColor: "var(--yellow-300)" }}>
                            Update available
                        </div>
                    )}
                    {state.kind === "incompatible" && (
                        <div className={classes(cl("badge"), cl("badge-incompat"))}>
                            <span className={cl("blip")} />
                            {state.reason}
                        </div>
                    )}
                </div>
            )}

            <div className={cl("footer")}>
                <Actions
                    state={state}
                    onInstall={onInstall}
                    onUpdate={onUpdate}
                    onUninstall={onUninstall}
                />
            </div>
        </div>
    );
}

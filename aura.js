(() => {
    if (window.__chaosAuraStandaloneInstalled) {
        console.warn("[ChaosAura] Already installed.");
        return;
    }
    window.__chaosAuraStandaloneInstalled = true;

    const config = {
        enabled: true,
        retribution: true,
        itemsOnly: true, // true = only Item* groups, false = any appearance diff
        delayMs: 150, // delay after incoming sync before reverting/syncing
        whiteList: [] // MemberNumbers to ignore, e.g. [12345]
    };

    let lastAppearance = typeof ServerAppearanceBundle === "function"
        ? ServerAppearanceBundle(Player.Appearance)
        : null;
    let lastPose = Array.isArray(Player.ActivePose) ? [...Player.ActivePose] : [];
    let pendingTimer = null;

    function snapshotCurrent() {
        if (typeof ServerAppearanceBundle === "function") {
            lastAppearance = ServerAppearanceBundle(Player.Appearance);
        }
        lastPose = Array.isArray(Player.ActivePose) ? [...Player.ActivePose] : [];
    }

    function sendAction(text) {
        if (typeof ServerSend === "function") {
            ServerSend("ChatRoomChat", {
                Content: text,
                Type: "Action"
            });
        }
    }

    function findTargetCharacter(memberNumber) {
        if (typeof memberNumber !== "number") return null;
        if (Array.isArray(ChatRoomCharacter)) {
            const found = ChatRoomCharacter.find((c) => c.MemberNumber === memberNumber);
            if (found) return found;
        }
        if (Array.isArray(Character)) {
            return Character.find((c) => c.MemberNumber === memberNumber) || null;
        }
        return null;
    }

    function getNicknameSafe(c) {
        if (!c) return "Unknown";
        if (typeof CharacterNickname === "function") return CharacterNickname(c);
        return c.Nickname || c.Name || `Player ${c.MemberNumber ?? "Unknown"}`;
    }

    function syncItemRemovalToServerAndRoom(itemGroup) {
        if (typeof InventoryRemove === "function") {
            InventoryRemove(Player, itemGroup, false);
        }
        if (typeof CharacterRefresh === "function") {
            CharacterRefresh(Player, false);
        }
        if (typeof ChatRoomCharacterItemUpdate === "function") {
            ChatRoomCharacterItemUpdate(Player, itemGroup);
        } else if (typeof ServerSend === "function") {
            ServerSend("ChatRoomCharacterUpdate", {
                ID: Player.OnlineID,
                ActivePose: lastPose,
                Appearance: typeof ServerAppearanceBundle === "function"
                    ? ServerAppearanceBundle(Player.Appearance)
                    : undefined
            });
        }
    }

    function applySelfRevertAndRetribution(attackerMemberNumber) {
        if (!config.enabled || !lastAppearance || typeof ServerAppearanceBundle !== "function") {
            snapshotCurrent();
            return;
        }
        if (typeof attackerMemberNumber === "number" && config.whiteList.includes(attackerMemberNumber)) {
            snapshotCurrent();
            return;
        }

        const currentAppearance = ServerAppearanceBundle(Player.Appearance);
        const currentPose = Array.isArray(Player.ActivePose) ? [...Player.ActivePose] : [];

        const groupFilter = (item) =>
            config.itemsOnly ? typeof item.Group === "string" && item.Group.startsWith("Item") : true;

        const beforeFiltered = JSON.stringify(lastAppearance.filter(groupFilter));
        const afterFiltered = JSON.stringify(currentAppearance.filter(groupFilter));

        if (beforeFiltered === afterFiltered && JSON.stringify(lastPose) === JSON.stringify(currentPose)) {
            snapshotCurrent();
            return;
        }

        const beforeSet = new Set(lastAppearance.filter(groupFilter).map((i) => JSON.stringify(i)));
        const addedItems = currentAppearance
            .filter(groupFilter)
            .filter((i) => !beforeSet.has(JSON.stringify(i)));

        const affectedGroups = new Set(addedItems.map((item) => item.Group));
        for (const group of affectedGroups) {
            syncItemRemovalToServerAndRoom(group);
        }

        if (JSON.stringify(lastPose) !== JSON.stringify(currentPose) && typeof ServerSend === "function") {
            Player.ActivePose = [...lastPose];
            if (typeof CharacterRefresh === "function") {
                CharacterRefresh(Player, false);
            }
            ServerSend("ChatRoomCharacterPoseUpdate", { Pose: lastPose });
        }

        const attacker = findTargetCharacter(attackerMemberNumber);
        const attackerName = attacker ? getNicknameSafe(attacker) : `Player ${attackerMemberNumber ?? "Unknown"}`;
        const playerName = getNicknameSafe(Player);

        sendAction(`${attackerName} tried to touch ${playerName}, but ${playerName} was protected by some kind of dark aura`);

        // Retribution: return added items (except ItemHandheld) to attacker if allowed
        const retriableItems = addedItems.filter((item) => item.Group !== "ItemHandheld");
        const canRetribute =
            config.retribution &&
            attacker &&
            attacker.MemberNumber !== Player.MemberNumber &&
            retriableItems.length > 0 &&
            (typeof ServerChatRoomGetAllowItem !== "function" || ServerChatRoomGetAllowItem(Player, attacker));

        if (canRetribute && typeof ServerAppearanceBundle === "function") {
            sendAction(`Retribution: Used restraints are returned to ${attackerName}`);
            ServerSend("ChatRoomCharacterUpdate", {
                ID: attacker.OnlineID ?? attacker.AccountName?.replace("Online-", ""),
                ActivePose: attacker.ActivePose,
                Appearance: ServerAppearanceBundle(attacker.Appearance).concat(retriableItems)
            });
        }

        snapshotCurrent();
    }

    function scheduleSelfRevert(attackerMemberNumber) {
        if (!config.enabled) {
            snapshotCurrent();
            return;
        }
        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
        }
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            applySelfRevertAndRetribution(attackerMemberNumber);
        }, Math.max(0, Number(config.delayMs) || 0));
    }

    if (typeof bcModSDK !== "undefined" && typeof bcModSDK.registerMod === "function") {
        const mod = bcModSDK.registerMod({
            name: "ChaosAuraStandalone",
            fullName: "Chaos Aura Standalone",
            version: "1.0.3"
        });

        mod.hookFunction("ChatRoomSyncItem", 0, (args, next) => {
            const ret = next(args);
            const data = args[0];
            if (data?.Item?.Target === Player.MemberNumber) {
                scheduleSelfRevert(data?.Source);
            } else {
                snapshotCurrent();
            }
            return ret;
        });

        mod.hookFunction("ChatRoomSyncSingle", 0, (args, next) => {
            const ret = next(args);
            const data = args[0];
            if (data?.Character?.MemberNumber === Player.MemberNumber) {
                scheduleSelfRevert(data?.SourceMemberNumber);
            } else {
                snapshotCurrent();
            }
            return ret;
        });

        mod.hookFunction("ChatRoomCharacterItemUpdate", 0, (args, next) => {
            const ret = next(args);
            const [target] = args;
            if (target?.MemberNumber === Player.MemberNumber && pendingTimer === null) {
                snapshotCurrent();
            }
            return ret;
        });
    } else {
        const origSyncItem = window.ChatRoomSyncItem;
        if (typeof origSyncItem === "function") {
            window.ChatRoomSyncItem = function (...args) {
                const ret = origSyncItem.apply(this, args);
                const data = args[0];
                if (data?.Item?.Target === Player.MemberNumber) {
                    scheduleSelfRevert(data?.Source);
                } else {
                    snapshotCurrent();
                }
                return ret;
            };
        }

        const origSyncSingle = window.ChatRoomSyncSingle;
        if (typeof origSyncSingle === "function") {
            window.ChatRoomSyncSingle = function (...args) {
                const ret = origSyncSingle.apply(this, args);
                const data = args[0];
                if (data?.Character?.MemberNumber === Player.MemberNumber) {
                    scheduleSelfRevert(data?.SourceMemberNumber);
                } else {
                    snapshotCurrent();
                }
                return ret;
            };
        }
    }

    window.__chaosAuraConfig = config;
    window.__chaosAuraSnapshot = snapshotCurrent;
    console.log("[ChaosAura] Standalone v1.0.3 loaded.");
})();

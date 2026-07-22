import { ScreenWidth } from "openchat-shared";
import { routeStore } from "../path/stores";
import {
    autoSelectDefaultChatAllowed,
    dimensions,
    fullWidth,
    layout,
    mobileWidth,
    mountedV2Layout,
    rightPanelHistory,
    screenWidth,
} from "./stores";

describe("layout stores", () => {
    beforeEach(() => {
        routeStore.set({ kind: "chat_list_route", scope: { kind: "chats" } });
        dimensions.set({ width: 100, height: 100 });
        mountedV2Layout.set(false);
        rightPanelHistory.set([]);
    });

    test("screenWidth", () => {
        screenWidth.subscribe((_) => {});
        expect(screenWidth.value).toEqual(ScreenWidth.ExtraExtraSmall);
        dimensions.set({ width: 900, height: 100 });
        expect(screenWidth.value).toEqual(ScreenWidth.Medium);
    });

    test("fullWidth", () => {
        fullWidth.subscribe((_) => {});
        expect(fullWidth.value).toEqual(false);
        dimensions.set({ width: 2000, height: 100 });
        expect(fullWidth.value).toEqual(true);
    });

    test("mobileWidth", () => {
        mobileWidth.subscribe((_) => {});
        expect(mobileWidth.value).toEqual(true);
        dimensions.set({ width: 2000, height: 100 });
        expect(mobileWidth.value).toEqual(false);
    });

    test("layout", () => {
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: false, showNav: true });
        dimensions.set({ width: 2000, height: 100 });
        expect(layout.value).toMatchObject({ showMiddle: true, showNav: true });
    });

    test("layout selected chat", () => {
        routeStore.set({
            kind: "global_chat_selected_route",
            chatId: { kind: "group_chat", groupId: "123456" },
            chatType: "group_chat",
            open: false,
            scope: { kind: "chats" },
        });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showNav: false });
        dimensions.set({ width: 2000, height: 100 });
        expect(layout.value).toMatchObject({ showMiddle: true, showNav: true });
        dimensions.set({ width: 100, height: 100 });
        expect(layout.value).toMatchObject({ showMiddle: true, showNav: false });
    });
});

// The v2 (components_mobile) tree is chosen ONCE at boot, but the window can later be
// resized to >=768px (maximize, un-dock devtools). The still-mounted v2 UI must keep the
// phone-style single-panel layout regardless of live width, otherwise back-from-chat
// auto-reselects the chat and the bottom bar renders squished into the left column.
describe("mounted v2 layout forces mobile branch", () => {
    beforeEach(() => {
        routeStore.set({ kind: "chat_list_route", scope: { kind: "chats" } });
        dimensions.set({ width: 100, height: 100 });
        mountedV2Layout.set(false);
        rightPanelHistory.set([]);
    });

    test("selected direct chat at width 2000 stays single-panel", () => {
        mountedV2Layout.set(true);
        routeStore.set({
            kind: "global_chat_selected_route",
            chatId: { kind: "direct_chat", userId: "abcdef" },
            chatType: "direct_chat",
            open: false,
            scope: { kind: "chats" },
        });
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showLeft: false });
    });

    test("chat list at width 2000 stays single-panel (full-width bottom bar)", () => {
        mountedV2Layout.set(true);
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showLeft: true, showMiddle: false });
    });

    test("selected group chat at width 2000 stays single-panel", () => {
        mountedV2Layout.set(true);
        routeStore.set({
            kind: "global_chat_selected_route",
            chatId: { kind: "group_chat", groupId: "123456" },
            chatType: "group_chat",
            open: false,
            scope: { kind: "chats" },
        });
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showLeft: false });
    });

    test("selected channel at width 2000 stays single-panel", () => {
        mountedV2Layout.set(true);
        routeStore.set({
            kind: "selected_channel_route",
            chatId: { kind: "channel", communityId: "abc", channelId: 123 },
            communityId: { kind: "community", communityId: "abc" },
            open: false,
            scope: { kind: "community", id: { kind: "community", communityId: "abc" } },
        });
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showLeft: false });
    });

    test("favourite-scoped chat at width 2000 stays single-panel", () => {
        mountedV2Layout.set(true);
        routeStore.set({
            kind: "favourites_route",
            chatId: { kind: "direct_chat", userId: "abcdef" },
            open: false,
            scope: { kind: "favourite" },
        });
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showLeft: false });
    });

    test("right panel stays hidden in mounted v2 even with right panel history", () => {
        mountedV2Layout.set(true);
        rightPanelHistory.set([{ kind: "group_details" }]);
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ rightPanel: "hidden" });
    });

    test("v1 desktop branch intact when mountedV2Layout is false", () => {
        routeStore.set({
            kind: "global_chat_selected_route",
            chatId: { kind: "direct_chat", userId: "abcdef" },
            chatType: "direct_chat",
            open: false,
            scope: { kind: "chats" },
        });
        dimensions.set({ width: 2000, height: 100 });
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ showMiddle: true, showLeft: true });
    });

    test("v1 mobile right panel still shows inline when mountedV2Layout is false", () => {
        rightPanelHistory.set([{ kind: "group_details" }]);
        layout.subscribe((_) => {});
        expect(layout.value).toMatchObject({ rightPanel: "inline" });
    });
});

describe("autoSelectDefaultChatAllowed", () => {
    beforeEach(() => {
        dimensions.set({ width: 100, height: 100 });
        mountedV2Layout.set(false);
    });

    test("not allowed at mobile width", () => {
        expect(autoSelectDefaultChatAllowed()).toBe(false);
    });

    test("allowed at desktop width when v2 not mounted (v1 desktop regression guard)", () => {
        dimensions.set({ width: 2000, height: 100 });
        expect(autoSelectDefaultChatAllowed()).toBe(true);
    });

    test("not allowed at desktop width when v2 is mounted", () => {
        mountedV2Layout.set(true);
        dimensions.set({ width: 2000, height: 100 });
        expect(autoSelectDefaultChatAllowed()).toBe(false);
    });
});

<script lang="ts">
    import {
        isTouchDevice,
        longpress,
        portalState,
        type Alignment,
        type LongpressAnimation,
        type Position,
    } from "component-lib";
    import { getAllContexts, mount, onDestroy, type Snippet } from "svelte";
    import Menu from "./Menu.svelte";
    import MenuWrapper from "./MenuWrapper.svelte";

    // TODO expand this into discriminated union (with kind property) to allow
    // additional longpress props to be attached directly with mode.
    type MobileMode = "longpress" | "tap";

    // This value is actually defined in global.scss!
    const OVERLAY_FADEOUT_DURATION = 250;

    interface Props {
        classString?: string;
        centered?: boolean;
        position?: Position;
        align?: Alignment;
        gutter?: number;
        children: Snippet;
        menuItems: Snippet;
        mobileMode?: MobileMode;
        disabled?: boolean;
        fill?: boolean;
        maskUI?: boolean;
        constrainMask?: string;
        withBgEffect?: boolean;
        longpressAnimation?: LongpressAnimation;
        longpressCooldown?: boolean;
        customContent?: boolean;
    }

    let props: Props = $props();
    let mobileMode = $derived(props.mobileMode ?? "tap");
    let menuItems = $derived(props.menuItems);
    let children = $derived(props.children);
    let disabled = $derived(props.disabled);
    let fill = $derived(props.fill ?? false);
    let maskUI = $derived(props.maskUI ?? false);

    let menu: HTMLElement;
    let open = $state(false);
    let useLongpress = $derived(mobileMode === "longpress" && isTouchDevice);
    // A "longpress" trigger on a NON-touch device (the mobile/v2 layout in a desktop browser, or the
    // desktop app) must NOT fall back to opening on a plain left-click: these triggers wrap content
    // that already handles clicks — ChatSummary wraps the whole chat row, whose Container onClick
    // selects the chat — so one click both opened the chat AND its context menu. Left-click stays with
    // the wrapped content; right-click is the desktop equivalent of a long press.
    let openOnClick = $derived(!useLongpress && mobileMode === "tap");
    let openOnContextMenu = $derived(!useLongpress && mobileMode === "longpress");
    let menuClone = $state<HTMLElement>();

    const rectRegistry = new WeakMap<HTMLElement, DOMRect>();
    const styleRegistry = new WeakMap<HTMLElement, string>();

    const context = getAllContexts();

    onDestroy(closeMenu);

    function click(e: MouseEvent | TouchEvent) {
        if (disabled) return;

        e.stopPropagation();
        if (open) {
            closeMenu();
        } else {
            showMenu();
        }
    }

    // Desktop stand-in for a long press: suppress the browser's own context menu and open ours.
    function contextMenu(e: MouseEvent) {
        if (disabled) return;
        e.preventDefault();
        click(e);
    }

    export function showMenu() {
        if (!menu) {
            console.log("Menu is not defined");
            return;
        }
        open = portalState.open(
            mount(MenuWrapper, {
                target: document.body,
                props: {
                    ...props,
                    children: wrappedMenuItems,
                    onClose: closeMenu,
                    trigger: menu,
                    positionReferenceElement: menuClone,
                },
                context,
            }),
            closeMenu,
        );
        activateMask(maskUI);
    }

    function closeMenu() {
        open = portalState.close();

        resetNodes();

        let overlay = document.getElementById("masked_overlay");
        if (overlay) {
            overlay.classList.remove("visible");
            overlay.classList.remove("active");
        }
    }

    function activateMask(opaque: boolean = true) {
        let overlay = document.getElementById("masked_overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "masked_overlay";
            document.body.appendChild(overlay);
        }
        overlay.classList.add("active");

        if (opaque) {
            // Create menu clone if one is not set. This would be in case the
            // scaling animation is disabled, or compatibility mode where
            // only the longpress handler is provided.
            if (!menuClone) cloneNode();

            // Get menu rect bounds, it was set within the cloneNode
            const sourceRect = rectRegistry.get(menu);

            if (menuClone && sourceRect) {
                const { parent, left, top, width, height } = calcRectValues(sourceRect);

                overlay.classList.add("visible");

                if (props.withBgEffect) {
                    // Only applied if bg effect is allowed
                    menu.classList.add("with_bg_effect");
                }

                // Insert cloned node, and keep the original node in memory!
                menu.parentElement?.insertBefore(menuClone, menu);
                menu.remove();

                // Apply custom styling to the menu...
                Object.assign(menu.style, {
                    position: "absolute",
                    top: `${top}px`,
                    left: `${left}px`,
                    width: `${width}px`,
                    height: `${height}px`,
                    margin: 0,
                    zIndex: 91,
                    pointerEvents: "auto",
                });

                // ... and re-attach within the overlay!
                parent.appendChild(menu);
            }
        }
    }

    // Note: when cloning a node that holds an SVG, if that svg has a clip path
    // that depends on unique ids, the svg may not render. If clip path can't
    // be removed, we'll need to add logic here to modify the ids in the cloned
    // node.
    function cloneNode() {
        menuClone = menu.cloneNode(true) as HTMLElement;
        menuClone.style.visibility = "hidden";

        // Prevents context menu from opening
        menu.addEventListener("contextmenu", (e) => e.preventDefault());

        const sourceRect = menu.getBoundingClientRect();
        const styleVals = menu.style.cssText;

        // Save rect properties
        rectRegistry.set(menu, sourceRect);
        styleRegistry.set(menu, styleVals);
    }

    function resetNodes() {
        if (props.withBgEffect) {
            menu.classList.add("collapse");
        }

        setTimeout(() => {
            if (!menuClone || !menu) return;

            // Restore the menu item looks...
            menu.remove();
            menu.style.cssText = styleRegistry.get(menu) ?? "";
            menu.classList.remove("with_bg_effect", "collapse");

            // insert menu to its previous place...
            menuClone.parentElement?.insertBefore(menu, menuClone);

            // Remove menu clone!
            menuClone?.remove();
            menuClone = undefined;
        }, OVERLAY_FADEOUT_DURATION);
    }

    function calcRectValues(sourceRect: DOMRect) {
        const parent = getParentElement();
        const parentRect = parent.getBoundingClientRect();

        return {
            parent,
            top: sourceRect.top - parentRect.top + parent.scrollTop,
            left: sourceRect.left - parentRect.left + parent.scrollLeft,
            width: sourceRect.width,
            height: sourceRect.height,
        };
    }

    function getParentElement() {
        return props.constrainMask
            ? document.getElementById(props.constrainMask) ?? document.body
            : document.body;
    }
</script>

{#snippet wrappedMenuItems()}
    <Menu centered={props.centered} customContent={props.customContent}>
        {@render menuItems()}
    </Menu>
{/snippet}

{#if useLongpress}
    <div
        class:fill
        class:open
        class={`menu-trigger noselect ${props.classString}`}
        bind:this={menu}
        use:longpress={{
            onlongpress: click,
            onpressactive: cloneNode,
            animation: props.longpressAnimation,
            cooldown: props.longpressCooldown,
            isOpen: open,
            disabled: disabled,
        }}>
        {@render children()}
    </div>
{:else}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class:fill
        class:open
        class={`menu-trigger ${props.classString}`}
        bind:this={menu}
        onclick={openOnClick ? click : undefined}
        oncontextmenu={openOnContextMenu ? contextMenu : undefined}>
        {@render children()}
    </div>
{/if}

<style lang="scss">
    .menu-trigger {
        cursor: pointer;
        &.noselect {
            user-select: none;
        }
        &.fill {
            width: 100%;
        }
    }
</style>

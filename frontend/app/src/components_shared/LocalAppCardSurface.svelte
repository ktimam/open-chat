<script lang="ts">
    import { onMount, tick, type Snippet } from "svelte";

    let {
        target,
        inline = false,
        open = true,
        onClose,
        children,
    }: {
        target?: HTMLElement;
        inline?: boolean;
        open?: boolean;
        onClose: () => void;
        children: Snippet;
    } = $props();
    let placedInline = $state(false);

    function available(element: HTMLElement): boolean {
        if (
            !element.isConnected ||
            element.matches(":disabled, input[type='hidden']") ||
            element.getAttribute("aria-disabled") === "true"
        )
            return false;
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
            if (
                current.hidden ||
                current.hasAttribute("inert") ||
                current.getAttribute("aria-hidden") === "true"
            )
                return false;
            const style = getComputedStyle(current);
            if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
            )
                return false;
            if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
                const summary = Array.from(current.children).find(
                    (child) => child.tagName === "SUMMARY",
                );
                if (!summary?.contains(element)) return false;
            }
        }
        return true;
    }

    // Modal-only focus lifecycle around the one live editor. Inline placement must never
    // install a focus trap or reset a pending editor value/caret by mounting another editor.
    function containModalFocus(node: HTMLElement, enabled: boolean) {
        const originalTabindex = node.getAttribute("tabindex");
        let active = false;
        let generation = 0;
        let origin: HTMLElement | undefined;
        const focus = (element: HTMLElement) => element.focus({ preventScroll: true });
        function tabbable() {
            return Array.from(
                node.querySelectorAll<HTMLElement>(
                    "a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable='true']",
                ),
            )
                .filter(
                    (element) =>
                        available(element) &&
                        (element.tabIndex >= 0 ||
                            (element.getAttribute("contenteditable") === "true" &&
                                !element.hasAttribute("tabindex"))),
                )
                .sort(
                    (left, right) =>
                        (left.tabIndex > 0 ? left.tabIndex : Infinity) -
                        (right.tabIndex > 0 ? right.tabIndex : Infinity),
                );
        }
        function focusContainer() {
            const dialog = node.querySelector<HTMLElement>('[role="dialog"]');
            if (dialog && available(dialog)) {
                focus(dialog);
                if (document.activeElement === dialog) return;
            }
            focus(tabbable()[0] ?? node);
        }
        function tab(event: KeyboardEvent) {
            if (
                !active ||
                !node.isConnected ||
                node.hidden ||
                event.defaultPrevented ||
                event.key !== "Tab" ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
            )
                return;
            const controls = tabbable();
            const current = controls.indexOf(document.activeElement as HTMLElement);
            if (!controls.length) {
                event.preventDefault();
                focusContainer();
            } else if (
                current < 0 ||
                (event.shiftKey ? current === 0 : current === controls.length - 1)
            ) {
                event.preventDefault();
                focus(event.shiftKey ? controls[controls.length - 1] : controls[0]);
            }
        }
        function restore() {
            // Do not steal focus if closing already moved it to another live control.
            if (document.activeElement !== document.body && !node.contains(document.activeElement))
                return;
            if (origin && available(origin)) {
                focus(origin);
                if (document.activeElement === origin) return;
            }
            {
                // The original trigger can disappear with a virtualized message. Return to
                // the document rather than leave focus inside a now-hidden editor.
                const body = document.body;
                const previous = body.getAttribute("tabindex");
                if (previous === null) body.setAttribute("tabindex", "-1");
                focus(body);
                if (previous === null) body.removeAttribute("tabindex");
            }
        }
        function update(next: boolean) {
            if (active === next) return;
            active = next;
            const scheduled = ++generation;
            if (next) {
                node.setAttribute("tabindex", "-1");
                const previous = document.activeElement;
                origin =
                    previous instanceof HTMLElement &&
                    previous !== document.body &&
                    !node.contains(previous)
                        ? previous
                        : undefined;
                document.addEventListener("keydown", tab);
                void tick().then(() => {
                    if (
                        active &&
                        generation === scheduled &&
                        node.isConnected &&
                        !node.hidden &&
                        !node.contains(document.activeElement)
                    )
                        focusContainer();
                });
            } else {
                document.removeEventListener("keydown", tab);
                restore();
                origin = undefined;
                if (originalTabindex === null) node.removeAttribute("tabindex");
                else node.setAttribute("tabindex", originalTabindex);
            }
        }
        update(enabled);
        return { update, destroy: () => update(false) };
    }

    // Move the one host-owned editor; never create an editor per virtualized message.
    // Losing a message anchor returns the same live controls to their hidden home.
    function place(node: HTMLElement, destination: HTMLElement | undefined) {
        const home = document.createComment("private-card-editor-home");
        node.before(home);
        function move(next: HTMLElement | undefined) {
            if (next?.isConnected && next !== node && !node.contains(next)) {
                next.appendChild(node);
                placedInline = true;
            } else {
                home.parentNode?.insertBefore(node, home.nextSibling);
                placedInline = false;
            }
        }
        move(destination);
        return {
            update: move,
            destroy() {
                node.remove();
                home.remove();
            },
        };
    }

    function dismissOutside(event: MouseEvent) {
        if (!inline && open && event.target === event.currentTarget) onClose();
    }
    function escape(event: KeyboardEvent) {
        if (open && event.key === "Escape") onClose();
    }
    function popState() {
        onClose();
    }
    onMount(() => {
        window.addEventListener("popstate", popState);
        return () => window.removeEventListener("popstate", popState);
    });
</script>

<svelte:window onkeydown={escape} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    use:place={inline ? target : undefined}
    use:containModalFocus={!inline && open}
    class="card-surface"
    class:inline
    class:modal={!inline}
    hidden={!open || (inline && !placedInline)}
    onmousedown={dismissOutside}
>
    {@render children()}
</div>

<style lang="scss">
    .card-surface[hidden] {
        display: none;
    }
    .inline {
        width: min(420px, 100%);
        max-width: 100%;
        min-width: 0;
        box-sizing: border-box;
    }
    .modal {
        @include z-index("overlay");
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        backdrop-filter: var(--modal-filter);
        background: rgba(0, 0, 0, 0.5);
    }
    @include mobile() {
        .inline {
            width: 100%;
        }
        .modal {
            align-items: flex-end;
        }
    }
</style>

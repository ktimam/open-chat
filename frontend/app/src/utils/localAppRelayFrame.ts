/** The relay is a fixed top-level transport shell. Only its build-pinned app origin may load. */
export function validateLocalAppFrameDestination(destination: string): void {
    const configured = document.body.dataset.appOrigin;
    const target = new URL(destination);
    if (
        window.top !== window ||
        !configured ||
        new URL(configured).origin !== configured ||
        target.origin !== configured ||
        target.username ||
        target.password ||
        (target.protocol !== "https:" &&
            !(
                target.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
            ))
    ) {
        throw new Error("The app destination does not match this client configuration");
    }
}

export function openLocalAppFrame(frame: HTMLIFrameElement, destination: string): Window {
    validateLocalAppFrameDestination(destination);
    frame.src = destination;
    const receiver = frame.contentWindow;
    if (!receiver) throw new Error("The app could not be opened");
    frame.hidden = false;
    return receiver;
}

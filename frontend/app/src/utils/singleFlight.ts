// Drop duplicate triggers while one async action is running and expose its lifecycle to the UI.
// Concurrent callers share the same promise; success and failure both release the next invocation.
export function createSingleFlight(
    task: () => Promise<void>,
    onBusyChange: (busy: boolean) => void,
): () => Promise<void> {
    let inFlight: Promise<void> | undefined;

    return function run(): Promise<void> {
        if (inFlight !== undefined) return inFlight;

        onBusyChange(true);
        const tracked: Promise<void> = Promise.resolve()
            .then(task)
            .finally(() => {
                if (inFlight === tracked) {
                    inFlight = undefined;
                    onBusyChange(false);
                }
            });
        inFlight = tracked;
        return tracked;
    };
}

// Drop duplicate triggers while one async action is running and expose its lifecycle to the UI.
// Concurrent callers share the same promise; success and failure both release the next invocation.
export function createSingleFlight<Args extends unknown[], Result>(
    task: (...args: Args) => Promise<Result>,
    onBusyChange: (busy: boolean) => void,
): (...args: Args) => Promise<Result> {
    let inFlight: Promise<Result> | undefined;

    return function run(...args: Args): Promise<Result> {
        if (inFlight !== undefined) return inFlight;

        onBusyChange(true);
        const tracked: Promise<Result> = Promise.resolve()
            .then(() => task(...args))
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

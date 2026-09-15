export function autoProposeIdentityKey(
    chatKey: string,
    threadRootMessageIndex: number | undefined,
    messageId: bigint,
): string {
    return JSON.stringify([chatKey, threadRootMessageIndex ?? null, messageId.toString()]);
}

export class AutoProposeEvaluationTracker {
    private readonly evaluated = new Set<string>();
    private readonly evaluating = new Set<string>();

    claim(chatKey: string, threadRootMessageIndex: number | undefined, messageId: bigint): boolean {
        const key = this.key(chatKey, threadRootMessageIndex, messageId);
        if (this.evaluated.has(key) || this.evaluating.has(key)) return false;
        this.evaluating.add(key);
        return true;
    }

    finish(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        messageId: bigint,
        completed: boolean,
    ): void {
        const key = this.key(chatKey, threadRootMessageIndex, messageId);
        this.evaluating.delete(key);
        if (completed) this.evaluated.add(key);
    }

    clear(): void {
        this.evaluated.clear();
        this.evaluating.clear();
    }

    private key(chatKey: string, threadRootMessageIndex: number | undefined, messageId: bigint) {
        return autoProposeIdentityKey(chatKey, threadRootMessageIndex, messageId);
    }
}

function eventContextKey(chatKey: string, threadRootMessageIndex: number | undefined): string {
    return JSON.stringify([chatKey, threadRootMessageIndex ?? null]);
}

/**
 * Authoritative event-index watermarks for the current observation session. Unlike timestamps,
 * event indices share the canister stream's ordering and do not depend on the browser wall clock.
 */
export class AutoProposeEventWatermarks {
    private readonly latest = new Map<string, number>();
    private readonly activeRegistration = new Map<string, number>();
    private nextRegistration = 0;

    registerBoundary(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        latestEventIndex: number,
    ): number | undefined {
        if (!Number.isSafeInteger(latestEventIndex) || latestEventIndex < -1) return undefined;
        const key = eventContextKey(chatKey, threadRootMessageIndex);
        const registration = ++this.nextRegistration;
        const previous = this.latest.get(key);
        // A new mount/context activation establishes a fresh authoritative baseline. Never lower a
        // live boundary when two component lifetimes briefly overlap during a transition.
        this.latest.set(
            key,
            previous === undefined ? latestEventIndex : Math.max(previous, latestEventIndex),
        );
        this.activeRegistration.set(key, registration);
        return registration;
    }

    unregisterBoundary(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        registration: number | undefined,
    ): void {
        const key = eventContextKey(chatKey, threadRootMessageIndex);
        // An old component's delayed cleanup cannot delete a newer component's registration.
        if (registration === undefined || this.activeRegistration.get(key) !== registration) return;
        this.activeRegistration.delete(key);
        this.latest.delete(key);
    }

    isActiveRegistration(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        registration: number | undefined,
    ): boolean {
        return (
            registration !== undefined &&
            this.activeRegistration.get(eventContextKey(chatKey, threadRootMessageIndex)) ===
                registration
        );
    }

    observeSent(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        eventIndex: number,
        registration: number | undefined,
    ): boolean {
        const key = eventContextKey(chatKey, threadRootMessageIndex);
        if (
            registration === undefined ||
            this.activeRegistration.get(key) !== registration ||
            !Number.isSafeInteger(eventIndex) ||
            eventIndex < 0
        )
            return false;
        const previous = this.latest.get(key);
        if (previous === undefined || eventIndex > previous) this.latest.set(key, eventIndex);
        return previous !== undefined && eventIndex > previous;
    }

    observeLoadedNew<T extends { index: number }>(
        chatKey: string,
        threadRootMessageIndex: number | undefined,
        events: readonly T[],
        registration: number | undefined,
    ): T[] {
        const key = eventContextKey(chatKey, threadRootMessageIndex);
        // A queued callback from a switched/unmounted list must not recreate or consume a closed
        // stream. Only the exact currently active component registration may advance this state.
        if (registration === undefined || this.activeRegistration.get(key) !== registration) {
            return [];
        }
        const valid = events.filter(
            (event) => Number.isSafeInteger(event.index) && event.index >= 0,
        );
        const latestInWindow = valid.reduce<number | undefined>(
            (latest, event) =>
                latest === undefined || event.index > latest ? event.index : latest,
            undefined,
        );
        const boundary = this.latest.get(key);
        if (boundary === undefined) {
            // HMR or a missing subscription prime must fail closed: the first observed window is a
            // baseline, never a source of exact texts. A subsequent forward window can advance it.
            if (latestInWindow !== undefined) this.latest.set(key, latestInWindow);
            return [];
        }
        if (latestInWindow !== undefined && latestInWindow > boundary) {
            this.latest.set(key, latestInWindow);
        }
        return valid.filter((event) => event.index > boundary);
    }

    clear(): void {
        this.latest.clear();
        this.activeRegistration.clear();
    }
}

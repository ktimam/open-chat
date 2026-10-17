import type { Writable } from "@client";
import { createSubscriber } from "svelte/reactivity";

// Mounted component fixtures bridge the client's stores into Svelte's reactive props,
// without reintroducing svelte/store state alongside the production custom stores.
export function reactiveTestStore<T>(store: Writable<T>) {
    const subscribe = createSubscriber((update) => {
        let initial = true;
        const unsubscribe = store.subscribe(() => {
            if (!initial) update();
        });
        initial = false;
        return unsubscribe;
    });
    return {
        get current() {
            subscribe();
            return store.value;
        },
        set current(value: T) {
            store.set(value);
        },
    };
}

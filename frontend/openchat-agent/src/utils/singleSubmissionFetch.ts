/** A single account-link update may have committed even when its response is lost. */
export function createSingleSubmissionFetch(
    baseFetch: typeof fetch = (input, init) => fetch(input, init),
    deadline: AbortSignal = AbortSignal.timeout(45_000),
): typeof fetch {
    let submitted = false;
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const isSubmission = /^\/api\/v\d+\/canister\/[^/]+\/call$/.test(url.pathname);
        if (deadline.aborted || (isSubmission && submitted)) {
            throw new Error(
                "Account-link request outcome is unknown; automatic resubmission is disabled.",
            );
        }
        if (isSubmission) submitted = true;
        const signal = init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
        try {
            return await baseFetch(input, {
                ...init,
                signal,
                credentials: "omit",
                redirect: "error",
            });
        } catch {
            // SDK/provider errors can contain signed requests or codes. Never forward their payloads.
            throw new Error("Account-link request did not finish; its outcome may be unknown.");
        }
    };
}

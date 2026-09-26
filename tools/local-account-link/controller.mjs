import { verificationFailure, signInFailure } from './diagnostics.mjs';
/**
 * Pure account-link probe state machine. The adapter owns all signing identities.
 * verify/link/signIn resolve public state; clear synchronously invalidates pending work.
 * A cancelled pending operation must settle before another operation can start.
 * Credential metadata must contain PUBLIC data only; callers control its persistence.
 */
export class AccountLinkProbe {
    #adapter;
    #onChange;
    #state = { stage: "idle", message: "Enter an official linking code and the expected username." };
    #epoch = 0;
    #busy = false;
    #verifyUsed = false;
    #verified = false;
    #finalizeAttempted = false;
    #expectedUsername;
    #expectedUserId;
    #expectedOcPrincipal;
    #cleanup = Promise.resolve(true);

    constructor(adapter, onChange = () => {}, saved) {
        this.#adapter = adapter;
        this.#onChange = onChange;
        if (saved !== undefined) {
            if (!isText(saved.expectedUsername) || !isMetadata(saved.credential) ||
                (saved.expectedUserId !== undefined && !isText(saved.expectedUserId)) ||
                (saved.expectedOcPrincipal !== undefined && !isText(saved.expectedOcPrincipal))) {
                throw new TypeError("Invalid saved public probe metadata.");
            }
            this.#expectedUsername = saved.expectedUsername.trim();
            this.#expectedUserId = optionalText(saved.expectedUserId);
            this.#expectedOcPrincipal = optionalText(saved.expectedOcPrincipal);
            this.#verifyUsed = true;
            this.#state = {
                stage: "cleared",
                message: "Saved public credential loaded. Use a fresh passkey sign-in; linking will not be repeated.",
                verifiedUsername: this.#expectedUsername,
                credential: copy(saved.credential),
            };
        }
    }

    get state() {
        return copy(this.#state);
    }

    async verify(code, expectedUsername, expectedUserId) {
        if (this.#busy || this.#verifyUsed || this.#state.credential || this.#finalizeAttempted) {
            return this.state;
        }
        if (!isText(code) || !isText(expectedUsername) ||
            (expectedUserId !== undefined && !isText(expectedUserId))) {
            this.#set({ stage: "error", message: "A linking code and expected username are required; an optional User ID must not be blank." });
            return this.state;
        }
        const epoch = this.#epoch;
        this.#busy = true;
        this.#verifyUsed = true;
        this.#expectedUsername = expectedUsername.trim();
        this.#expectedUserId = optionalText(expectedUserId);
        this.#expectedOcPrincipal = undefined;
        this.#set({ stage: "verifying", message: "Verifying consumes the official linking code. No account link has been finalized." });
        try {
            if (!(await this.#cleanup)) throw new Error("Session cleanup failed.");
            if (!this.#current(epoch)) return this.state;
            const result = await this.#adapter.verify(code.trim());
            if (!this.#current(epoch)) return this.state;
            if (!isText(result?.username) || result.username !== this.#expectedUsername) {
                await this.#clean();
                if (this.#current(epoch)) {
                    this.#set({ stage: "mismatch", message: "The verified username did not match. No passkey was created and no account link was finalized." });
                }
                return this.state;
            }
            this.#verified = true;
            this.#set({ stage: "verified", message: "Username matched. Linking requires a separate explicit action and permanently adds a passkey.", verifiedUsername: result.username });
        } catch (error) {
            await this.#clean();
            if (this.#current(epoch)) this.#set({ stage: "error", message: verificationFailure(error) });
        } finally {
            if (!this.#current(epoch)) await this.#clean();
            this.#busy = false;
        }
        return this.state;
    }

    async link() {
        if (this.#busy || !this.#verified || this.#state.credential || this.#finalizeAttempted) return this.state;
        const epoch = this.#epoch;
        this.#busy = true;
        this.#verified = false;
        this.#set({ stage: "linking", message: "Creating a localhost passkey, then explicitly linking it to the verified account." });
        try {
            const credential = await this.#adapter.createPasskey(this.#expectedUsername);
            if (!this.#current(epoch)) return this.state;
            if (!isMetadata(credential)) throw new TypeError("Invalid credential metadata.");
            this.#set({ credential: copy(credential) });
            if (!this.#current(epoch)) return this.state;
            // A write may have committed even when its response is lost. Never repeat it.
            this.#finalizeAttempted = true;
            const profile = await this.#adapter.finalize(copy(credential));
            if (!this.#current(epoch)) return this.state;
            if (!this.#acceptProfile(profile)) {
                this.#set({ stage: "mismatch", message: "The linked account identity was missing or did not match. Stop; linking will not be retried." });
                return this.state;
            }
            this.#set({ stage: "linked", message: "The expected account was linked. A fresh passkey sign-in is still required to prove reauthentication.", profile: publicProfile(profile) });
        } catch {
            if (this.#current(epoch)) {
                this.#set({
                    stage: this.#finalizeAttempted ? "uncertain" : "error",
                    message: this.#finalizeAttempted
                        ? "Link finalization may have succeeded. Do not retry linking; use a fresh passkey sign-in to reconcile."
                        : "Passkey creation failed or was cancelled. No finalization was requested.",
                });
            }
        } finally {
            await this.#clean();
            this.#busy = false;
        }
        return this.state;
    }

    async signIn() {
        if (this.#busy || !this.#state.credential) return this.state;
        const epoch = this.#epoch;
        const credential = copy(this.#state.credential);
        this.#busy = true;
        this.#set({ stage: "signing_in", message: "Discarding prior sessions and requesting a fresh passkey assertion.", profile: undefined });
        try {
            if (!(await this.#clean())) throw new Error("Session cleanup failed.");
            if (!this.#current(epoch)) return this.state;
            const profile = await this.#adapter.freshSignIn(credential);
            if (!this.#current(epoch)) return this.state;
            if (!this.#acceptProfile(profile)) {
                this.#set({ stage: "mismatch", message: "Fresh sign-in returned a missing or different account identity. The probe did not pass." });
                return this.state;
            }
            this.#set({ stage: "signed_in", message: "Fresh passkey sign-in matched the expected account identity.", profile: publicProfile(profile) });
        } catch (error) {
            if (this.#current(epoch)) {
                this.#set({ stage: "error", message: signInFailure(error) });
            }
        } finally {
            await this.#clean();
            this.#busy = false;
        }
        return this.state;
    }

    clear() {
        this.#epoch += 1;
        this.#verified = false;
        if (!this.#state.credential && !this.#finalizeAttempted) this.#verifyUsed = false;
        this.#set({ stage: "cleared", message: "Local session cleared. Any server-side account link remains; public credential metadata is retained for fresh sign-in.", profile: undefined });
        void this.#clean();
        return this.state;
    }

    #acceptProfile(profile) {
        if (!isText(profile?.username) || !isText(profile?.userId) || !isText(profile?.ocPrincipal)) return false;
        if (profile.username !== this.#expectedUsername ||
            (this.#expectedUserId !== undefined && profile.userId !== this.#expectedUserId) ||
            (this.#expectedOcPrincipal !== undefined && profile.ocPrincipal !== this.#expectedOcPrincipal)) return false;
        this.#expectedUserId = profile.userId;
        this.#expectedOcPrincipal = profile.ocPrincipal;
        return true;
    }

    #current(epoch) { return epoch === this.#epoch; }

    #set(fields) {
        this.#state = { ...this.#state, ...fields };
        try { this.#onChange(this.state); } catch { /* Observers cannot alter the protocol. */ }
    }

    #clean() {
        const work = async () => {
            let ok = true;
            try { await this.#adapter.clearSession(); } catch { ok = false; }
            try { await this.#adapter.forgetAttempt?.(); } catch { ok = false; }
            return ok;
        };
        this.#cleanup = this.#cleanup.then(work, work);
        return this.#cleanup;
    }
}

function isText(value) { return typeof value === "string" && value.trim().length > 0; }
function optionalText(value) { return isText(value) ? value.trim() : undefined; }
function isMetadata(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function copy(value) { return structuredClone(value); }
function publicProfile(profile) { return { username: profile.username, userId: profile.userId, ocPrincipal: profile.ocPrincipal }; }

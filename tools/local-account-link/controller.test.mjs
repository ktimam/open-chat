import test from "node:test";
import assert from "node:assert/strict";
import { AccountLinkProbe } from "./controller.mjs";

const profile = { username: "alice", userId: "existing-user-id", ocPrincipal: "existing-oc-principal" };
const credential = { credentialId: "public-credential-id", publicKey: "public-key", rpId: "localhost" };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}, saved) {
    const calls = [];
    const adapter = Object.fromEntries(Object.entries({
        verify: async () => ({ username: "alice" }),
        createPasskey: async () => credential,
        finalize: async () => profile,
        freshSignIn: async () => profile,
        clearSession: () => {},
        forgetAttempt: () => {},
        ...overrides,
    }).map(([name, fn]) => [name, (...args) => { calls.push({ name, args }); return fn(...args); }]));
    const states = [];
    const probe = new AccountLinkProbe(adapter, (state) => states.push(state), saved);
    return { probe, calls, states, count: (name) => calls.filter((call) => call.name === name).length };
}

test("requires expected username and keeps code/private adapter fields out of state", async () => {
    const f = fixture({ verify: async () => ({ username: "alice", tempKey: "secret-key" }), finalize: async () => ({ ...profile, jwt: "secret-jwt" }) });
    await f.probe.verify("secret-code", "");
    assert.equal(f.count("verify"), 0);
    await f.probe.verify("secret-code", "alice", profile.userId);
    assert.equal(f.probe.state.stage, "verified");
    assert.equal(f.count("createPasskey"), 0);
    await f.probe.link();
    assert.equal(f.probe.state.stage, "linked");
    assert.doesNotMatch(JSON.stringify(f.states), /secret-code|secret-key|secret-jwt/);
});

test("wrong username never creates or finalizes a passkey", async () => {
    const f = fixture({ verify: async () => ({ username: "bob" }) });
    await f.probe.verify("code", "alice");
    await f.probe.link();
    await f.probe.verify("another-code", "alice");
    assert.equal(f.probe.state.stage, "mismatch");
    assert.equal(f.count("verify"), 1);
    assert.equal(f.count("createPasskey"), 0);
    assert.equal(f.count("finalize"), 0);
});

test("duplicate verification and linking clicks cannot repeat writes", async () => {
    const verified = deferred(), finalized = deferred();
    const f = fixture({ verify: () => verified.promise, finalize: () => finalized.promise });
    const first = f.probe.verify("code", "alice");
    await tick();
    await f.probe.verify("code", "alice");
    assert.equal(f.count("verify"), 1);
    verified.resolve({ username: "alice" });
    await first;
    const link = f.probe.link();
    await tick();
    await f.probe.link();
    assert.equal(f.count("createPasskey"), 1);
    assert.equal(f.count("finalize"), 1);
    finalized.resolve(profile);
    await link;
    await f.probe.link();
    assert.equal(f.count("finalize"), 1);
});

test("ambiguous finalize preserves public credential and reconciles only through fresh sign-in", async () => {
    const f = fixture({ finalize: async () => { throw new Error("secret-code network response lost"); } });
    await f.probe.verify("code", "alice", profile.userId);
    await f.probe.link();
    assert.equal(f.probe.state.stage, "uncertain");
    assert.deepEqual(f.probe.state.credential, credential);
    assert.doesNotMatch(f.probe.state.message, /secret-code/);
    await f.probe.link();
    f.probe.clear();
    await f.probe.verify("new-code", "alice");
    assert.equal(f.count("verify"), 1);
    assert.equal(f.count("finalize"), 1);
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "signed_in");
});

for (const [label, bad] of [
    ["missing User ID", { ...profile, userId: undefined }],
    ["wrong User ID", { ...profile, userId: "wrong-user-id" }],
    ["wrong username", { ...profile, username: "bob" }],
    ["missing OC principal", { ...profile, ocPrincipal: "" }],
]) {
    test(`initial profile rejects ${label}`, async () => {
        const f = fixture({ finalize: async () => bad });
        await f.probe.verify("code", "alice", profile.userId);
        await f.probe.link();
        assert.equal(f.probe.state.stage, "mismatch");
        assert.equal(f.probe.state.profile, undefined);
        await f.probe.link();
        assert.equal(f.count("finalize"), 1);
    });
}

test("fresh login clears prior sessions and compares learned identity even without initial expected User ID", async () => {
    let result = profile;
    const f = fixture({ freshSignIn: async () => result });
    await f.probe.verify("code", "alice");
    await f.probe.link();
    f.probe.clear();
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "signed_in");
    const loginIndex = f.calls.findIndex((call) => call.name === "freshSignIn");
    assert.equal(f.calls[loginIndex - 2].name, "clearSession");
    assert.equal(f.calls[loginIndex - 1].name, "forgetAttempt");
    result = { ...profile, ocPrincipal: "different-principal" };
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "mismatch");
    assert.equal(f.probe.state.profile, undefined);
});

test("cancelled verification cannot produce a verified state or overlap a new attempt", async () => {
    const pending = deferred();
    const f = fixture({ verify: () => pending.promise });
    const first = f.probe.verify("code", "alice");
    await tick();
    f.probe.clear();
    await f.probe.verify("new-code", "alice");
    assert.equal(f.count("verify"), 1);
    pending.resolve({ username: "alice" });
    await first;
    assert.equal(f.probe.state.stage, "cleared");
    await f.probe.link();
    assert.equal(f.count("createPasskey"), 0);
});

test("cancelled passkey creation never starts finalization after late completion", async () => {
    const pending = deferred();
    const f = fixture({ createPasskey: () => pending.promise });
    await f.probe.verify("code", "alice");
    const link = f.probe.link();
    f.probe.clear();
    pending.resolve(credential);
    await link;
    assert.equal(f.probe.state.stage, "cleared");
    assert.equal(f.count("finalize"), 0);
});

test("cancelled finalization keeps public reconciliation metadata but ignores late success", async () => {
    const pending = deferred();
    const f = fixture({ finalize: () => pending.promise });
    await f.probe.verify("code", "alice", profile.userId);
    const link = f.probe.link();
    await tick();
    f.probe.clear();
    pending.resolve(profile);
    await link;
    assert.equal(f.probe.state.stage, "cleared");
    assert.equal(f.probe.state.profile, undefined);
    assert.deepEqual(f.probe.state.credential, credential);
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "signed_in");
});

test("cancelled fresh login cannot resurrect an authenticated state", async () => {
    const pending = deferred();
    const f = fixture({ freshSignIn: () => pending.promise }, { credential, expectedUsername: "alice", expectedUserId: profile.userId, expectedOcPrincipal: profile.ocPrincipal });
    const signin = f.probe.signIn();
    await tick();
    f.probe.clear();
    pending.resolve(profile);
    await signin;
    assert.equal(f.probe.state.stage, "cleared");
    assert.equal(f.probe.state.profile, undefined);
});

test("saved public metadata supports restart sign-in but never relinking", async () => {
    const f = fixture({}, { credential, expectedUsername: "alice", expectedUserId: profile.userId, expectedOcPrincipal: profile.ocPrincipal });
    await f.probe.verify("code", "alice");
    await f.probe.link();
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "signed_in");
    assert.equal(f.count("verify"), 0);
    assert.equal(f.count("createPasskey"), 0);
    assert.equal(f.count("finalize"), 0);
    const snapshot = f.probe.state;
    snapshot.credential.publicKey = "changed";
    assert.equal(f.probe.state.credential.publicKey, "public-key");
});

test("cleanup failure prevents fresh login rather than reusing an old session", async () => {
    const f = fixture({ clearSession: () => { throw new Error("secret"); } }, { credential, expectedUsername: "alice", expectedUserId: profile.userId });
    await f.probe.signIn();
    assert.equal(f.probe.state.stage, "error");
    assert.equal(f.count("freshSignIn"), 0);
    assert.doesNotMatch(f.probe.state.message, /secret/);
});

test("failed cleanup after clearing also blocks a new verification", async () => {
    const f = fixture({ clearSession: () => { throw new Error("secret"); } });
    f.probe.clear();
    await f.probe.verify("code", "alice");
    assert.equal(f.probe.state.stage, "error");
    assert.equal(f.count("verify"), 0);
});

test("saved empty expected identity constraints are rejected instead of silently removed", () => {
    assert.throws(() => fixture({}, { credential, expectedUsername: "alice", expectedUserId: "" }), /Invalid saved/);
    assert.throws(() => fixture({}, { credential, expectedUsername: "alice", expectedOcPrincipal: " " }), /Invalid saved/);
});

test("observer-triggered clear at credential publication prevents finalization", async () => {
    let writes = 0;
    const adapter = {
        verify: async () => ({ username: "alice" }),
        createPasskey: async () => credential,
        finalize: async () => { writes += 1; return profile; },
        clearSession: () => {},
    };
    const probe = new AccountLinkProbe(adapter, (state) => {
        if (state.stage === "linking" && state.credential) probe.clear();
    });
    await probe.verify("code", "alice");
    await probe.link();
    assert.equal(probe.state.stage, "cleared");
    assert.equal(writes, 0);
});

test("verification failure and passkey cancellation have safe bounded behavior", async () => {
    const f = fixture({ verify: async () => { throw new Error("secret bearer"); } });
    await f.probe.verify("code", "alice");
    assert.equal(f.probe.state.stage, "error");
    assert.doesNotMatch(f.probe.state.message, /secret bearer/);
    const cancelled = fixture({ createPasskey: async () => { throw new Error("NotAllowedError"); } });
    await cancelled.probe.verify("code", "alice");
    await cancelled.probe.link();
    assert.equal(cancelled.probe.state.stage, "error");
    assert.equal(cancelled.count("finalize"), 0);
});

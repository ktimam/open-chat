import { HttpAgent, polling, DER_COSE_OID, unwrapDER } from '@icp-sdk/core/agent';
import { ECDSAKeyIdentity, WebAuthnIdentity, Delegation, DelegationChain, DelegationIdentity } from '@icp-sdk/core/identity';
import { Principal } from '@icp-sdk/core/principal';
import { Packr } from 'msgpackr';
import { HOST, IDENTITY, USER_INDEX, TTL_NS, RP_ID, assertRpc, bytes, principalBytes, authDataToCose } from './policy.mjs';
import { ProbeFailure, SignInFailure } from './diagnostics.mjs';
import { PickerWebAuthnIdentity } from './picker-passkey.mjs';

const codec = new Packr({ useRecords: false, skipValues: [null, undefined], largeBigIntToString: true, copyBuffers: true });
const der = identity => new Uint8Array(identity.getPublicKey().toDer());
function principal(value) {
  return typeof value === 'string' ? Principal.fromText(value).toText() : Principal.fromUint8Array(principalBytes(value)).toText();
}
function success(reply, method) {
  if (reply && typeof reply === 'object' && Object.hasOwn(reply, 'Success')) return reply.Success;
  const appCode = Array.isArray(reply?.Error) ? reply.Error[0] : undefined;
  throw new ProbeFailure('reply', { appCode });
}
async function agentFor(identity, trace) {
  const options = { host: HOST, identity, verifyQuerySignatures: true, retryTimes: 0 };
  if (trace) options.fetch = async (url, init) => {
    try {
      // The SDK can internally resend after an ingress-clock correction even
      // with retryTimes: 0. A consumed linking code must have one submission.
      if (trace.phase === 'submit' && new URL(url).pathname.endsWith('/call')) {
        if (trace.submitted) throw new ProbeFailure('submit');
        trace.submitted = true;
      }
      const response = await fetch(url, { ...init, signal: trace.signal });
      if (!response.ok) { trace.httpStatus = response.status; trace.reason = 'http'; }
      return response;
    } catch {
      trace.reason = trace.reason || (trace.signal.aborted ? 'cancelled' : 'network');
      throw new ProbeFailure(trace.phase, trace);
    }
  };
  return HttpAgent.create(options);
}
async function rpc(agent, canister, method, args, mode, trace) {
  assertRpc(mode, canister, method);
  if (trace) trace.phase = 'encode';
  const arg = new Uint8Array(codec.pack(args));
  let response;
  try {
    if (mode === 'query') {
      const result = await agent.query(Principal.fromText(canister), { methodName: `${method}_msgpack`, arg });
      if (result.status !== 'replied') throw new Error('Query rejected');
      response = result.reply.arg;
    } else {
      // A single submission followed by certified polling. No automatic application
      // retries for consumed codes or uncertain credential-linking outcomes.
      if (trace) trace.phase = 'submit';
      const result = await agent.call(Principal.fromText(canister), {
        methodName: `${method}_msgpack`, arg, effectiveCanisterId: Principal.fromText(canister), callSync: false,
      });
      if (result.response.status !== 202) throw new Error('Unexpected update response');
      if (trace) trace.phase = 'confirm';
      response = (await polling.pollForResponse(agent, Principal.fromText(canister), result.requestId)).reply;
    }
    if (trace) trace.phase = 'decode';
    const replyBytes = new Uint8Array(response);
    if (replyBytes.length > 1024 * 1024) throw new Error('Response too large');
    return codec.unpack(replyBytes);
  } catch {
    // Never forward SDK exceptions: they can contain the code or authentication material.
    if (trace) throw new ProbeFailure(trace.phase, trace);
    throw new Error(`The ${method} request could not be completed. Its outcome may be unknown.`);
  } finally { arg.fill(0); }
}
export class LocalIdentityAdapter {
  #attempt;
  #epoch = 0;
  #pendingAbort;
  clearSession() { this.#epoch++; this.#attempt = undefined; this.#pendingAbort?.abort(); this.#pendingAbort = undefined; }
  forgetAttempt() { this.clearSession(); }
  async verify(code) {
    this.clearSession();
    const epoch = this.#epoch;
    const abort = new AbortController(); this.#pendingAbort = abort;
    const trace = { phase: 'key-setup', signal: abort.signal };
    let timer;
    const ensureCurrent = () => { if (epoch !== this.#epoch || abort.signal.aborted) throw new Error('Attempt cancelled'); };
    const work = async () => {
      const identity = await ECDSAKeyIdentity.generate(); ensureCurrent();
      trace.phase = 'client-setup';
      const agent = await agentFor(identity, trace); ensureCurrent();
      const username = success(await rpc(agent, IDENTITY, 'verify_account_linking_code', { code }, 'update', trace), 'code verification');
      ensureCurrent();
      if (typeof username !== 'string' || !username || username.length > 100) throw new ProbeFailure('reply');
      this.#attempt = { identity, agent, expires: Date.now() + 270000, epoch };
      return { username };
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { trace.reason = 'timeout'; abort.abort(); reject(new ProbeFailure(trace.phase, trace)); }, 45000);
      })]);
    } catch (error) {
      if (epoch !== this.#epoch) throw new Error('Attempt cancelled');
      throw error instanceof ProbeFailure ? error : new ProbeFailure(trace.phase, trace);
    } finally {
      clearTimeout(timer);
      if (this.#pendingAbort === abort) this.#pendingAbort = undefined;
    }
  }
  async createPasskey(username) {
    const attempt = this.#attempt;
    if (!attempt || Date.now() > attempt.expires) throw new Error('Obtain a fresh linking code');
    const credential = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: RP_ID, name: 'Unofficial OpenChat localhost test' },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: `${username} - localhost test`, displayName: `${username} (local test)` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none', timeout: 120000,
    } });
    if (attempt !== this.#attempt || attempt.epoch !== this.#epoch || Date.now() > attempt.expires) throw new Error('Attempt expired or cancelled');
    if (!credential || credential.type !== 'public-key') throw new Error('Passkey creation cancelled');
    const authData = new Uint8Array(credential.response.getAuthenticatorData());
    const expectedRpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)));
    if (!expectedRpHash.every((v, i) => authData[i] === v) || !(authData[32] & 4)) throw new Error('Unexpected passkey response');
    const cose = authDataToCose(authData);
    const attachment = credential.authenticatorAttachment === 'platform' ? 'platform' : 'cross-platform';
    const key = new WebAuthnIdentity(new Uint8Array(credential.rawId), cose, attachment);
    return { credentialId: Array.from(new Uint8Array(credential.rawId)), publicKey: Array.from(der(key)),
      crossPlatform: attachment === 'cross-platform', aaguid: Array.from(authData.slice(37, 53)), origin: RP_ID };
  }
  async finalize(metadata) {
    const attempt = this.#attempt;
    if (!attempt || Date.now() > attempt.expires) throw new Error('Linking attempt expired');
    const publicKey = bytes(metadata.publicKey);
    if (metadata.origin !== RP_ID) throw new Error('Wrong passkey origin');
    const session = await ECDSAKeyIdentity.generate();
    if (attempt !== this.#attempt) throw new Error('Attempt cancelled');
    try {
      const prepared = success(await rpc(attempt.agent, IDENTITY, 'finalise_account_linking_with_code', {
        principal: Principal.selfAuthenticating(publicKey).toUint8Array(), public_key: publicKey,
        session_key: der(session), max_time_to_live: TTL_NS,
        webauthn_key: { public_key: publicKey, credential_id: bytes(metadata.credentialId),
          origin: RP_ID, cross_platform: metadata.crossPlatform, aaguid: metadata.aaguid },
      }, 'update'), 'account linking');
      return await this.#profile(attempt.agent, session, prepared);
    } finally { if (this.#attempt === attempt) this.clearSession(); }
  }
  async freshSignIn(metadata) {
    this.clearSession();
    const epoch = this.#epoch;
    const abort = new AbortController(); this.#pendingAbort = abort;
    let step = 'restore-credential';
    try {
    if (metadata.origin !== RP_ID) throw new Error('Wrong passkey origin');
    const publicKey = bytes(metadata.publicKey);
    const passkey = new PickerWebAuthnIdentity(bytes(metadata.credentialId), unwrapDER(publicKey, DER_COSE_OID), abort.signal);
    step = 'session-key';
    const authSession = await ECDSAKeyIdentity.generate();
    if (epoch !== this.#epoch) throw new Error('Sign-in cancelled');
    step = 'passkey-request';
    // Forces a new WebAuthn assertion, rather than reusing a previous signed-in session.
    const authChain = await DelegationChain.create(passkey, authSession.getPublicKey(), new Date(Date.now() + 300000));
    if (epoch !== this.#epoch) throw new Error('Sign-in cancelled');
    step = 'account-lookup';
    const authIdentity = DelegationIdentity.fromDelegation(authSession, authChain);
    const agent = await agentFor(authIdentity);
    if (epoch !== this.#epoch) throw new Error('Sign-in cancelled');
    const mapping = success(await rpc(agent, IDENTITY, 'check_auth_principal_v2', {}, 'query'), 'credential lookup');
    const mappedUserId = principal(mapping.user_id);
    const session = await ECDSAKeyIdentity.generate();
    if (epoch !== this.#epoch) throw new Error('Sign-in cancelled');
    step = 'prepare-delegation';
    const prepared = success(await rpc(agent, IDENTITY, 'prepare_delegation', {
      session_key: der(session), max_time_to_live: TTL_NS, is_ii_principal: false,
    }, 'update'), 'existing-account sign-in');
    step = 'account-profile';
    const profile = await this.#profile(agent, session, prepared);
    if (profile.userId !== mappedUserId || epoch !== this.#epoch) throw new Error('Account identity mismatch');
    return profile;
    } catch (error) { throw new SignInFailure(step, error); }
    finally { if (this.#pendingAbort === abort) this.#pendingAbort = undefined; }
  }
  async #profile(authAgent, session, prepared) {
    const userKey = bytes(prepared.user_key);
    const expiration = BigInt(prepared.expiration);
    if (expiration <= BigInt(Date.now()) * 1000000n || expiration > BigInt(Date.now() + 360000) * 1000000n) {
      throw new Error('Unexpected delegation lifetime');
    }
    let signed;
    for (let i = 0; i < 5; i++) {
      const response = await rpc(authAgent, IDENTITY, 'get_delegation', { session_key: der(session), expiration }, 'query');
      if (response && typeof response === 'object' && Object.hasOwn(response, 'Success')) { signed = response.Success; break; }
      if (response !== 'NotFound' && !(response && Object.hasOwn(response, 'NotFound'))) throw new Error('Delegation rejected');
      if (i < 4) await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!signed) throw new Error('Delegation unavailable');
    if (signed.delegation?.targets !== undefined) throw new Error('Unexpected delegation targets');
    const delegatedKey = bytes(signed.delegation?.pubkey);
    const sessionKey = der(session);
    if (delegatedKey.length !== sessionKey.length || !delegatedKey.every((v,i) => v === sessionKey[i]) || BigInt(signed.delegation.expiration) !== expiration) {
      throw new Error('Delegation binding mismatch');
    }
    const delegation = new Delegation(delegatedKey, expiration);
    const chain = DelegationChain.fromDelegations([{ delegation, signature: bytes(signed.signature) }], userKey);
    const ocIdentity = DelegationIdentity.fromDelegation(session, chain);
    const profile = success(await rpc(await agentFor(ocIdentity), USER_INDEX, 'current_user', {}, 'query'), 'existing account lookup');
    if (typeof profile.username !== 'string' || !profile.username || profile.username.length > 100) throw new Error('Existing account missing');
    return { username: profile.username, userId: principal(profile.user_id), ocPrincipal: ocIdentity.getPrincipal().toText() };
  }
}

import { bytes, RP_ID } from './policy.mjs';
const allowedErrors = new Set(['NotAllowedError','SecurityError','UnknownError','AbortError','NotSupportedError','InvalidStateError']);
const equal = (a,b) => a.length === b.length && a.every((v,i) => v === b[i]);
const base64url = value => btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

// Diagnostic only. No backend calls, account/session creation, key replacement,
// persistence or logging. The returned response never leaves this function.
export async function checkSavedPasskey(metadata, origin, chooseCredential = false) {
  const abort = new AbortController();
  let timer;
  try {
    if (metadata?.origin !== RP_ID || new URL(origin).hostname !== RP_ID) throw new Error('Invalid scope');
    const credentialId = bytes(metadata.credentialId,4096);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    timer = setTimeout(() => abort.abort(),60000);
    // Intentionally before any await/key generation: preserve the button gesture.
    const credential = await navigator.credentials.get({signal:abort.signal,publicKey:{
      rpId:RP_ID,challenge,...(chooseCredential ? {} : {allowCredentials:[{type:'public-key',id:credentialId}]}),
      userVerification:'preferred',timeout:60000,
    }});
    if (!credential || credential.type !== 'public-key') throw new Error('Invalid response');
    const returnedId = bytes(new Uint8Array(credential.rawId),4096);
    const sameCredential = equal(returnedId,credentialId);
    if (!chooseCredential && !sameCredential) throw new Error('Invalid response');
    const response = credential.response;
    const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON));
    const authData = new Uint8Array(response.authenticatorData);
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(RP_ID)));
    if (clientData.type !== 'webauthn.get' || clientData.origin !== origin || clientData.challenge !== base64url(challenge) ||
        clientData.crossOrigin === true || authData.length < 37 || !(authData[32]&1) ||
        !equal(authData.slice(0,32),rpHash) || !new Uint8Array(response.signature).length) throw new Error('Invalid response');
    if (!sameCredential) return {ok:true,sameCredential:false,message:'Edge returned an assertion for a different localhost credential than the one saved in this test page. No credential details were replaced and no OpenChat call was made. This is not an account sign-in. [LOCAL-PASSKEY/different-credential]'};
    return {ok:true,sameCredential:true,message:`Edge returned an assertion for the same saved credential ID with the correct local challenge and origin. User verification: ${authData[32]&4 ? 'yes' : 'no'}. No OpenChat call was made. This does not yet verify the signature or prove account sign-in. [LOCAL-PASSKEY/assertion-returned]`};
  } catch (error) {
    if (abort.signal.aborted) return {ok:false,message:'The local check reached its 60-second deadline without returning an assertion. This timeout does not identify the underlying provider error. No OpenChat call was made and no key was changed. [LOCAL-PASSKEY/timeout]'};
    const reason = allowedErrors.has(error?.name) ? error.name : 'invalid-response';
    return {ok:false,message:`The saved-key local check failed (${reason}). No OpenChat call was made and no key was changed. [LOCAL-PASSKEY/${reason}]`};
  } finally { clearTimeout(timer); }
}

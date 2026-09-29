import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";

/** Anonymous, signature-checked read against official services; no dfx, WSL, or local identity. */
export async function queryOfficialUserIndexPublicKey(canister, dependencies = {}) {
    const canisterId = Principal.fromText(canister).toText();
    const createAgent = dependencies.createAgent ?? ((options) => HttpAgent.create(options));
    const createActor =
        dependencies.createActor ?? ((idl, options) => Actor.createActor(idl, options));
    const agent = await createAgent({
        host: "https://icp-api.io",
        shouldFetchRootKey: false,
        verifyQuerySignatures: true,
        retryTimes: 0,
    });
    const actor = createActor(
        ({ IDL }) =>
            IDL.Service({
                public_key: IDL.Func(
                    [IDL.Record({})],
                    [
                        IDL.Variant({
                            Success: IDL.Text,
                            NotInitialised: IDL.Null,
                            Error: IDL.Reserved,
                        }),
                    ],
                    ["query"],
                ),
            }),
        { agent, canisterId },
    );
    const response = await actor.public_key({});
    if (response === null || typeof response !== "object" || typeof response.Success !== "string") {
        throw new Error(
            "Official OpenChat public key is unavailable; local client startup stopped.",
        );
    }
    return response.Success;
}

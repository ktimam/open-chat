import { parseLocalAppCatalog } from "./localAppCatalog";
import { parseLocalAppDirectory } from "./localAppDirectory";

export const directorySource = "https://publisher.test/openchat/apps-v1.json";
export async function directoryFixture(id = "sample", revision = "1", privateSetup = false) {
    const hash = async (source: string) =>
        Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
            (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
    const source = `/* inert synthetic ${id} ${revision}; never executed */`;
    const processor = {
        source,
        sha256: await hash(source),
        byteLength: new TextEncoder().encode(source).byteLength,
    };
    const app = {
        id,
        revision,
        name: `${id} app`,
        description: "Synthetic app",
        destination: `https://publisher.test/import/${id}`,
        processor: { sha256: processor.sha256, byteLength: processor.byteLength },
        actions: [
            {
                definition: {
                    name: "add",
                    description: "Add item",
                    promptTemplate: "Read only the selected message",
                    responseSchema: { type: "object" },
                    card: {
                        title: "Item",
                        rows: [{ label: "Value", valueKey: "value" }],
                        confirmLabel: "Send",
                        cancelLabel: "Cancel",
                    },
                },
                draftSchema: {
                    type: "object",
                    properties: { value: { type: "number" } },
                    required: ["value"],
                    additionalProperties: false,
                },
                handoff: { kind: "single" },
            },
        ],
    };
    const catalogJson = JSON.stringify({ version: 1, apps: [app] });
    const directoryJson = JSON.stringify({
        version: 1,
        apps: [
            {
                id,
                revision,
                name: app.name,
                description: app.description,
                setupUrl: `/connect/${id}`,
                catalog: {
                    url: `/catalog/${id}.json`,
                    sha256: await hash(catalogJson),
                    byteLength: new TextEncoder().encode(catalogJson).byteLength,
                },
                processor: {
                    url: `/processor/${id}.js`,
                    sha256: processor.sha256,
                    byteLength: processor.byteLength,
                },
            },
        ],
    });
    const directory = parseLocalAppDirectory(directoryJson, directorySource);
    const connectedJson = privateSetup
        ? JSON.stringify({
              version: 1,
              apps: [
                  {
                      ...app,
                      recipientLabel: "Synthetic private account",
                      actions: app.actions.map((action) => ({
                          ...action,
                          processorContext: { privateLabels: ["Private choice"] },
                      })),
                  },
              ],
          })
        : catalogJson;
    return {
        source,
        processor,
        catalogJson,
        directoryJson,
        directory,
        descriptor: directory.apps[0],
        pkg: { catalog: parseLocalAppCatalog(catalogJson), catalogJson, processor },
        connectedJson,
    };
}

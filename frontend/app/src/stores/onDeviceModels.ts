import { configKeys } from "@shared";
import { LocalStorageStore } from "@client/reactiveStores";

// The user's currently selected on-device model ("" = none selected). Downloaded-model metadata is read
// from the native model store at runtime (listLocalModels) and the catalog is fetched, so neither is
// persisted here — only the user's selection is.
export const selectedModelId = new LocalStorageStore(configKeys.selectedModelId, "");

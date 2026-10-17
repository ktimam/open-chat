import { readable } from "@client/reactiveStores";
import {
    currentWebGpuModelCatalog,
    subscribeWebGpuModelCatalog,
} from "../utils/webGpuModelCatalog";

export const webGpuModelCatalog = readable(currentWebGpuModelCatalog(), (set) => {
    set(currentWebGpuModelCatalog());
    return subscribeWebGpuModelCatalog(() => set(currentWebGpuModelCatalog()));
});

import { navigate } from "./navigation";
import { privateAppWorkspace } from "./privateAppWorkspace";

export const MAIN_APPS_ROUTE = "/communities?view=apps";

export function isMainAppsRoute(search: string): boolean {
    return new URLSearchParams(search).get("view") === "apps";
}

export function navigateToMainApps(): void {
    privateAppWorkspace.invalidateReview();
    privateAppWorkspace.close();
    navigate(MAIN_APPS_ROUTE);
}

// @ts-ignore
BigInt.prototype.toJSON = function () {
    return this.toString();
};

// @ts-ignore OC-DEBUG dynamic-import bisection
const __s = (t: string, m: string) => (window as any).__ocsend && (window as any).__ocsend(t, m);
__s("main", "start");

await import("./web-components/customEmoji");
__s("main", "wc-customEmoji");
await import("./web-components/profileLink");
__s("main", "wc-profileLink");
await import("./web-components/spoiler");
__s("main", "wc-spoiler");
const oc = await import("openchat-client");
__s("main", "openchat-client");
const { mount } = await import("svelte");
__s("main", "svelte");
const themes = await import("./theme/themes");
__s("main", "themes");
const AppV2mod = await import("./components_mobile/App.svelte");
__s("main", "AppV2-imported");

const v2 = import.meta.env.OC_MOBILE_LAYOUT === "v2" && (oc as any).mobileWidth.value;
__s("main", "v2=" + v2);
if (v2) {
    themes.setNativeTheme();
} else {
    themes.writeNativeCssVariables();
}
__s("main", "theme-done");
let app: unknown;
try {
    app = mount(AppV2mod.default, { target: document.body });
    __s("main", "mounted");
} catch (e: unknown) {
    const err = e as Error;
    __s("mounterr", (err && (err.stack || err.message)) || String(e));
    throw e;
}

export default app;

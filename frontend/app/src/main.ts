// eslint-disable-next-line @typescript-eslint/ban-ts-comment
//@ts-ignore
BigInt.prototype.toJSON = function () {
    return this.toString();
};

import "./web-components/customEmoji";
import "./web-components/profileLink";
import "./web-components/spoiler";

import { mobileWidth, mountedV2Layout } from "openchat-client";
import "svelte";
import { mount } from "svelte";
import App from "./components/App.svelte";
import AppV2 from "./components_mobile/App.svelte";
import { setNativeTheme, writeNativeCssVariables } from "./theme/themes";
import { isNativeClient } from "./utils/onDeviceInference";
import { restoreWebModel } from "./utils/webInference";

// Browser build: re-attach a previously picked disk model (persisted FileSystemFileHandle) at
// boot, so on-device propose works without first opening the Model Manager.
if (!isNativeClient()) void restoreWebModel();

const v2 = import.meta.env.OC_MOBILE_LAYOUT === "v2" && mobileWidth.value;

// Tell openchat-client which tree is actually mounted BEFORE mounting it. The v2 variant
// is fixed for the app's lifetime, so layout decisions must not fall back to the desktop
// branch if the window is later resized to >=768px (back-from-chat would auto-reselect
// the chat and the bottom bar would render squished). The env flag alone is not enough:
// a wide boot with OC_MOBILE_LAYOUT=v2 mounts v1, which must keep desktop behavior.
mountedV2Layout.set(v2);

if (v2) {
    setNativeTheme();
} else {
    writeNativeCssVariables();
}

const app = v2 ? mount(AppV2, { target: document.body }) : mount(App, { target: document.body });

export default app;

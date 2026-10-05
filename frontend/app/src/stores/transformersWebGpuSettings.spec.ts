import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SETTINGS_KEY = "openchat_transformers_webgpu_runtime_settings_v1";

describe("Transformers WebGPU runtime settings", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    it("defaults to the global 192-token ceiling while respecting the selected model", async () => {
        const settings = await import("./transformersWebGpuSettings");

        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(192);
        expect(settings.resolveTransformersWebGpuMaxOutputTokens(undefined, undefined, 192)).toBe(
            192,
        );
        expect(settings.resolveTransformersWebGpuMaxOutputTokens(undefined, undefined, 96)).toBe(
            96,
        );
        expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    });

    it("persists and clamps the editable output cap to the worker range", async () => {
        const settings = await import("./transformersWebGpuSettings");

        expect(settings.updateTransformersWebGpuMaxOutputTokens(48)).toBe(48);
        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(48);
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({
            version: 2,
            maxOutputTokens: 48,
        });
        expect(settings.updateTransformersWebGpuMaxOutputTokens(0)).toBe(1);
        expect(settings.updateTransformersWebGpuMaxOutputTokens(500)).toBe(192);
    });

    it("caps larger callers without expanding a smaller request", async () => {
        const settings = await import("./transformersWebGpuSettings");
        settings.updateTransformersWebGpuMaxOutputTokens(48);

        expect(settings.resolveTransformersWebGpuMaxOutputTokens(256)).toBe(48);
        expect(settings.resolveTransformersWebGpuMaxOutputTokens(24)).toBe(24);
        expect(settings.resolveTransformersWebGpuMaxOutputTokens(undefined)).toBe(48);
    });

    it("loads valid persisted settings and ignores malformed state", async () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, maxOutputTokens: 40 }));
        let settings = await import("./transformersWebGpuSettings");
        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(40);

        localStorage.setItem(SETTINGS_KEY, "{broken");
        vi.resetModules();
        settings = await import("./transformersWebGpuSettings");
        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(192);
    });

    it.each([
        { value: 1, expected: 1 },
        { value: 48, expected: 48 },
        { value: 96, expected: 96 },
        { value: 192, expected: 96 },
        { value: 500, expected: 96 },
        { value: 0, expected: 1 },
        { value: -1, expected: 1 },
        { value: 48.6, expected: 49 },
        { value: "192", expected: 96 },
        { value: null, expected: 96 },
        { value: undefined, expected: 96 },
    ])(
        "preserves legacy v1 ceiling/clamp semantics for $value without rewriting storage",
        async ({ value, expected }) => {
            const raw = JSON.stringify({ version: 1, maxOutputTokens: value });
            localStorage.setItem(SETTINGS_KEY, raw);
            const settings = await import("./transformersWebGpuSettings");

            expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(expected);
            expect(settings.resolveTransformersWebGpuMaxOutputTokens(256, undefined, 192)).toBe(
                expected,
            );
            expect(localStorage.getItem(SETTINGS_KEY)).toBe(raw);
        },
    );

    it.each([
        { value: 192, expected: 192 },
        { value: 96, expected: 96 },
        { value: 500, expected: 192 },
        { value: 0, expected: 1 },
        { value: "48", expected: 192 },
    ])("restores version2 with the new ceiling for $value", async ({ value, expected }) => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 2, maxOutputTokens: value }));
        const settings = await import("./transformersWebGpuSettings");
        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(expected);
    });

    it("changes a saved legacy96 only after explicit reset or user edit", async () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, maxOutputTokens: 96 }));
        const settings = await import("./transformersWebGpuSettings");
        expect(get(settings.transformersWebGpuMaxOutputTokens)).toBe(96);
        expect(settings.resetTransformersWebGpuMaxOutputTokens()).toBe(192);
        expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
        expect(settings.updateTransformersWebGpuMaxOutputTokens(144)).toBe(144);
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual({
            version: 2,
            maxOutputTokens: 144,
        });
        vi.resetModules();
        expect(
            get((await import("./transformersWebGpuSettings")).transformersWebGpuMaxOutputTokens),
        ).toBe(144);
    });

    it.each([
        { request: 256, user: 192, model: 192, expected: 192 },
        { request: 256, user: 192, model: 96, expected: 96 },
        { request: 256, user: 96, model: 192, expected: 96 },
        { request: 256, user: 192, model: 48, expected: 48 },
        { request: 24, user: 192, model: 192, expected: 24 },
        { request: undefined, user: 192, model: 72, expected: 72 },
        { request: undefined, user: 40, model: 192, expected: 40 },
    ])(
        "intersects request$user with user/model limits: $request/$user/$model",
        async ({ request, user, model, expected }) => {
            const settings = await import("./transformersWebGpuSettings");
            expect(settings.resolveTransformersWebGpuMaxOutputTokens(request, user, model)).toBe(
                expected,
            );
        },
    );

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "preserves invalid request %s for engine rejection",
        async (request) => {
            const settings = await import("./transformersWebGpuSettings");
            expect(settings.resolveTransformersWebGpuMaxOutputTokens(request, 192, 96)).toBe(
                request,
            );
        },
    );

    it.each([0, 1.5, 193, NaN, Infinity])(
        "fails closed for an unvalidated model limit %s",
        async (limit) => {
            const settings = await import("./transformersWebGpuSettings");
            expect(settings.resolveTransformersWebGpuMaxOutputTokens(32, 192, limit)).toBeNaN();
        },
    );
});

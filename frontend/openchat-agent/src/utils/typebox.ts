import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { deepRemoveNullishFields } from "./nullish";
import { TypeboxValidationError } from "@shared";

export interface TypeboxValidationOptions {
    sensitive?: boolean;
}

export function typeboxValidate<T extends TSchema>(
    value: unknown,
    validator: T,
    options?: TypeboxValidationOptions,
): Static<T> {
    try {
        return Value.Parse(
            ["Default", "Convert", "Assert"],
            validator,
            deepRemoveNullishFields(value),
        );
    } catch (err) {
        if (options?.sensitive) {
            console.error("Typebox validation failed for a sensitive value");
            throw new TypeboxValidationError();
        }
        console.error("Typebox validation failed: ", value, err);
        throw new TypeboxValidationError(err instanceof Error ? err : undefined);
    }
}

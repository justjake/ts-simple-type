import { SimpleType, SimpleTypeUnion } from "../simple-type";
import { Writable } from "./to-simple-type";

/**
 * Represents a type system where any type can be "nullable" without being a
 * union type.  Because Typescript types are only nullable if they are unions,
 * we only allow conversion of union types to nullable types.
 */
type NullableSimpleType = { kind: "NON_NULLABLE"; type: SimpleTypeUnion } | { kind: "NULLABLE"; type: SimpleType; orUndefined: boolean; orNull: boolean };

/**
 * Convert a union that may contain NULL or UNDEFINED types into a nullable type
 * without those types in the union.
 *
 * See {@link NullableSimpleType}.
 */
export function toNullableSimpleType(simpleType: SimpleTypeUnion): NullableSimpleType {
	const orNull = simpleType.types.some(type => type.kind === "NULL");
	const orUndefined = simpleType.types.some(type => type.kind === "UNDEFINED");
	const nonNullable = simpleType.types.filter(type => type.kind !== "NULL" && type.kind !== "UNDEFINED");
	if (nonNullable.length === simpleType.types.length) {
		return { kind: "NON_NULLABLE", type: simpleType };
	} else {
		const nonNullableType: Writable<SimpleType> = nonNullable.length === 0 ? { kind: "NEVER" } : nonNullable.length === 1 ? nonNullable[0] : { kind: "UNION", types: nonNullable };
		if (nonNullable.length !== 1) {
			nonNullableType.name = simpleType.name;
			nonNullableType.getTypescript = simpleType.getTypescript;
		}
		return { kind: "NULLABLE", type: nonNullableType, orNull, orUndefined };
	}
}

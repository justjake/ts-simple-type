import { isSimpleTypeCallable, isSimpleTypeObjectLike, isSimpleTypeStructured, SimpleTypeCallable } from ".."
import { isAssignableToSimpleType } from "../is-assignable/is-assignable-to-simple-type"
import { isSimpleTypeLiteral, SimpleType, SimpleTypeEnum, SimpleTypeEnumMember, SimpleTypeMemberIndexed, SimpleTypeMemberNamed, SimpleTypePrimitive, SimpleTypeUnion } from "../simple-type"

import { Writable } from "./to-simple-type"

export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined
}

/**
 * Represents a type system where any type can be "nullable" without being a
 * union type.  Because Typescript types are only nullable if they are unions,
 * we only allow conversion of union types to nullable types.
 */
type NullableSimpleType = { kind: "NON_NULLABLE"; type: SimpleTypeUnion } | { kind: "NULLABLE"; type: SimpleType; orUndefined: boolean; orNull: boolean }

/**
 * Convert a union that may contain NULL or UNDEFINED types into a nullable type
 * without those types in the union.
 *
 * See {@link NullableSimpleType}.
 */
export function toNullableSimpleType(simpleType: SimpleTypeUnion): NullableSimpleType {
	const orNull = simpleType.types.some(type => type.kind === "NULL")
	const orUndefined = simpleType.types.some(type => type.kind === "UNDEFINED")
	const nonNullable = simpleType.types.filter(type => type.kind !== "NULL" && type.kind !== "UNDEFINED")
	if (nonNullable.length === simpleType.types.length) {
		return { kind: "NON_NULLABLE", type: simpleType }
	} else {
		const nonNullableType: Writable<SimpleType> = nonNullable.length === 0 ? { kind: "NEVER" } : nonNullable.length === 1 ? nonNullable[0] : { kind: "UNION", types: nonNullable }
		if (nonNullable.length !== 1) {
			nonNullableType.name = simpleType.name
			nonNullableType.getTypescript = simpleType.getTypescript
		}
		return { kind: "NULLABLE", type: nonNullableType, orNull, orUndefined }
	}
}

interface SimpleTypeUnionAsEnum {
	kind: "UNION_AS_ENUM"
	strings?: SimpleTypeEnum
	numbers?: SimpleTypeEnum
	rest?: SimpleTypeUnion
}

function typeToEnumMember(enumName: string, type: SimpleTypePrimitive, fallbackName: string): SimpleTypeEnumMember {
	let name = type.name
	if (isSimpleTypeLiteral(type)) {
		name ||= String(type.value)
	}
	name ||= fallbackName

	const fullName = `${enumName}.${name}`
	return derive(type, {
		kind: "ENUM_MEMBER",
		fullName,
		name,
		type,
	})
}

/**
 * Split out literal types from a union type into separate enums.
 */
export function unionAsEnums(simpleType: SimpleTypeUnion): SimpleTypeUnionAsEnum {
	const strings: SimpleTypeEnum = { kind: "ENUM", name: simpleType.name || "StringEnum", types: [], getTypescript: simpleType.getTypescript }
	const numbers: SimpleTypeEnum = { kind: "ENUM", name: simpleType.name || "NumberEnum", types: [], getTypescript: simpleType.getTypescript }
	const rest: SimpleTypeUnion = { kind: "UNION", name: simpleType.name, types: [], getTypescript: simpleType.getTypescript }
	simpleType.types.forEach((type, index) => {
		const fallbackName = `${simpleType.name || "Variant"}_${index}`
		if (type.kind === "STRING_LITERAL") {
			strings.types.push(typeToEnumMember(strings.name, type, fallbackName))
		} else if (type.kind === "NUMBER_LITERAL") {
			numbers.types.push(typeToEnumMember(numbers.name, type, fallbackName))
		} else {
			rest.types.push(type)
		}
	})
	return { kind: "UNION_AS_ENUM", strings, numbers, rest }
}

function derive<T extends SimpleType>(original: SimpleType, derived: Writable<T>): T {
	if (derived.name === undefined && original.name) {
		derived.name = original.name
	}

	if (derived.getTypescript === undefined && original.getTypescript) {
		derived.getTypescript = original.getTypescript
	}

	if (derived.error === undefined && original.error) {
		derived.error = original.error
	}

	return Object.freeze(derived)
}

/**
 * Represents a discriminated union in a type system that doesn't have literal
 * types.
 *
 * Instead, the discriminant is converted to an enum, and that member's literal
 * type is replaced by the enum in all variants.
 */
interface EnumTaggedUnionSimpleType {
	kind: "TAGGED_UNION"
	tag: SimpleTypeEnum
	union: SimpleTypeUnion
	discriminantMember: SimpleTypeMemberIndexed | SimpleTypeMemberNamed
}

export function toEnumTaggedUnion(simpleType: SimpleTypeUnion, discriminant?: SimpleTypeMemberIndexed | SimpleTypeMemberNamed): EnumTaggedUnionSimpleType | undefined {
	discriminant ??= simpleType.discriminantMembers?.[0]
	if (!discriminant) {
		return undefined
	}
}

export function toCallSignatureSimpleType(simpleType: SimpleType): SimpleTypeCallable | undefined {
	if (isSimpleTypeCallable(simpleType)) {
		return simpleType
	}

	if (isSimpleTypeObjectLike(simpleType) && simpleType.call) {
		return simpleType.call
	}

	if (isSimpleTypeStructured(simpleType)) {
		for (const type of simpleType.types) {
			const call = toCallSignatureSimpleType(type)
			if (call) {
				return call
			}
		}
	}

	return undefined
}

export function getSimpleTypeMemberNamed(simpleType: SimpleType, name: string): SimpleTypeMemberNamed | undefined {
	if (isSimpleTypeObjectLike(simpleType)) {
		return simpleType.members?.find(member => member.name === name)
	}

	switch (simpleType.kind) {
		case "UNION":
			return (
				simpleType.discriminantMembers?.find((member): member is SimpleTypeMemberNamed => "name" in member && member.name === name) ||
				simpleType.types.map(type => getSimpleTypeMemberNamed(type, name)).find(isDefined)
			)

		case "INTERSECTION":
			return simpleType.intersected ? getSimpleTypeMemberNamed(simpleType.intersected, name) : simpleType.types.map(type => getSimpleTypeMemberNamed(type, name)).find(isDefined)

		case "ALIAS":
			return getSimpleTypeMemberNamed(simpleType.target, name)

		case "GENERIC_ARGUMENTS":
			return getSimpleTypeMemberNamed(simpleType.instantiated, name)
	}

	return undefined
}

export function excludeSimpleType(simpleType: SimpleType, exclude: SimpleType | ((type: SimpleType) => boolean)): SimpleType | undefined {
	switch (simpleType.kind) {
		case "ALIAS":
			return excludeSimpleType(simpleType.target, exclude)
		case "GENERIC_ARGUMENTS":
			return excludeSimpleType(simpleType.instantiated, exclude)
		case "INTERSECTION":
		case "UNION":
			const types = simpleType.types.map(type => excludeSimpleType(type, exclude)).filter(isDefined)
			if (types.length === 0) {
				return undefined
			}

			if (types.length === 1) {
				return types[0]
			}

			if (types.length === simpleType.types.length) {
				return simpleType
			}

			return {
				kind: "UNION",
				types,
				error: simpleType.error,
				name: simpleType.name,
			}
	}

	if (typeof exclude === "function") {
		if (exclude(simpleType)) {
			return undefined
		}
	} else {
		if (isAssignableToSimpleType(exclude, simpleType)) {
			return undefined
		}
	}

	return simpleType
}

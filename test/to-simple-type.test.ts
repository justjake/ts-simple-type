import { inspect } from "util"

import { test, expect } from "@jest/globals"
import * as ts from "typescript"

import {
	getTypescriptModule,
	SimpleType,
	SimpleTypeAlias,
	SimpleTypeArray,
	SimpleTypeGenericArguments,
	SimpleTypeInterface,
	SimpleTypeObject,
	SimpleTypeString,
	SimpleTypeUnion,
	toSimpleType,
} from "../src"
import { isType } from "../src/utils/ts-util"

import { getTestTypes } from "./helpers/get-test-types"

const TEST_TYPES = `
type ActivityTable = 'activity'
type DiscussionTable = 'discussion'
export type Table = ActivityTable | DiscussionTable | 'block' | 'collection' | 'space'

export type StringAlias = string

export type SimpleAlias<T> = { hello: T }
export type SimpleAliasExample = SimpleAlias<string>
export interface GenericInterface<T> {
  hello: T
}
export type GenericInterfaceExample = GenericInterface<number>

export type RecordPointer<T extends Table = Table> = T extends
	| ActivityTable
	| DiscussionTable
	? { table: T; id: string; spaceId: string }
	: {
			table: T
			id: string
			/** Optional, only for activity and space shard tables. */
			spaceId?: string
	  }

export type ActivityPointer = RecordPointer<ActivityTable>
export type ContentPointer = RecordPointer<'block' | 'collection'>
    `

test("it adds methods when addMethods is set", () => {
	const { types, typeChecker } = getTestTypes(["SimpleAlias", "SimpleAliasExample", "GenericInterface", "GenericInterfaceExample"], TEST_TYPES)
	const simpleType = toSimpleType(types.SimpleAliasExample, typeChecker, {
		addMethods: true,
	})

	const toTs = simpleType.getTypescript?.()

	expect(toTs?.type).toBe(types.SimpleAliasExample)
	expect(toTs?.checker).toBe(typeChecker)
	expect(toTs?.symbol).toBe(types.SimpleAliasExample.aliasSymbol || types.SimpleAliasExample.symbol)
})

test("basic type alias handling", () => {
	const { types, typeChecker } = getTestTypes(
		["StringAlias", "ObjectAlias", "UnionAlias", "IntersectionAlias"],
		`
export type StringAlias = string	
export type ObjectAlias = {
	tag: "object"
	hello: true
}
export type UnionAlias = "first" | "second"
export type IntersectionAlias = ObjectAlias & StringAlias
	`
	)

	expect(toSimpleType(types.StringAlias, typeChecker)).toEqual({
		kind: "STRING",
	})

	const objectAliasSimpleType: SimpleTypeObject = {
		kind: "OBJECT",
		name: "ObjectAlias",
		members: [
			{
				name: "tag",
				type: {
					kind: "STRING_LITERAL",
					value: "object",
				},
			},
			{
				name: "hello",
				type: {
					kind: "BOOLEAN_LITERAL",
					value: true,
				},
			},
		],
	}
	expect(toSimpleType(types.ObjectAlias, typeChecker)).toEqual(objectAliasSimpleType)

	const unionAliasSimpleType: SimpleTypeUnion = {
		kind: "UNION",
		name: "UnionAlias",
		types: [
			{
				kind: "STRING_LITERAL",
				value: "first",
			},
			{
				kind: "STRING_LITERAL",
				value: "second",
			},
		],
	}
	expect(toSimpleType(types.UnionAlias, typeChecker)).toEqual(unionAliasSimpleType)

	const intersectionAliasType = {
		...toSimpleType(types.IntersectionAlias, typeChecker),
	}
	if (intersectionAliasType.kind === "INTERSECTION") {
		delete intersectionAliasType.intersected
	}

	expect(intersectionAliasType).toEqual({
		kind: "INTERSECTION",
		name: "IntersectionAlias",
		types: [
			objectAliasSimpleType,
			{
				kind: "STRING",
			},
		],
	})
})

test("simple generic alias handling", () => {
	const { types, typeChecker } = getTestTypes(
		["GenericAlias", "GenericAliasInstance", "NestedGenericAliasInstance"],
		`
export type GenericAlias<T> = { hello: T }	
export type GenericAliasInstance = GenericAlias<"cow">
export type NestedGenericAliasInstance = {
	nested: GenericAlias<{ inner: "cow" }>
}
	`
	)

	const expectedGenericAlias: SimpleTypeAlias = {
		kind: "ALIAS",
		name: "GenericAlias",
		typeParameters: [
			{
				kind: "GENERIC_PARAMETER",
				name: "T",
			},
		],
		target: {
			kind: "OBJECT",
			name: undefined,
			members: [
				{
					name: "hello",
					type: {
						kind: "GENERIC_PARAMETER",
						name: "T",
					},
				},
			],
		},
	}
	expect(toSimpleType(types.GenericAlias, typeChecker)).toEqual(expectedGenericAlias)

	const expectedGenericAliasInstance: SimpleTypeGenericArguments = {
		kind: "GENERIC_ARGUMENTS",
		name: "GenericAliasInstance",
		instantiated: {
			kind: "OBJECT",
			name: undefined,
			members: [
				{
					name: "hello",
					type: {
						kind: "STRING_LITERAL",
						value: "cow",
					},
				},
			],
		},
		target: expectedGenericAlias,
		typeArguments: [
			{
				kind: "STRING_LITERAL",
				value: "cow",
			},
		],
	}
	// log(types.GenericAliasInstance);
	// log(types.GenericAliasInstance.aliasTypeArguments);
	// log(typeChecker.getTypeArguments(types.GenericAliasInstance.target as any));
	// log(types.GenericAliasInstance.target);
	// log(types.GenericAliasInstance.target.target);
	expect(
		toSimpleType(types.GenericAliasInstance, typeChecker, {
			cache: new WeakMap(),
			// preserveSimpleAliases: true
		})
	).toEqual(expectedGenericAliasInstance)

	const expectedInnerType: SimpleTypeObject = {
		kind: "OBJECT",
		members: [
			{
				name: "inner",
				type: {
					kind: "STRING_LITERAL",
					value: "cow",
				},
			},
		],
	}

	const expectedNestedGenericAliasInstance: SimpleTypeObject = {
		kind: "OBJECT",
		name: "NestedGenericAliasInstance",
		members: [
			{
				name: "nested",
				type: {
					kind: "GENERIC_ARGUMENTS",
					name: "GenericAlias",
					instantiated: {
						kind: "OBJECT",
						name: undefined,
						members: [
							{
								name: "hello",
								type: expectedInnerType,
							},
						],
					},
					target: expectedGenericAlias,
					typeArguments: [expectedInnerType],
				},
			},
		],
	}
	const actualNestedInstance = toSimpleType(types.NestedGenericAliasInstance, typeChecker)
	expect(actualNestedInstance).toEqual(expectedNestedGenericAliasInstance)
})

test("generic interface handling", () => {
	const { types, typeChecker } = getTestTypes(["GenericInterface", "GenericInterfaceExample"], TEST_TYPES)

	const genericInterfaceSimpleType: SimpleTypeInterface = {
		name: "GenericInterface",
		kind: "INTERFACE",
		typeParameters: [
			{
				kind: "GENERIC_PARAMETER",
				name: "T",
			},
		],
		members: [
			{
				name: "hello",
				type: {
					kind: "GENERIC_PARAMETER",
					name: "T",
				},
			},
		],
	}
	expect(genericInterfaceSimpleType).toEqual(toSimpleType(types.GenericInterface, typeChecker))

	expect({
		kind: "GENERIC_ARGUMENTS",
		name: "GenericInterfaceExample",
		instantiated: {
			kind: "OBJECT",
			name: "GenericInterface",
			members: [
				{
					name: "hello",
					type: {
						kind: "NUMBER",
					},
				},
			],
		},
		typeArguments: [
			{
				kind: "NUMBER",
			},
		],
		target: genericInterfaceSimpleType,
	}).toEqual(toSimpleType(types.GenericInterfaceExample, typeChecker))
})

test("generic type alias handling", () => {
	const { types, typeChecker } = getTestTypes(["RecordPointer", "ActivityPointer", "Table"], TEST_TYPES)
	const activityPointerSimpleType = toSimpleType(types.ActivityPointer, typeChecker)
	const expectedActivityPointerInstance: SimpleTypeObject = {
		kind: "OBJECT",
		members: [
			{
				name: "table",
				type: {
					kind: "STRING_LITERAL",
					value: "activity",
				},
			},
			{
				name: "id",
				type: {
					kind: "STRING",
				},
			},
			{
				name: "spaceId",
				type: {
					kind: "STRING",
				},
			},
		],
	}

	const tableType = toSimpleType(types.Table, typeChecker)
	const recordPointerExpected: SimpleTypeAlias = {
		kind: "ALIAS",
		name: "RecordPointer",
		target: {
			kind: "ANY",
			error: "Not understood by ts-simple-type",
			name: undefined,
		},
		typeParameters: [
			{
				default: tableType,
				constraint: tableType,
				kind: "GENERIC_PARAMETER",
				name: "T",
			},
		],
	}

	expect(expectedActivityPointerInstance).toEqual(activityPointerSimpleType)

	// XXX: We actually want to understand this as an ALIAS to a GENERIC_ARGUMENTS,
	// but we can't currently detect that, so we pass through the instantiated
	// type with no generic information.
	// ctx.deepEqual(activityPointerSimpleType, {
	// 	kind: "ALIAS",
	// 	name: "ActivityPointer",
	// 	target: {
	// 		kind: "GENERIC_ARGUMENTS",
	// 		instantiated: expectedActivityPointerInstance,
	// 		target: recordPointerExpected,
	// 		typeArguments: [
	// 			{
	// 				kind: "STRING_LITERAL",
	// 				value: "activity"
	// 			}
	// 		]
	// 	}
	// });

	expect(recordPointerExpected).toEqual(toSimpleType(types.RecordPointer, typeChecker))
})

const stringSimpleType: SimpleTypeString = {
	kind: "STRING",
}
const arrayOfStringSimpleType: SimpleTypeArray = {
	name: "Array",
	kind: "ARRAY",
	type: stringSimpleType,
}

testExpectedTypes(
	"Arrays",
	{
		ArrayOfString: {
			...arrayOfStringSimpleType,
			name: "ArrayOfString",
		},
		ArrayOfArrayOfString: {
			kind: "ARRAY",
			name: "ArrayOfArrayOfString",
			type: arrayOfStringSimpleType,
		},
		ArrayOfStringLong: {
			...arrayOfStringSimpleType,
			name: "ArrayOfStringLong",
		},
		ArrayOfArrayOfStringLong: {
			kind: "ARRAY",
			name: "ArrayOfArrayOfStringLong",
			type: arrayOfStringSimpleType,
		},
	},
	`
export type ArrayOfString = string[];	
export type ArrayOfArrayOfString = string[][];
export type ArrayOfStringLong = Array<string>;
export type ArrayOfArrayOfStringLong = Array<Array<string>>;
	`
)

function testExpectedTypes<ExportedTypeName extends string>(prefix: string, expectations: Record<ExportedTypeName, SimpleType | (() => SimpleType)>, typescriptText: string) {
	const typeNames = Object.keys(expectations) as ExportedTypeName[]
	for (const typeName of typeNames) {
		test(`${prefix}: ${typeName}`, () => {
			const { types, typeChecker } = getTestTypes(typeNames, typescriptText)
			const simpleType = toSimpleType(types[typeName], typeChecker)
			const expected = expectations[typeName]
			try {
				expect(simpleType).toEqual(typeof expected === "function" ? expected() : expected)
			} catch (error) {
				log(types[typeName])
				throw error
			}
		})
	}
}

function debugTypeString(input: unknown, d = 3) {
	const str = inspect(input, { depth: d, colors: true })
	const flags = input && typeof input === "object" && isType(input) && debugTypeFlags(input)
	const asString = input && typeof input === "object" && isType(input) && (input as any).checker.typeToString(input)
	return [asString, flags, str.replace(/checker: {[\s\S]*?}/g, "(typechecker)")]
}

function log(input: unknown, d = 3) {
	// eslint-disable-next-line no-console
	console.log(...debugTypeString(input, d))
}

function debugTypeFlags(type: ts.Type) {
	const ts = getTypescriptModule()
	const flags = type.flags
	const typeFlags: Record<string, boolean> = {}
	const objectFlags: Record<string, boolean> = {}
	for (const flag in ts.TypeFlags) {
		if ((ts.TypeFlags as any)[flag] & flags) {
			typeFlags[flag] = true
		}
	}
	if (flags & ts.TypeFlags.Object) {
		const flags2 = (type as ts.ObjectType).objectFlags
		for (const flag in ts.ObjectFlags) {
			if ((ts.ObjectFlags as any)[flag] & flags2) {
				objectFlags[flag] = true
			}
		}
	}
	return {
		typeFlags,
		objectFlags,
	}
}

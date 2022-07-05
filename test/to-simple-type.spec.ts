import test from "ava";
import { __String } from "typescript";
import ts = require("typescript");
import { inspect } from "util";
import { getTypescriptModule, SimpleTypeAlias, SimpleTypeGenericArguments, SimpleTypeInterface, SimpleTypeObject, SimpleTypeUnion, toSimpleType } from "../src";
import { isType } from "../src/utils/ts-util";
import { ITestFile, programWithVirtualFiles } from "./helpers/analyze-text";

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
    `;

test("it adds methods when addMethods is set", ctx => {
	const { types, typeChecker } = getTestTypes(["SimpleAlias", "SimpleAliasExample", "GenericInterface", "GenericInterfaceExample"], TEST_TYPES);
	const simpleType = toSimpleType(types.SimpleAliasExample, typeChecker, {
		addMethods: true
	});

	ctx.is(simpleType.getType?.(), types.SimpleAliasExample);
	ctx.is(simpleType.getTypeChecker?.(), typeChecker);
	ctx.is(simpleType.getSymbol?.(), types.SimpleAliasExample.getSymbol());
});

test("basic type alias handling", ctx => {
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
	);

	ctx.deepEqual(toSimpleType(types.StringAlias, typeChecker), {
		kind: "STRING"
	});

	const objectAliasSimpleType: SimpleTypeObject = {
		kind: "OBJECT",
		name: "ObjectAlias",
		members: [
			{
				name: "tag",
				type: {
					kind: "STRING_LITERAL",
					value: "object"
				}
			},
			{
				name: "hello",
				type: {
					kind: "BOOLEAN_LITERAL",
					value: true
				}
			}
		]
	};
	ctx.deepEqual(toSimpleType(types.ObjectAlias, typeChecker), objectAliasSimpleType);

	const unionAliasSimpleType: SimpleTypeUnion = {
		kind: "UNION",
		name: "UnionAlias",
		types: [
			{
				kind: "STRING_LITERAL",
				value: "first"
			},
			{
				kind: "STRING_LITERAL",
				value: "second"
			}
		]
	};
	ctx.deepEqual(toSimpleType(types.UnionAlias, typeChecker), unionAliasSimpleType);

	ctx.deepEqual(toSimpleType(types.IntersectionAlias, typeChecker), {
		kind: "INTERSECTION",
		name: "IntersectionAlias",
		types: [
			objectAliasSimpleType,
			{
				kind: "STRING"
			}
		]
	});
});

test("simple generic alias handling", ctx => {
	const { types, typeChecker } = getTestTypes(
		["GenericAlias", "GenericAliasInstance", "NestedGenericAliasInstance"],
		`
export type GenericAlias<T> = { hello: T }	
export type GenericAliasInstance = GenericAlias<"cow">
export type NestedGenericAliasInstance = {
	nested: GenericAlias<{ inner: "cow" }>
}
	`
	);

	const expectedGenericAlias: SimpleTypeAlias = {
		kind: "ALIAS",
		name: "GenericAlias",
		typeParameters: [
			{
				kind: "GENERIC_PARAMETER",
				name: "T"
			}
		],
		target: {
			kind: "OBJECT",
			name: undefined,
			members: [
				{
					name: "hello",
					type: {
						kind: "GENERIC_PARAMETER",
						name: "T"
					}
				}
			]
		}
	};
	ctx.deepEqual(toSimpleType(types.GenericAlias, typeChecker), expectedGenericAlias);

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
						value: "cow"
					}
				}
			]
		},
		target: expectedGenericAlias,
		typeArguments: [
			{
				kind: "STRING_LITERAL",
				value: "cow"
			}
		]
	};
	// log(types.GenericAliasInstance);
	// log(types.GenericAliasInstance.aliasTypeArguments);
	// log(typeChecker.getTypeArguments(types.GenericAliasInstance.target as any));
	// log(types.GenericAliasInstance.target);
	// log(types.GenericAliasInstance.target.target);
	ctx.deepEqual(
		toSimpleType(types.GenericAliasInstance, typeChecker, {
			cache: new WeakMap()
			// preserveSimpleAliases: true
		}),
		expectedGenericAliasInstance
	);

	const expectedInnerType: SimpleTypeObject = {
		kind: "OBJECT",
		members: [
			{
				name: "inner",
				type: {
					kind: "STRING_LITERAL",
					value: "cow"
				}
			}
		]
	};

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
								type: expectedInnerType
							}
						]
					},
					target: expectedGenericAlias,
					typeArguments: [expectedInnerType]
				}
			}
		]
	};
	const actualNestedInstance = toSimpleType(types.NestedGenericAliasInstance, typeChecker);
	ctx.deepEqual(actualNestedInstance, expectedNestedGenericAliasInstance);
});

test("generic interface handling", ctx => {
	const { types, typeChecker } = getTestTypes(["GenericInterface", "GenericInterfaceExample"], TEST_TYPES);

	const genericInterfaceSimpleType: SimpleTypeInterface = {
		name: "GenericInterface",
		kind: "INTERFACE",
		typeParameters: [
			{
				kind: "GENERIC_PARAMETER",
				name: "T"
			}
		],
		members: [
			{
				name: "hello",
				type: {
					kind: "GENERIC_PARAMETER",
					name: "T"
				}
			}
		]
	};
	ctx.deepEqual(genericInterfaceSimpleType, toSimpleType(types.GenericInterface, typeChecker));

	ctx.deepEqual(
		{
			kind: "GENERIC_ARGUMENTS",
			name: "GenericInterfaceExample",
			instantiated: {
				kind: "OBJECT",
				name: "GenericInterface",
				members: [
					{
						name: "hello",
						type: {
							kind: "NUMBER"
						}
					}
				]
			},
			typeArguments: [
				{
					kind: "NUMBER"
				}
			],
			target: genericInterfaceSimpleType
		},
		toSimpleType(types.GenericInterfaceExample, typeChecker)
	);
});

test.only("generic type alias handling", ctx => {
	const { types, typeChecker } = getTestTypes(["RecordPointer", "ActivityPointer", "Table"], TEST_TYPES);
	log(types.ActivityPointer);
	const activityPointerSimpleType = toSimpleType(types.ActivityPointer, typeChecker);
	const expectedActivityPointerInstance: SimpleTypeObject = {
		kind: "OBJECT",
		members: [
			{
				name: "table",
				type: {
					kind: "STRING_LITERAL",
					value: "activity"
				}
			},
			{
				name: "id",
				type: {
					kind: "STRING"
				}
			},
			{
				name: "spaceId",
				type: {
					kind: "STRING"
				}
			}
		]
	};

	const tableType = toSimpleType(types.Table, typeChecker);
	const recordPointerExpected: SimpleTypeAlias = {
		kind: "ALIAS",
		name: "RecordPointer",
		target: {
			kind: "ANY",
			error: "Not supported",
			name: undefined
		},
		typeParameters: [
			{
				default: tableType,
				constraint: tableType,
				kind: "GENERIC_PARAMETER",
				name: "T"
			}
		]
	};

	ctx.deepEqual(expectedActivityPointerInstance, activityPointerSimpleType);

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

	ctx.deepEqual(recordPointerExpected, toSimpleType(types.RecordPointer, typeChecker));
});

function getTestTypes<TypeNames extends string>(
	typeNames: TypeNames[],
	source: string
): {
	types: Record<TypeNames, ts.Type>;
	program: ts.Program;
	typeChecker: ts.TypeChecker;
} {
	const testFile: ITestFile = {
		fileName: "test.ts",
		text: source
	};
	const program = programWithVirtualFiles(testFile, {
		options: {
			strict: true
		}
	});
	const [sourceFile] = program.getSourceFiles().filter(f => f.fileName.includes(testFile.fileName));
	const typeChecker = program.getTypeChecker();
	const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile)!;
	const result = {
		types: {} as Record<TypeNames, ts.Type>,
		program,
		typeChecker
	};

	for (const name of typeNames) {
		const symbol = assert(moduleSymbol.exports?.get(name as __String), `${name} symbol`);
		const type = typeChecker.getDeclaredTypeOfSymbol(symbol);
		result.types[name] = type;
	}
	return result;
}

function assert<T>(val: T | undefined, msg: string): T {
	if (val == null) {
		throw new Error(`Expected value to be defined: ${msg}`);
	}
	return val;
}

function log(input: unknown, d = 3) {
	const str = inspect(input, { depth: d, colors: true });
	const flags = input && typeof input === "object" && isType(input) && debugTypeFlags(input);
	const asString = input && typeof input === "object" && isType(input) && (input as any).checker.typeToString(input);

	// eslint-disable-next-line no-console
	console.log(asString, flags, str.replace(/checker: {[\s\S]*?}/g, "(typechecker)"));
}

function debugTypeFlags(type: ts.Type) {
	const ts = getTypescriptModule();
	const flags = type.flags;
	const typeFlags: Record<string, boolean> = {};
	const objectFlags: Record<string, boolean> = {};
	for (const flag in ts.TypeFlags) {
		if ((ts.TypeFlags as any)[flag] & flags) {
			typeFlags[flag] = true;
		}
	}
	if (flags & ts.TypeFlags.Object) {
		const flags2 = (type as ts.ObjectType).objectFlags;
		for (const flag in ts.ObjectFlags) {
			if ((ts.ObjectFlags as any)[flag] & flags2) {
				objectFlags[flag] = true;
			}
		}
	}
	return {
		typeFlags,
		objectFlags
	};
}

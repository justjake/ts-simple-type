import test from "ava";
import { __String } from "typescript";
import ts = require("typescript");
import { inspect } from "util";
import { getTypescriptModule, SimpleTypeAlias, SimpleTypeInterface, SimpleTypeObject, toSimpleType } from "../src";
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

// test("it adds methods when addMethods is set", ctx => {
// 	const { types, typeChecker } = getTestTypes(["SimpleAlias", "SimpleAliasExample", "GenericInterface", "GenericInterfaceExample"], TEST_TYPES);
// 	const simpleType = toSimpleType(types.SimpleAliasExample, typeChecker, {
// 		addMethods: true
// 	});

// 	ctx.is(simpleType.getType?.(), types.SimpleAliasExample);
// 	ctx.is(simpleType.getTypeChecker?.(), typeChecker);
// 	ctx.is(simpleType.getSymbol?.(), types.SimpleAliasExample.getSymbol());
// });

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
				optional: false,
				modifiers: [],
				type: {
					kind: "GENERIC_PARAMETER",
					name: "T"
				}
			}
		]
	};
	ctx.deepEqual(toSimpleType(types.GenericInterface, typeChecker), genericInterfaceSimpleType);

	ctx.deepEqual(toSimpleType(types.GenericInterfaceExample, typeChecker), {
		kind: "ALIAS",
		name: "GenericInterfaceExample",
		target: {
			kind: "GENERIC_ARGUMENTS",
			instantiated: {
				kind: "OBJECT",
				call: undefined,
				ctor: undefined,
				indexType: undefined,
				name: "GenericInterface",
				typeParameters: undefined,
				members: [
					{
						name: "hello",
						optional: false,
						modifiers: [],
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
		}
	});
});

test("generic type alias handling", ctx => {
	const { types, typeChecker } = getTestTypes(["RecordPointer", "ActivityPointer", "Table"], TEST_TYPES);
	const activityPointer = toSimpleType(types.ActivityPointer, typeChecker);
	const instantiatedActivityPointer: SimpleTypeObject = {
		kind: "OBJECT",
		members: [
			{
				modifiers: [],
				name: "table",
				optional: false,
				type: {
					kind: "STRING_LITERAL",
					value: "activity"
				}
			},
			{
				modifiers: [],
				name: "id",
				optional: false,
				type: {
					kind: "STRING"
				}
			},
			{
				modifiers: [],
				name: "spaceId",
				optional: false,
				type: {
					kind: "STRING"
				}
			}
		]
	};

	const tableType = toSimpleType(types.Table, typeChecker);
	const recordPointerDefinition: SimpleTypeAlias = {
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

	ctx.deepEqual(activityPointer, instantiatedActivityPointer);
	// XXX: We actually want to understand this as an ALIAS to a GENERIC_ARGUMENTS,
	// but we can't currently detect that, so we pass through the instantiated
	// type with no generic information.
	// ctx.deepEqual(activityPointer, {
	// 	kind: "ALIAS",
	// 	name: "ActivityPointer",
	// 	target: {
	// 		kind: "GENERIC_ARGUMENTS",
	// 		instantiated: instantiatedActivityPointer,
	// 		target: recordPointerDefinition,
	// 		typeArguments: [
	// 			{
	// 				kind: "STRING_LITERAL",
	// 				value: "activity"
	// 			}
	// 		]
	// 	}
	// });

	ctx.deepEqual(toSimpleType(types.RecordPointer, typeChecker), recordPointerDefinition);
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

	// eslint-disable-next-line no-console
	console.log(flags, str.replace(/checker: {[\s\S]*?}/g, ""));
}

export function debugTypeFlags(type: ts.Type) {
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

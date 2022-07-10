import { SimpleType, SimpleTypeKindMap } from "./simple-type";
import {
	SimpleTypePath,
	SimpleTypePathStep,
	SimpleTypePathStepAliased,
	SimpleTypePathStepAwaited,
	SimpleTypePathStepBase,
	SimpleTypePathStepCallSignature,
	SimpleTypePathStepCtorSignature,
	SimpleTypePathStepGenericArgument,
	SimpleTypePathStepGenericTarget,
	SimpleTypePathStepIndexedMember,
	SimpleTypePathStepNamedMember,
	SimpleTypePathStepNumberIndex,
	SimpleTypePathStepParameter,
	SimpleTypePathStepReturn,
	SimpleTypePathStepStringIndex,
	SimpleTypePathStepTypeParameter,
	SimpleTypePathStepTypeParameterConstraint,
	SimpleTypePathStepTypeParameterDefault,
	SimpleTypePathStepVariant
} from "./simple-type-path";

export const CYCLICAL = Symbol("CYCLICAL");
export type CYCLICAL = typeof CYCLICAL;

const ADDED_PATH_TO = new WeakSet<Error>();

function makeVisitChildFn<T>(path: SimpleTypePath, type: SimpleType, fn: Visitor<T>): VisitChild<T> {
	const visit: VisitChild<T> = function visit(step: SimpleTypePath | SimpleTypePath[number] | undefined, childType: SimpleType, childFn?: Visitor<T>) {
		const childPath = SimpleTypePath.concat(path, step);
		return visitInner(childPath, childType, childFn ?? fn);
	};
	visit.with = newFn => makeVisitChildFn(path, type, newFn);
	return visit;
}

function visitInner<T>(path: SimpleTypePath, type: SimpleType, fn: Visitor<T>): T | CYCLICAL {
	if (SimpleTypePath.includes(path, type)) {
		return CYCLICAL;
	}

	const args: VisitFnArgs<T> = {
		path,
		type,
		visit: makeVisitChildFn(path, type, fn)
	};

	try {
		return fn(args);
	} catch (e) {
		if (e instanceof Error && !ADDED_PATH_TO.has(e)) {
			e.message += `\nPath: ${SimpleTypePath.toString(path, type)}`;
			ADDED_PATH_TO.add(e);
		}
		throw e;
	}
}

type SimpleTypePathStepCallable = SimpleTypePathStepTypeParameter[] | SimpleTypePathStepParameter[] | SimpleTypePathStepReturn;
type SimpleTypePathStepIndexable = SimpleTypePathStepStringIndex | SimpleTypePathStepNumberIndex;
type SimpleTypePathStepObjectLike =
	| SimpleTypePathStepNamedMember[]
	| SimpleTypePathStepIndexable
	| SimpleTypePathStepCallSignature
	| SimpleTypePathStepCtorSignature
	| SimpleTypePathStepTypeParameter[];

interface SimpleTypeToPathStepMap {
	// STRING_LITERAL: never;
	// NUMBER_LITERAL: never;
	// BOOLEAN_LITERAL: never;
	// BIG_INT_LITERAL: never;
	// ES_SYMBOL_UNIQUE: never;
	// STRING: never;
	// NUMBER: never;
	// BOOLEAN: never;
	// BIG_INT: never;
	// ES_SYMBOL: never;
	// NULL: never;
	// UNDEFINED: never;
	// VOID: never;
	// NEVER: never;
	// ANY: never;
	// UNKNOWN: never;
	ENUM: SimpleTypePathStepVariant[];
	// ENUM_MEMBER: never;
	// NON_PRIMITIVE: never;
	UNION: SimpleTypePathStepVariant[];
	INTERSECTION: SimpleTypePathStepVariant[];
	INTERFACE: SimpleTypePathStepObjectLike;
	OBJECT: SimpleTypePathStepObjectLike;
	CLASS: SimpleTypePathStepObjectLike;
	FUNCTION: SimpleTypePathStepCallable;
	METHOD: SimpleTypePathStepCallable;
	GENERIC_ARGUMENTS: SimpleTypePathStepGenericArgument[] | SimpleTypePathStepGenericTarget | SimpleTypePathStepAliased;
	GENERIC_PARAMETER: SimpleTypePathStepTypeParameterConstraint | SimpleTypePathStepTypeParameterDefault;
	ALIAS: SimpleTypePathStepTypeParameter[] | SimpleTypePathStepAliased;
	TUPLE: SimpleTypePathStepIndexedMember[];
	ARRAY: SimpleTypePathStepNumberIndex;
	// DATE: never;
	PROMISE: SimpleTypePathStepAwaited;
}

// visitInner([], {} as any, ({ type, visit, path }) => {
// 	switch (type.kind) {
// 		case "OBJECT": {
// 			const members = visitors.object.mapNamedMembers({ type, path, visit });
// 		}
// 	}
// });

interface VisitChild<T, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	/** Visit the given type with the current visitor */
	(step: Step, type: SimpleType): T | CYCLICAL;
	/** Visit the given type with a different visitor */
	<R>(step: Step, type: SimpleType, fn: Visitor<R>): R | CYCLICAL;
	/** Create a new recursive function with a different visitor */
	with<R>(fn: Visitor<R>): VisitChild<R>;
}

interface VisitFnArgs<T, ST extends SimpleType = SimpleType, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	type: ST;
	path: SimpleTypePath;
	visit: VisitChild<T, Step>;
}

type Visitor<T, ST extends SimpleType = SimpleType> = (args: VisitFnArgs<T, ST>) => T;

type GenericVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitFnArgs<T, TypeKind, StepKind>) => T | CYCLICAL | undefined;

type GenericListVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitFnArgs<T, TypeKind, StepKind>) => Array<T | CYCLICAL> | undefined;

type SimpleTypePathStepVisitors = {
	// TODO: type magic to "fully flatten" these two mapped types together.
	[K in keyof SimpleTypeToPathStepMap]: {
		[SK in Extract<SimpleTypeToPathStepMap[K], SimpleTypePathStepBase> as CamelCase<SK["step"]>]: GenericVisitor<SimpleTypeKindMap[K], SK>;
	} &
		{
			[SK in Extract<SimpleTypeToPathStepMap[K], Array<any>> as CamelCase<`MAP_${SK[number]["step"]}S`>]: GenericListVisitor<SimpleTypeKindMap[K], SK[number]>;
		};
};

type CamelCase<S extends string> = S extends `${infer P1}_${infer P2}${infer P3}` ? `${Lowercase<P1>}${Uppercase<P2>}${CamelCase<P3>}` : Lowercase<S>;

/**
 * Visit all possible steps into the given type.
 */
export const mapAnyStep: GenericListVisitor<SimpleType, SimpleTypePathStep> = ({ type, path, visit }) => {
	if (type.kind in Visitor) {
		const visitors = Visitor[type.kind as keyof SimpleTypePathStepVisitors];
		let results: unknown[] = [];
		for (const [name, _visitor] of Object.entries(visitors)) {
			const visitor = _visitor as GenericVisitor<SimpleType, SimpleTypePathStep> | GenericListVisitor<SimpleType, SimpleTypePathStep>;
			const visited = visitor({ type, path, visit });
			if (typeof visited === "undefined") {
				continue;
			}
			if (name.startsWith("map") && Array.isArray(visited)) {
				results = results.concat(visited);
				continue;
			}
			results.push(visited);
		}
		return results as any[];
	} else {
		return undefined;
	}
};

const array = <T>(...values: Array<T | T[] | undefined>): T[] => values.flatMap(v => (v === undefined ? [] : v));

/** Visit all concrete object properties. Ignores function types and generics */
export const mapJsonStep: GenericListVisitor<SimpleType, SimpleTypePathStep> = ({ type, path, visit }) => {
	switch (type.kind) {
		case "ENUM":
			return Visitor.ENUM.mapVariants({ type, path, visit });
		case "UNION":
			return Visitor.UNION.mapVariants({ type, path, visit });
		case "INTERSECTION":
			return Visitor.INTERSECTION.mapVariants({ type, path, visit });
		case "INTERFACE":
			return array(Visitor.INTERFACE.mapNamedMembers({ type, path, visit }), Visitor.INTERFACE.numberIndex({ type, path, visit }), Visitor.INTERFACE.stringIndex({ type, path, visit }));
		case "OBJECT":
			return array(Visitor.OBJECT.mapNamedMembers({ type, path, visit }), Visitor.OBJECT.numberIndex({ type, path, visit }), Visitor.OBJECT.stringIndex({ type, path, visit }));
		case "CLASS":
			return array(Visitor.CLASS.mapNamedMembers({ type, path, visit }), Visitor.CLASS.numberIndex({ type, path, visit }), Visitor.CLASS.stringIndex({ type, path, visit }));
		case "TUPLE":
			return Visitor.TUPLE.mapIndexedMembers({ type, path, visit });
		case "ALIAS":
			return array(Visitor.ALIAS.aliased({ type, path, visit }));
		case "ARRAY":
			return array(Visitor.ARRAY.numberIndex({ type, path, visit }));
		case "GENERIC_ARGUMENTS":
			return array(Visitor.GENERIC_ARGUMENTS.aliased({ type, path, visit }));
	}
};

export function visitDepthFirst(
	path: SimpleTypePath,
	type: SimpleType,
	visitors: {
		before: Visitor<void> | undefined;
		after: Visitor<void> | undefined;
		traverse?: GenericListVisitor<SimpleType, SimpleTypePathStep>;
	}
) {
	visitInner<void>(path, type, args => {
		const traverse = visitors.traverse || mapAnyStep;
		visitors.before?.(args);
		traverse(args);
		visitors.after?.(args);
	});
}

export const Visitor: SimpleTypePathStepVisitors = {
	// TODO: figure out how to de-dupe these thingies
	ENUM: {
		mapVariants: ({ visit, type }) => type.types.map((variant, i) => visit({ from: type, index: i, step: "VARIANT" }, variant))
	},
	UNION: {
		mapVariants: ({ visit, type }) => type.types.map((variant, i) => visit({ from: type, index: i, step: "VARIANT" }, variant))
	},
	INTERSECTION: {
		mapVariants: ({ visit, type }) => type.types.map((variant, i) => visit({ from: type, index: i, step: "VARIANT" }, variant))
	},
	INTERFACE: {
		callSignature: ({ visit, type }) => type.call && visit({ from: type, step: "CALL_SIGNATURE" }, type.call),
		ctorSignature: ({ visit, type }) => type.ctor && visit({ from: type, step: "CTOR_SIGNATURE" }, type.ctor),
		mapNamedMembers: ({ visit, type }) => type.members?.map((member, i) => visit({ from: type, index: i, step: "NAMED_MEMBER", member }, member.type)),
		numberIndex: ({ visit, type }) => type.indexType?.NUMBER && visit({ from: type, step: "NUMBER_INDEX" }, type.indexType.NUMBER),
		stringIndex: ({ visit, type }) => type.indexType?.STRING && visit({ from: type, step: "STRING_INDEX" }, type.indexType.STRING),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param))
	},
	OBJECT: {
		callSignature: ({ visit, type }) => type.call && visit({ from: type, step: "CALL_SIGNATURE" }, type.call),
		ctorSignature: ({ visit, type }) => type.ctor && visit({ from: type, step: "CTOR_SIGNATURE" }, type.ctor),
		mapNamedMembers: ({ visit, type }) => type.members?.map((member, i) => visit({ from: type, index: i, step: "NAMED_MEMBER", member }, member.type)),
		numberIndex: ({ visit, type }) => type.indexType?.NUMBER && visit({ from: type, step: "NUMBER_INDEX" }, type.indexType.NUMBER),
		stringIndex: ({ visit, type }) => type.indexType?.STRING && visit({ from: type, step: "STRING_INDEX" }, type.indexType.STRING),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param))
	},
	CLASS: {
		callSignature: ({ visit, type }) => type.call && visit({ from: type, step: "CALL_SIGNATURE" }, type.call),
		ctorSignature: ({ visit, type }) => type.ctor && visit({ from: type, step: "CTOR_SIGNATURE" }, type.ctor),
		mapNamedMembers: ({ visit, type }) => type.members?.map((member, i) => visit({ from: type, index: i, step: "NAMED_MEMBER", member }, member.type)),
		numberIndex: ({ visit, type }) => type.indexType?.NUMBER && visit({ from: type, step: "NUMBER_INDEX" }, type.indexType.NUMBER),
		stringIndex: ({ visit, type }) => type.indexType?.STRING && visit({ from: type, step: "STRING_INDEX" }, type.indexType.STRING),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param))
	},
	FUNCTION: {
		mapParameters: ({ visit, type }) => type.parameters?.map((param, i) => visit({ from: type, index: i, step: "PARAMETER", parameter: param }, param.type)),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param)),
		return: ({ visit, type }) => type.returnType && visit({ from: type, step: "RETURN" }, type.returnType)
	},
	METHOD: {
		mapParameters: ({ visit, type }) => type.parameters?.map((param, i) => visit({ from: type, index: i, step: "PARAMETER", parameter: param }, param.type)),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param)),
		return: ({ visit, type }) => type.returnType && visit({ from: type, step: "RETURN" }, type.returnType)
	},
	GENERIC_ARGUMENTS: {
		aliased: ({ visit, type }) => visit({ from: type, step: "ALIASED" }, type.instantiated),
		genericTarget: ({ visit, type }) => visit({ from: type, step: "GENERIC_TARGET" }, type.target),
		mapGenericArguments: ({ visit, type }) => type.typeArguments.map((arg, i) => visit({ from: type, index: i, step: "GENERIC_ARGUMENT", name: arg.name }, arg))
	},
	GENERIC_PARAMETER: {
		typeParameterConstraint: ({ visit, type }) => type.constraint && visit({ from: type, step: "TYPE_PARAMETER_CONSTRAINT" }, type.constraint),
		typeParameterDefault: ({ visit, type }) => type.default && visit({ from: type, step: "TYPE_PARAMETER_DEFAULT" }, type.default)
	},
	TUPLE: {
		mapIndexedMembers: ({ visit, type }) => type.members?.map((member, i) => visit({ from: type, index: i, step: "INDEXED_MEMBER", member }, member.type))
	},
	ALIAS: {
		aliased: ({ visit, type }) => visit({ from: type, step: "ALIASED" }, type.target),
		mapTypeParameters: ({ visit, type }) => type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param))
	},
	ARRAY: {
		numberIndex: ({ visit, type }) => visit({ from: type, step: "NUMBER_INDEX" }, type.type)
	},
	PROMISE: {
		awaited: ({ visit, type }) => visit({ from: type, step: "AWAITED" }, type.type)
	}
};

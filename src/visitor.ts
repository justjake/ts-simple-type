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

/** Returned by {@link walkRecursive} and similar functions to prevent infinite loops */
export class Cyclical {
	static is(value: unknown): value is Cyclical {
		return Boolean(value && value instanceof Cyclical);
	}

	constructor(public readonly cycle: SimpleTypePath) {}
}

interface VisitChild<T, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	/** Visit the given type with the current visitor */
	(step: Step, type: SimpleType): T | Cyclical;
	/** Visit the given type with a different visitor */
	<R>(step: Step, type: SimpleType, fn: Visitor<R>): R | Cyclical;
	/** Create a new recursive function with a different visitor */
	with<R>(fn: Visitor<R>): VisitChild<R>;
}

interface VisitFnArgs<T, ST extends SimpleType = SimpleType, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	type: ST;
	path: SimpleTypePath;
	visit: VisitChild<T, Step>;
}

type Visitor<T, ST extends SimpleType = SimpleType> = (args: VisitFnArgs<T, ST>) => T;
type GenericVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitFnArgs<T, TypeKind, StepKind>) => T | Cyclical | undefined;
type GenericListVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitFnArgs<T, TypeKind, StepKind>) => Array<T | Cyclical> | undefined;

function makeVisitChildFn<T>(path: SimpleTypePath, type: SimpleType, fn: Visitor<T>): VisitChild<T> {
	const visit: VisitChild<T> = function visit(step: SimpleTypePath | SimpleTypePath[number] | undefined, childType: SimpleType, childFn?: Visitor<T>) {
		const childPath = SimpleTypePath.concat(path, step);
		return walkRecursive(childPath, childType, childFn ?? fn);
	};
	visit.with = newFn => makeVisitChildFn(path, type, newFn);
	return visit;
}

const ALREADY_ANNOTATED_ERROR_WITH_PATH = new WeakSet<Error>();

/**
 * Perform a custom recursive walk of `type` by calling `fn` it.
 * `fn` can recurse by calling its `args.visit(path, otherType)`.
 * @returns result of `fn`, or {@link Cyclical} if `type` already occurs in `path`.
 */
export function walkRecursive<T>(path: SimpleTypePath, type: SimpleType, fn: Visitor<T>): T | Cyclical {
	const cycle = SimpleTypePath.getSubpathFrom(path, type);
	if (cycle) {
		return new Cyclical(cycle);
	}

	const args: VisitFnArgs<T> = {
		path,
		type,
		visit: makeVisitChildFn(path, type, fn)
	};

	try {
		return fn(args);
	} catch (e) {
		if (e instanceof Error && !ALREADY_ANNOTATED_ERROR_WITH_PATH.has(e)) {
			e.message += `\nPath: ${SimpleTypePath.toString(path, type)}`;
			ALREADY_ANNOTATED_ERROR_WITH_PATH.add(e);
		}
		throw e;
	}
}

/** Walk the given SimpleType in depth-first order; does not return a result. */
export function walkDepthFirst(
	path: SimpleTypePath,
	type: SimpleType,
	visitors: {
		/** Called before walking the steps inside a type */
		before: Visitor<void> | undefined;
		/** Called after walking the steps inside a type */
		after: Visitor<void> | undefined;
		/**  */
		traverse?: GenericListVisitor<SimpleType, SimpleTypePathStep>;
	}
) {
	walkRecursive<void>(path, type, args => {
		const traverse = visitors.traverse || mapAnyStep;
		visitors.before?.(args);
		traverse(args);
		visitors.after?.(args);
	});
}

// ============================================================================
// Kind-specific visitors.
// We should have a visitor in this tree for each edge from a type to another type.
// ============================================================================

type SimpleTypePathStepCallable = SimpleTypePathStepTypeParameter[] | SimpleTypePathStepParameter[] | SimpleTypePathStepReturn;
type SimpleTypePathStepIndexable = SimpleTypePathStepStringIndex | SimpleTypePathStepNumberIndex;
type SimpleTypePathStepObjectLike =
	| SimpleTypePathStepNamedMember[]
	| SimpleTypePathStepIndexable
	| SimpleTypePathStepCallSignature
	| SimpleTypePathStepCtorSignature
	| SimpleTypePathStepTypeParameter[];

/**
 * Map from a SimpleTypeKind to the steps you could take from that kind of SimpleType to another SimpleType.
 * If the kind has multiple edges of that type, they are declared as Step[].
 */
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

type CamelCase<S extends string> = S extends `${infer P1}_${infer P2}${infer P3}` ? `${Lowercase<P1>}${Uppercase<P2>}${CamelCase<P3>}` : Lowercase<S>;

/** The kind-specific visitor API. */
type SimpleTypePathStepVisitors = {
	// TODO: type magic to "fully flatten" these two mapped types together.
	[K in keyof SimpleTypeToPathStepMap]: {
		// single edge: map step name to camel case
		[SK in Extract<SimpleTypeToPathStepMap[K], SimpleTypePathStepBase> as CamelCase<SK["step"]>]: GenericVisitor<SimpleTypeKindMap[K], SK>;
	} &
		{
			// multi-edge: map step name to `map${StepNameAsCamel}s`
			[SK in Extract<SimpleTypeToPathStepMap[K], Array<any>> as CamelCase<`MAP_${SK[number]["step"]}S`>]: GenericListVisitor<SimpleTypeKindMap[K], SK[number]>;
		};
};

type FunctionVisitors = SimpleTypePathStepVisitors["FUNCTION"];
type MethodVisitors = SimpleTypePathStepVisitors["METHOD"];

class CallableVisitors implements FunctionVisitors, MethodVisitors {
	mapTypeParameters: FunctionVisitors["mapTypeParameters"] & MethodVisitors["mapTypeParameters"] = ({ visit, type }) =>
		type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param));
	mapParameters: FunctionVisitors["mapParameters"] & MethodVisitors["mapParameters"] = ({ visit, type }) =>
		type.parameters?.map((param, i) => visit({ from: type, index: i, step: "PARAMETER", parameter: param }, param.type));
	return: FunctionVisitors["return"] & MethodVisitors["return"] = ({ visit, type }) => type.returnType && visit({ from: type, step: "RETURN" }, type.returnType);
}

type InterfaceVisitors = SimpleTypePathStepVisitors["INTERFACE"];
type ObjectVisitors = SimpleTypePathStepVisitors["OBJECT"];
type ClassVisitors = SimpleTypePathStepVisitors["CLASS"];
class ObjectLikeVisitors implements InterfaceVisitors, ObjectVisitors, ClassVisitors {
	mapTypeParameters: InterfaceVisitors["mapTypeParameters"] & ObjectVisitors["mapTypeParameters"] & ClassVisitors["mapTypeParameters"] = ({ visit, type }) =>
		type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param));

	callSignature: InterfaceVisitors["callSignature"] & ObjectVisitors["callSignature"] & ClassVisitors["callSignature"] = ({ visit, type }) =>
		type.call && visit({ from: type, step: "CALL_SIGNATURE" }, type.call);
	ctorSignature: InterfaceVisitors["ctorSignature"] & ObjectVisitors["ctorSignature"] & ClassVisitors["ctorSignature"] = ({ visit, type }) =>
		type.ctor && visit({ from: type, step: "CTOR_SIGNATURE" }, type.ctor);

	mapNamedMembers: InterfaceVisitors["mapNamedMembers"] & ObjectVisitors["mapNamedMembers"] & ClassVisitors["mapNamedMembers"] = ({ visit, type }) =>
		type.members?.map((member, i) => visit({ from: type, index: i, step: "NAMED_MEMBER", member }, member.type));
	numberIndex: InterfaceVisitors["numberIndex"] & ObjectVisitors["numberIndex"] & ClassVisitors["numberIndex"] = ({ visit, type }) =>
		type.indexType?.NUMBER && visit({ from: type, step: "NUMBER_INDEX" }, type.indexType.NUMBER);
	stringIndex: InterfaceVisitors["stringIndex"] & ObjectVisitors["stringIndex"] & ClassVisitors["stringIndex"] = ({ visit, type }) =>
		type.indexType?.STRING && visit({ from: type, step: "STRING_INDEX" }, type.indexType.STRING);
}

const KindVisitors: SimpleTypePathStepVisitors = {
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
	INTERFACE: new ObjectLikeVisitors(),
	OBJECT: new ObjectLikeVisitors(),
	CLASS: new ObjectLikeVisitors(),
	FUNCTION: new CallableVisitors(),
	METHOD: new CallableVisitors(),
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

// ============================================================================
// Higher-level visitors
// ============================================================================

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

const mapJsonStep: GenericListVisitor<SimpleType, SimpleTypePathStep> = ({ type, path, visit }) => {
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

/**
 * Visitors for path steps from a SimpleType to other SimpleTypes.
 * Use these to implement your own type traversals, or inside {@link walkRecursive}.
 */
export const Visitor = {
	...KindVisitors,
	/** Visit all concrete object properties. Ignores function types and generics */
	mapJsonStep,
	/** Visit all possible steps into the given type. */
	mapAnyStep
};

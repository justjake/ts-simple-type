import {
	SimpleType,
	SimpleTypeAlias,
	SimpleTypeArray,
	SimpleTypeClass,
	SimpleTypeEnum,
	SimpleTypeEnumMember,
	SimpleTypeFunction,
	SimpleTypeGenericArguments,
	SimpleTypeGenericParameter,
	SimpleTypeInterface,
	SimpleTypeIntersection,
	SimpleTypeKindMap,
	SimpleTypeMethod,
	SimpleTypeObject,
	SimpleTypePromise,
	SimpleTypeTuple,
	SimpleTypeUnion
} from "./simple-type";
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

	static preventCycles<T>(visitor: Visitor<T>): Visitor<T | Cyclical> {
		const preventCyclesVisitor: Visitor<T | Cyclical> = args => {
			const cycle = SimpleTypePath.getSubpathFrom(args.path, args.type);
			if (cycle) {
				return new Cyclical(cycle);
			}
			return visitor(args as never);
		};
		return preventCyclesVisitor;
	}

	constructor(public readonly cycle: SimpleTypePath) {}
}

interface VisitChild<T, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	/** Visit the given type with the current visitor */
	(step: Step, type: SimpleType): T;
	/** Visit the given type with a different visitor */
	<R>(step: Step, type: SimpleType, fn: Visitor<R>): R;
	/**
	 * Create a new recursive function with a different visitor.
	 * @warning Currently type inference in GenericVisitor doesn't seem to work for this use-case.
	 */
	with<R>(fn: Visitor<R>): VisitChild<R>;
}

export interface VisitorArgs<T, ST extends SimpleType = SimpleType, Step extends SimpleTypePath | SimpleTypePath[number] | undefined = SimpleTypePath | SimpleTypePath[number] | undefined> {
	type: ST;
	path: SimpleTypePath;
	visit: VisitChild<T, Step>;
}

export type Visitor<T, ST extends SimpleType = SimpleType> = (args: VisitorArgs<T, ST>) => T;
export type GenericVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitorArgs<T, TypeKind, StepKind>) => T;
export type GenericMaybeVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitorArgs<T, TypeKind, StepKind>) => T | undefined;
export type GenericListVisitor<TypeKind extends SimpleType, StepKind extends SimpleTypePathStep> = <T>(args: VisitorArgs<T, TypeKind, StepKind>) => Array<T>;

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
 * @returns result of `fn`
 */
export function walkRecursive<T>(path: SimpleTypePath, type: SimpleType, fn: Visitor<T>): T {
	const args: VisitorArgs<T> = {
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
	ENUM_MEMBER: SimpleTypePathStepAliased;
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
		[SK in Extract<SimpleTypeToPathStepMap[K], SimpleTypePathStepBase> as CamelCase<SK["step"]>]: GenericMaybeVisitor<SimpleTypeKindMap[K], SK>;
	} &
		{
			// multi-edge: map step name to `map${StepNameAsCamel}s`
			[SK in Extract<SimpleTypeToPathStepMap[K], Array<any>> as CamelCase<`MAP_${SK[number]["step"]}S`>]: GenericListVisitor<SimpleTypeKindMap[K], SK[number]>;
		};
};

type FunctionVisitors = SimpleTypePathStepVisitors["FUNCTION"];
type MethodVisitors = SimpleTypePathStepVisitors["METHOD"];

class CallableVisitors implements FunctionVisitors, MethodVisitors {
	static instance = new this();

	mapTypeParameters: GenericListVisitor<SimpleTypeFunction | SimpleTypeMethod, SimpleTypePathStepTypeParameter> = ({ visit, type }) =>
		type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param)) ?? [];
	mapParameters: GenericListVisitor<SimpleTypeFunction | SimpleTypeMethod, SimpleTypePathStepParameter> = ({ visit, type }) =>
		type.parameters?.map((param, i) => visit({ from: type, index: i, step: "PARAMETER", parameter: param }, param.type)) ?? [];
	return: GenericMaybeVisitor<SimpleTypeFunction | SimpleTypeMethod, SimpleTypePathStepReturn> = ({ visit, type }) => type.returnType && visit({ from: type, step: "RETURN" }, type.returnType);
}

type EnumVisitors = SimpleTypePathStepVisitors["ENUM"];
type UnionVisitors = SimpleTypePathStepVisitors["UNION"];
type IntersectionVisitors = SimpleTypePathStepVisitors["INTERSECTION"];

class VariantTypesVisitors implements EnumVisitors, UnionVisitors, IntersectionVisitors {
	static instance = new this();

	mapVariants: GenericListVisitor<SimpleTypeUnion | SimpleTypeEnum | SimpleTypeIntersection, SimpleTypePathStepVariant> = ({ visit, type }) =>
		type.types.map((variant, i) => visit({ from: type, index: i, step: "VARIANT" }, variant));
}

type InterfaceVisitors = SimpleTypePathStepVisitors["INTERFACE"];
type ObjectVisitors = SimpleTypePathStepVisitors["OBJECT"];
type ClassVisitors = SimpleTypePathStepVisitors["CLASS"];

class ObjectLikeVisitors implements InterfaceVisitors, ObjectVisitors, ClassVisitors {
	static instance = new this();

	mapTypeParameters: GenericListVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepTypeParameter> = ({ visit, type }) =>
		type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param)) ?? [];

	callSignature: GenericMaybeVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepCallSignature> = ({ visit, type }) =>
		type.call && visit({ from: type, step: "CALL_SIGNATURE" }, type.call);
	ctorSignature: GenericMaybeVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepCtorSignature> = ({ visit, type }) =>
		type.ctor && visit({ from: type, step: "CTOR_SIGNATURE" }, type.ctor);

	mapNamedMembers: GenericListVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepNamedMember> = ({ visit, type }) =>
		type.members?.map((member, i) => visit({ from: type, index: i, step: "NAMED_MEMBER", member }, member.type)) ?? [];
	numberIndex: GenericMaybeVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepNumberIndex> = ({ visit, type }) =>
		type.indexType?.NUMBER && visit({ from: type, step: "NUMBER_INDEX" }, type.indexType.NUMBER);
	stringIndex: GenericMaybeVisitor<SimpleTypeInterface | SimpleTypeObject | SimpleTypeClass, SimpleTypePathStepStringIndex> = ({ visit, type }) =>
		type.indexType?.STRING && visit({ from: type, step: "STRING_INDEX" }, type.indexType.STRING);
}

type GenericArgumentsVisitorsT = SimpleTypePathStepVisitors["GENERIC_ARGUMENTS"];
class GenericArgumentsVisitors implements GenericArgumentsVisitorsT {
	static instance = new this();

	aliased: GenericVisitor<SimpleTypeGenericArguments, SimpleTypePathStepAliased> = ({ visit, type }) => visit({ from: type, step: "ALIASED" }, type.instantiated);
	genericTarget: GenericVisitor<SimpleTypeGenericArguments, SimpleTypePathStepGenericTarget> = ({ visit, type }) => visit({ from: type, step: "GENERIC_TARGET" }, type.target);
	mapGenericArguments: GenericListVisitor<SimpleTypeGenericArguments, SimpleTypePathStepGenericArgument> = ({ visit, type }) =>
		type.typeArguments.map((arg, i) => visit({ from: type, index: i, step: "GENERIC_ARGUMENT", name: arg.name }, arg));
}

type GenericParameterVisitorsT = SimpleTypePathStepVisitors["GENERIC_PARAMETER"];
class GenericParameterVisitors implements GenericParameterVisitorsT {
	static instance = new this();

	typeParameterConstraint: GenericMaybeVisitor<SimpleTypeGenericParameter, SimpleTypePathStepTypeParameterConstraint> = ({ visit, type }) =>
		type.constraint && visit({ from: type, step: "TYPE_PARAMETER_CONSTRAINT" }, type.constraint);
	typeParameterDefault: GenericMaybeVisitor<SimpleTypeGenericParameter, SimpleTypePathStepTypeParameterDefault> = ({ visit, type }) =>
		type.default && visit({ from: type, step: "TYPE_PARAMETER_DEFAULT" }, type.default);
}

type TupleVisitorsT = SimpleTypePathStepVisitors["TUPLE"];
class TupleVisitors implements TupleVisitorsT {
	static instance = new this();

	mapIndexedMembers: GenericListVisitor<SimpleTypeTuple, SimpleTypePathStepIndexedMember> = ({ visit, type }) =>
		type.members?.map((member, i) => visit({ from: type, index: i, step: "INDEXED_MEMBER", member }, member.type));
}

type AliasVisitors = SimpleTypePathStepVisitors["ALIAS"];
class AliasVisitorsImpl implements AliasVisitors {
	static instance = new this();

	mapIndexedMembers: GenericListVisitor<SimpleTypeTuple, SimpleTypePathStepIndexedMember> = ({ visit, type }) =>
		type.members?.map((member, i) => visit({ from: type, index: i, step: "INDEXED_MEMBER", member }, member.type));

	aliased: GenericVisitor<SimpleTypeAlias, SimpleTypePathStepAliased> = ({ visit, type }) => visit({ from: type, step: "ALIASED" }, type.target);
	mapTypeParameters: GenericListVisitor<SimpleTypeAlias, SimpleTypePathStepTypeParameter> = ({ visit, type }) =>
		type.typeParameters?.map((param, i) => visit({ from: type, index: i, step: "TYPE_PARAMETER", name: param.name }, param)) ?? [];
}
type ArrayVisitorsT = SimpleTypePathStepVisitors["ARRAY"];
class ArrayVisitors implements ArrayVisitorsT {
	static instance = new this();

	numberIndex: GenericVisitor<SimpleTypeArray, SimpleTypePathStepNumberIndex> = ({ visit, type }) => visit({ from: type, step: "NUMBER_INDEX" }, type.type);
}

type PromiseVisitorsT = SimpleTypePathStepVisitors["PROMISE"];
class PromiseVisitors implements PromiseVisitorsT {
	static instance = new this();

	awaited: GenericVisitor<SimpleTypePromise, SimpleTypePathStepAwaited> = ({ visit, type }) => visit({ from: type, step: "AWAITED" }, type.type);
}
type EnumMemberVisitorsT = SimpleTypePathStepVisitors["ENUM_MEMBER"];
class EnumMemberVisitors implements EnumMemberVisitorsT {
	static instance = new this();

	aliased: GenericVisitor<SimpleTypeEnumMember, SimpleTypePathStepAliased> = ({ visit, type }) => visit({ from: type, step: "ALIASED" }, type.type);
}

const KindVisitors = {
	ENUM: VariantTypesVisitors.instance,
	UNION: VariantTypesVisitors.instance,
	INTERSECTION: VariantTypesVisitors.instance,
	INTERFACE: ObjectLikeVisitors.instance,
	OBJECT: ObjectLikeVisitors.instance,
	CLASS: ObjectLikeVisitors.instance,
	FUNCTION: CallableVisitors.instance,
	METHOD: CallableVisitors.instance,
	GENERIC_ARGUMENTS: GenericArgumentsVisitors.instance,
	GENERIC_PARAMETER: GenericParameterVisitors.instance,
	TUPLE: TupleVisitors.instance,
	ALIAS: AliasVisitorsImpl.instance,
	ARRAY: ArrayVisitors.instance,
	PROMISE: PromiseVisitors.instance,
	ENUM_MEMBER: EnumMemberVisitors.instance
};

type Assert<T, U extends T> = U;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _assertKindVisitorsIsCorrect = Assert<SimpleTypePathStepVisitors, typeof KindVisitors>;

// ============================================================================
// Higher-level visitors
// ============================================================================

export const mapAnyStep: GenericListVisitor<SimpleType, SimpleTypePathStep> = ({ type, path, visit }) => {
	if (type.kind in Visitor) {
		const visitors = Visitor[type.kind as keyof SimpleTypePathStepVisitors];
		let results: unknown[] = [];
		for (const [name, _visitor] of Object.entries(visitors)) {
			const visitor = _visitor as GenericMaybeVisitor<SimpleType, SimpleTypePathStep> | GenericListVisitor<SimpleType, SimpleTypePathStep>;
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
		return [];
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

	return [];
};

export type SimpleTypeKindVisitors<T> = {
	[ST in SimpleType as ST["kind"]]: Visitor<T, ST>;
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

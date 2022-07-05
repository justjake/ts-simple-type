import * as ts from "typescript";
import * as tsModule from "typescript";
import { Declaration, Node, Signature, SignatureDeclaration, Symbol as ESSymbol, Type, TypeChecker } from "typescript";
import { inspect } from "util";
import { DEFAULT_TYPE_CACHE } from "../constants";
import {
	isSimpleType,
	SimpleType,
	SimpleTypeEnumMember,
	SimpleTypeFunction,
	SimpleTypeFunctionParameter,
	SimpleTypeGenericArguments,
	SimpleTypeGenericParameter,
	SimpleTypeInterface,
	SimpleTypeLiteral,
	SimpleTypeMemberNamed,
	SimpleTypeMethod,
	SimpleTypeObject
} from "../simple-type";
import { getTypescriptModule } from "../ts-module";
import { simplifySimpleTypes } from "../utils/simple-type-util";
import {
	getDeclaration,
	getModifiersFromDeclaration,
	getTypeArguments,
	getTypeOfSymbol,
	isAlias,
	isArray,
	isBigInt,
	isBigIntLiteral,
	isBoolean,
	isBooleanLiteral,
	isDate,
	isEnum,
	isESSymbolLike,
	isFunction,
	isImplicitGeneric,
	isInstantiated,
	isLiteral,
	isMethod,
	isMethodSignature,
	isNever,
	isNode,
	isNonPrimitive,
	isNull,
	isNumber,
	isObject,
	isObjectTypeReference,
	isPromise,
	isString,
	isSymbol,
	isThisType,
	isTupleTypeReference,
	isType,
	isUndefined,
	isUniqueESSymbol,
	isUnknown,
	isVoid,
	symbolIsOptional
} from "../utils/ts-util";

export interface ToSimpleTypeOptions {
	eager?: boolean;
	cache?: WeakMap<Type, SimpleType>;
	/** Add methods like .getType(), .getTypeChecker() to each simple type */
	addMethods?: boolean;
	/** Add { kind: "ALIAS" } wrapper types around simple aliases. Otherwise, remove these wrappers. */
	preserveSimpleAliases?: boolean;
}

interface ToSimpleTypeInternalOptions {
	cache: WeakMap<Type, SimpleType>;
	checker: TypeChecker;
	ts: typeof tsModule;
	eager?: boolean;
	addMethods?: boolean;
	preserveSimpleAliases?: boolean;
}

/**
 * Converts a Typescript type to a "SimpleType"
 * @param type The type to convert.
 * @param checker
 * @param options
 */
export function toSimpleType(type: SimpleType, checker?: TypeChecker, options?: ToSimpleTypeOptions): SimpleType;
export function toSimpleType(type: Node, checker: TypeChecker, options?: ToSimpleTypeOptions): SimpleType;
export function toSimpleType(type: Type, checker: TypeChecker, options?: ToSimpleTypeOptions): SimpleType;
export function toSimpleType(type: Type | Node | SimpleType, checker: TypeChecker, options?: ToSimpleTypeOptions): SimpleType;
export function toSimpleType(type: Type | Node | SimpleType, checker?: TypeChecker, options: ToSimpleTypeOptions = {}): SimpleType {
	if (isSimpleType(type)) {
		return type;
	}

	checker = checker!;

	if (isNode(type)) {
		// "type" is a "Node", convert it to a "Type" and continue.
		return toSimpleType(checker.getTypeAtLocation(type), checker);
	}

	return toSimpleTypeCached(type, {
		checker,
		eager: options.eager,
		cache: options.cache || DEFAULT_TYPE_CACHE,
		addMethods: options.addMethods,
		preserveSimpleAliases: options.preserveSimpleAliases,
		ts: getTypescriptModule()
	});
}

function toSimpleTypeCached(type: Type, options: ToSimpleTypeInternalOptions): SimpleType {
	if (options.cache.has(type)) {
		return options.cache.get(type)!;
	}

	// This function will resolve the type and assign the content to "target".
	// This way we can cache "target" before calling "toSimpleTypeInternal" recursively
	const resolveType = (target: SimpleType): void => {
		// Construct the simple type recursively
		//const simpleTypeOverwrite = options.cache.has(type) ? options.cache.get(type)! : toSimpleTypeInternal(type, options);
		const simpleTypeOverwrite = toSimpleTypeInternal(type, options);

		// Strip undefined keys to make the output cleaner
		Object.entries(simpleTypeOverwrite).forEach(([k, v]) => {
			if (v == null) delete simpleTypeOverwrite[k as keyof typeof simpleTypeOverwrite];
		});

		// Transfer properties on the simpleType to the placeholder
		// This makes it possible to keep on using the reference "placeholder".
		Object.assign(target, simpleTypeOverwrite);
	};

	if (options.eager === true) {
		// Make and cache placeholder
		const placeholder = {} as SimpleType;
		options.cache.set(type, placeholder);

		// Resolve type into placeholder
		resolveType(placeholder);

		Object.freeze(placeholder);
		return placeholder;
	} else {
		const placeholder = {} as SimpleType;

		// A function that only resolves the type once
		let didResolve = false;
		const ensureResolved = () => {
			if (!didResolve) {
				resolveType(placeholder);
				didResolve = true;
			}
		};

		// Use "toStringTag" as a hook into resolving the type.
		// If we don't have this hook, console.log would always print "{}" because the type hasn't been resolved
		Object.defineProperty(placeholder, Symbol.toStringTag, {
			get(): string {
				resolveType(placeholder);
				// Don't return any tag. Only use this function as a hook for calling "resolveType"
				return undefined as never;
			}
		});

		// Return a proxy with the purpose of resolving the type lazy
		const proxy = new Proxy(placeholder, {
			ownKeys(target: SimpleType) {
				ensureResolved();
				return [...Object.getOwnPropertyNames(target), ...Object.getOwnPropertySymbols(target)];
			},
			has(target: SimpleType, p: PropertyKey) {
				// Always return true if we test for "kind", but don't resolve the type
				// This way "isSimpleType" (which checks for "kind") will succeed without resolving the type
				if (p === "kind") {
					return true;
				}

				ensureResolved();
				return p in target;
			},
			getOwnPropertyDescriptor(target: SimpleType, p: keyof SimpleType) {
				ensureResolved();
				return Object.getOwnPropertyDescriptor(target, p);
			},
			get: (target: SimpleType, p: keyof SimpleType) => {
				ensureResolved();
				return target[p];
			},
			set: (target: SimpleType, p: keyof SimpleType) => {
				throw new TypeError(`Cannot assign to read only property '${p}'`);
			}
		});

		options.cache.set(type, proxy);

		return proxy;
	}
}

/**
 * Tries to lift a potential generic type and wrap the result in a "GENERIC_ARGUMENTS" simple type and/or "ALIAS" type.
 * Returns the "simpleType" otherwise.
 * @param simpleType
 * @param type
 * @param options
 */
function liftGenericType(type: Type, options: ToSimpleTypeInternalOptions): { generic: (instantiated: SimpleType) => SimpleType; instantiated: Type } | undefined {
	const enhance = (instantiated: SimpleType) => withMethods(instantiated, type, options);
	const wrapIfAlias = (instantiated: SimpleType, ignoreTypeParams?: boolean): SimpleType => {
		if (isAlias(type, options.ts)) {
			const aliasName = type.aliasSymbol!.getName() || "";
			// console.log("wrap if alias: was alias", aliasName);
			// TODO: if we're an instantiation of an alias, we don't want the params.
			// currently we always get params, leading to double-wrapping of a generic, when sometimes
			// we should just be the instantiation of a generic.
			const aliasDeclaration = getDeclaration(type.aliasSymbol, options.ts);
			const typeParameters = getTypeParameters(aliasDeclaration, options);

			if (!options.preserveSimpleAliases && (ignoreTypeParams || !typeParameters?.length)) {
				return {
					...instantiated,
					name: aliasName || instantiated.name
				} as SimpleType;
			}

			return {
				kind: "ALIAS",
				name: aliasName,
				target: instantiated,
				typeParameters
			};
		} else {
			return instantiated;
		}
	};

	// Check if the type is a generic interface/class reference and lift it.
	// TODO: we need to track down instantiated types that were instantiated with a "mapper".
	//       currently, don't know how to squeeze the type arguments out of those...
	//       will need to do more research, or find a hacky way.
	if (isObject(type, options.ts) && (isObjectTypeReference(type, options.ts) || isInstantiated(type, options.ts)) /* TODO: figure this case out */) {
		const typeArguments = getTypeArguments(type, options.checker, options.ts);
		if (typeArguments.length > 0) {
			// Special case for array, tuple and promise, they are generic in themselves
			if (isImplicitGeneric(type, options.checker, options.ts)) {
				return undefined;
			}

			if (type.target === type) {
				// Circular self-target.
				// No need for a wrapper, we can infer this generic interface type correctly
				return undefined;
			}

			return {
				instantiated: type,
				generic: instantiated => {
					const typeArgumentsSimpleType = typeArguments.map(t => toSimpleTypeCached(t, options));

					const generic: SimpleTypeGenericArguments = {
						kind: "GENERIC_ARGUMENTS",
						target: toSimpleTypeCached(type.target, options) as any,
						instantiated,
						typeArguments: typeArgumentsSimpleType
					};

					// This makes current tests work, but may be actually incorrect.
					//                                  vvvvvv
					return enhance(wrapIfAlias(generic, true));
				}
			};
		}
	}

	if (isAlias(type, options.ts)) {
		return {
			// TODO: better type safety
			instantiated: (type as any).target || type,
			generic: instantiated => {
				return enhance(wrapIfAlias(instantiated));
			}
		};
	}

	return undefined;
}

function withMethods(obj: SimpleType, type: Type, options: ToSimpleTypeInternalOptions): SimpleType {
	if (!options.addMethods) {
		return obj;
	}

	return {
		...obj,
		getType: () => type,
		getTypeChecker: () => options.checker,
		getSymbol: () => type.getSymbol()
	};
}

function toSimpleTypeInternal(type: Type, options: ToSimpleTypeInternalOptions): SimpleType {
	const { checker, ts } = options;

	const symbol: ESSymbol | undefined = type.getSymbol();
	const name = symbol != null ? getRealSymbolName(symbol, ts) : undefined;

	let simpleType: SimpleType | undefined;

	const generic = liftGenericType(type, options);
	if (generic != null) {
		type = generic.instantiated;
	}

	const enhance = (obj: SimpleType) => withMethods(obj, type, options);

	// Literal types
	if (isLiteral(type, ts)) {
		const literalSimpleType = primitiveLiteralToSimpleType(type, checker, ts);
		if (literalSimpleType != null) {
			// Enum members
			if (symbol != null && symbol.flags & ts.SymbolFlags.EnumMember) {
				const parentSymbol = (symbol as ESSymbol & { parent: ESSymbol | undefined }).parent;

				if (parentSymbol != null) {
					return enhance({
						name: name || "",
						fullName: `${parentSymbol.name}.${name}`,
						kind: "ENUM_MEMBER",
						type: literalSimpleType
					});
				}
			}

			// Literals types
			return enhance(literalSimpleType);
		}
	}

	// Primitive types
	else if (isString(type, ts)) {
		simpleType = { kind: "STRING", name };
	} else if (isNumber(type, ts)) {
		simpleType = { kind: "NUMBER", name };
	} else if (isBoolean(type, ts)) {
		simpleType = { kind: "BOOLEAN", name };
	} else if (isBigInt(type, ts)) {
		simpleType = { kind: "BIG_INT", name };
	} else if (isESSymbolLike(type, ts)) {
		simpleType = { kind: "ES_SYMBOL", name };
	} else if (isUndefined(type, ts)) {
		simpleType = { kind: "UNDEFINED", name };
	} else if (isNull(type, ts)) {
		simpleType = { kind: "NULL", name };
	} else if (isUnknown(type, ts)) {
		simpleType = { kind: "UNKNOWN", name };
	} else if (isVoid(type, ts)) {
		simpleType = { kind: "VOID", name };
	} else if (isNever(type, ts)) {
		simpleType = { kind: "NEVER", name };
	}

	// Enum
	else if (isEnum(type, ts) && type.isUnion()) {
		simpleType = {
			name: name || "",
			kind: "ENUM",
			types: type.types.map(t => toSimpleTypeCached(t, options) as SimpleTypeEnumMember)
		};
	}

	// Promise
	else if (isPromise(type, checker, ts)) {
		simpleType = {
			kind: "PROMISE",
			name,
			type: toSimpleTypeCached(getTypeArguments(type, checker, ts)[0], options)
		};
	}

	// Unions and intersections
	else if (type.isUnion()) {
		simpleType = {
			kind: "UNION",
			types: simplifySimpleTypes(type.types.map(t => toSimpleTypeCached(t, options))),
			name
		};
	} else if (type.isIntersection()) {
		simpleType = {
			kind: "INTERSECTION",
			types: simplifySimpleTypes(type.types.map(t => toSimpleTypeCached(t, options))),
			name
		};
	}

	// Date
	else if (isDate(type, ts)) {
		simpleType = {
			kind: "DATE",
			name
		};
	}

	// Array
	else if (isArray(type, checker, ts)) {
		simpleType = {
			kind: "ARRAY",
			type: toSimpleTypeCached(getTypeArguments(type, checker, ts)[0], options),
			name
		};
	} else if (isTupleTypeReference(type, ts)) {
		const types = getTypeArguments(type, checker, ts);

		const minLength = type.target.minLength;

		simpleType = {
			kind: "TUPLE",
			rest: type.target.hasRestElement || false,
			members: types.map((childType, i) => {
				return {
					optional: i >= minLength,
					type: toSimpleTypeCached(childType, options)
				};
			}),
			name
		};
	}

	// Method signatures
	else if (isMethodSignature(type, ts)) {
		const callSignatures = type.getCallSignatures();
		simpleType = getSimpleFunctionFromCallSignatures(callSignatures, options);
	}

	// Class
	else if (type.isClass() && symbol != null) {
		const classDecl = getDeclaration(symbol, ts);

		if (classDecl != null && ts.isClassDeclaration(classDecl)) {
			const ctor = (() => {
				const ctorSymbol = symbol != null && symbol.members != null ? symbol.members.get("__constructor" as never) : undefined;
				if (ctorSymbol != null && symbol != null) {
					const ctorDecl = ctorSymbol.declarations !== undefined && ctorSymbol.declarations?.length > 0 ? ctorSymbol.declarations[0] : ctorSymbol.valueDeclaration;

					if (ctorDecl != null && ts.isConstructorDeclaration(ctorDecl)) {
						return getSimpleFunctionFromSignatureDeclaration(ctorDecl, options) as SimpleTypeFunction;
					}
				}
			})();

			const call = getSimpleFunctionFromCallSignatures(type.getCallSignatures(), options) as SimpleTypeFunction;

			const members = checker
				.getPropertiesOfType(type)
				.map(symbol => {
					const declaration = getDeclaration(symbol, ts);
					// Some instance properties may have an undefined declaration.
					// Since we can't do too much without a declaration, filtering
					// these out seems like the best strategy for the moment.
					//
					// See https://github.com/runem/web-component-analyzer/issues/60 for
					// more info.
					if (declaration == null) return null;

					const result: Writable<SimpleTypeMemberNamed> = {
						name: symbol.name,
						type: toSimpleTypeCached(checker.getTypeAtLocation(declaration), options)
					};
					if (symbolIsOptional(symbol, ts)) {
						result.optional = true;
					}
					const modifiers = getModifiersFromDeclaration(declaration, ts);
					if (modifiers.length > 0) {
						result.modifiers = modifiers;
					}
					return result;
				})
				.filter((member): member is NonNullable<typeof member> => member != null);

			const typeParameters = getTypeParameters(getDeclaration(symbol, ts), options);

			simpleType = {
				kind: "CLASS",
				name,
				call,
				ctor,
				typeParameters,
				members
			};
		}
	}

	// Interface
	else if ((type.isClassOrInterface() || isObject(type, ts)) && !(symbol?.name === "Function")) {
		// Handle the empty object
		if (isObject(type, ts) && symbol?.name === "Object") {
			return {
				kind: "OBJECT"
			};
		}

		const members = type.getProperties().map(symbol => {
			const declaration = getDeclaration(symbol, ts);
			const result: Writable<SimpleTypeMemberNamed> = {
				name: symbol.name,
				type: toSimpleTypeCached(getTypeOfSymbol(symbol, options.checker, ts), options)
			};

			if (symbolIsOptional(symbol, ts)) {
				result.optional = true;
			}

			const modifiers = declaration != null ? getModifiersFromDeclaration(declaration, ts) : [];
			if (modifiers.length) {
				result.modifiers = modifiers;
			}

			return result;
		});

		const ctor = getSimpleFunctionFromCallSignatures(type.getConstructSignatures(), options) as SimpleTypeFunction;

		const call = getSimpleFunctionFromCallSignatures(type.getCallSignatures(), options) as SimpleTypeFunction;

		const typeParameters =
			(type.isClassOrInterface() && type.typeParameters != null ? type.typeParameters.map(t => toSimpleTypeCached(t, options) as SimpleTypeGenericParameter) : undefined) ||
			(symbol != null ? getTypeParameters(getDeclaration(symbol, ts), options) : undefined);

		let indexType: SimpleTypeInterface["indexType"] = {};
		if (type.getStringIndexType()) {
			indexType["STRING"] = toSimpleTypeCached(type.getStringIndexType()!, options);
		}
		if (type.getNumberIndexType()) {
			indexType["NUMBER"] = toSimpleTypeCached(type.getNumberIndexType()!, options);
		}
		if (Object.keys(indexType).length === 0) {
			indexType = undefined;
		}

		// Simplify: if there is only a single "call" signature and nothing else, just return the call signature
		/*if (call != null && members.length === 0 && ctor == null && indexType == null) {
			return { ...call, name, typeParameters };
		}*/

		const result: Writable<SimpleTypeInterface | SimpleTypeObject> = {
			kind: type.isClassOrInterface() ? "INTERFACE" : "OBJECT",
			name
		};
		if (typeParameters) {
			result.typeParameters = typeParameters;
		}
		if (ctor) {
			result.ctor = ctor;
		}
		if (members) {
			result.members = members;
		}
		if (indexType) {
			result.indexType = indexType;
		}
		if (call) {
			result.call = call;
		}
		simpleType = result;
	}

	// Handle "object" type
	else if (isNonPrimitive(type, ts)) {
		return enhance({
			kind: "NON_PRIMITIVE"
		});
	}

	// Function
	else if (symbol != null && (isFunction(type, ts) || isMethod(type, ts))) {
		simpleType = getSimpleFunctionFromCallSignatures(type.getCallSignatures(), options, name);

		if (simpleType == null) {
			simpleType = {
				kind: "FUNCTION",
				name
			};
		}
	}

	// Type Parameter
	else if (type.isTypeParameter() && symbol != null) {
		// This type
		if (isThisType(type, ts) && symbol.valueDeclaration != null) {
			return toSimpleTypeCached(checker.getTypeAtLocation(symbol.valueDeclaration), options);
		}

		const defaultType = type.getDefault();
		const constraint = type.getConstraint();
		const constraintSimpleType = constraint != null ? toSimpleTypeCached(constraint, options) : undefined;
		const defaultSimpleType = defaultType != null ? toSimpleTypeCached(defaultType, options) : undefined;

		simpleType = {
			kind: "GENERIC_PARAMETER",
			name: symbol.getName(),
			default: defaultSimpleType,
			constraint: constraintSimpleType
		} as SimpleTypeGenericParameter;
	}

	// If no type was found, return "ANY"
	if (simpleType == null) {
		simpleType = {
			kind: "ANY",
			error: "Not supported",
			name
		};
	}

	// Lift generic types and aliases if possible
	if (generic != null) {
		return generic.generic(enhance(simpleType));
	}

	return enhance(simpleType);
}

function primitiveLiteralToSimpleType(type: Type, checker: TypeChecker, ts: typeof tsModule): SimpleTypeLiteral | undefined {
	if (type.isNumberLiteral()) {
		return {
			kind: "NUMBER_LITERAL",
			value: type.value
		};
	} else if (type.isStringLiteral()) {
		return {
			kind: "STRING_LITERAL",
			value: type.value
		};
	} else if (isBooleanLiteral(type, ts)) {
		// See https://github.com/Microsoft/TypeScript/issues/22269 for more information
		return {
			kind: "BOOLEAN_LITERAL",
			value: checker.typeToString(type) === "true"
		};
	} else if (isBigIntLiteral(type, ts)) {
		return {
			kind: "BIG_INT_LITERAL",
			/* global BigInt */
			value: BigInt(`${type.value.negative ? "-" : ""}${type.value.base10Value}`)
		};
	} else if (isUniqueESSymbol(type, ts)) {
		return {
			kind: "ES_SYMBOL_UNIQUE",
			value: String(type.escapedName) || Math.floor(Math.random() * 100000000).toString()
		};
	}
}

function getSimpleFunctionFromCallSignatures(signatures: readonly Signature[], options: ToSimpleTypeInternalOptions, fallbackName?: string): SimpleTypeFunction | SimpleTypeMethod | undefined {
	if (signatures.length === 0) {
		return undefined;
	}

	const signature = signatures[signatures.length - 1];

	const signatureDeclaration = signature.getDeclaration();

	return getSimpleFunctionFromSignatureDeclaration(signatureDeclaration, options, fallbackName);
}

function getSimpleFunctionFromSignatureDeclaration(
	signatureDeclaration: SignatureDeclaration,
	options: ToSimpleTypeInternalOptions,
	fallbackName?: string
): SimpleTypeFunction | SimpleTypeMethod | undefined {
	const { checker } = options;

	const symbol = checker.getSymbolAtLocation(signatureDeclaration);

	const parameters = signatureDeclaration.parameters.map(parameterDecl => {
		const argType = checker.getTypeAtLocation(parameterDecl);

		return {
			name: parameterDecl.name.getText() || fallbackName,
			optional: parameterDecl.questionToken != null,
			type: toSimpleTypeCached(argType, options),
			rest: parameterDecl.dotDotDotToken != null,
			initializer: parameterDecl.initializer != null
		} as SimpleTypeFunctionParameter;
	});

	const name = symbol != null ? symbol.getName() : undefined;

	const type = checker.getTypeAtLocation(signatureDeclaration);

	const kind = isMethod(type, options.ts) ? "METHOD" : "FUNCTION";

	const signature = checker.getSignatureFromDeclaration(signatureDeclaration);

	const returnType = signature == null ? undefined : toSimpleTypeCached(checker.getReturnTypeOfSignature(signature), options);

	const typeParameters = getTypeParameters(signatureDeclaration, options);

	const tsTypePredicate = signature && checker.getTypePredicateOfSignature(signature);
	const typePredicateType = tsTypePredicate?.type && tsTypePredicate && toSimpleTypeCached(tsTypePredicate.type, options);
	const typePredicate = typePredicateType && {
		parameterName: tsTypePredicate.parameterName,
		parameterIndex: tsTypePredicate.parameterIndex,
		type: typePredicateType
	};

	return { name, kind, returnType, parameters, typeParameters, typePredicate } as SimpleTypeFunction | SimpleTypeMethod;
}

function getRealSymbolName(symbol: ESSymbol, ts: typeof tsModule): string | undefined {
	const name = symbol.getName();
	if (name != null && [ts.InternalSymbolName.Type, ts.InternalSymbolName.Object, ts.InternalSymbolName.Function].includes(name as never)) {
		return undefined;
	}

	return name;
}

function getTypeParameters(obj: ESSymbol | Declaration | undefined, options: ToSimpleTypeInternalOptions): SimpleTypeGenericParameter[] | undefined {
	if (obj == null) return undefined;

	if (isSymbol(obj)) {
		const decl = getDeclaration(obj, options.ts);
		return getTypeParameters(decl, options);
	}

	if (
		options.ts.isClassDeclaration(obj) ||
		options.ts.isFunctionDeclaration(obj) ||
		options.ts.isFunctionTypeNode(obj) ||
		options.ts.isTypeAliasDeclaration(obj) ||
		options.ts.isMethodDeclaration(obj) ||
		options.ts.isMethodSignature(obj)
	) {
		return obj.typeParameters == null
			? undefined
			: Array.from(obj.typeParameters)
					.map(td => options.checker.getTypeAtLocation(td))
					.map(t => toSimpleTypeCached(t, options) as SimpleTypeGenericParameter);
	}

	return undefined;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
function log(input: unknown, d = 3) {
	const str = inspect(input, { depth: d, colors: true });

	const flags = input && typeof input === "object" && isType(input) && debugTypeFlags(input);

	// eslint-disable-next-line no-console
	console.log(flags, str.replace(/checker: {[\s\S]*?}/g, ""));
}

export function debugTypeFlags(type: Type) {
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

type Writable<T> = {
	-readonly [K in keyof T]: T[K];
};

import { SimpleType, SimpleTypeFunctionParameter, SimpleTypeMember, SimpleTypeMemberNamed } from "./simple-type";
import { simpleTypeToString } from "./transform/simple-type-to-string";

type SimpleTypePathStepKind =
	| "NAMED_MEMBER"
	| "INDEXED_MEMBER"
	| "STRING_INDEX"
	| "NUMBER_INDEX"
	| "VARIANT" // Union, Intersection, Enum
	| "AWAITED"
	| "TYPE_PARAMETER"
	| "TYPE_PARAMETER_CONSTRAINT"
	| "TYPE_PARAMETER_DEFAULT"
	| "PARAMETER"
	| "RETURN"
	| "GENERIC_ARGUMENT"
	| "CALL_SIGNATURE"
	| "CTOR_SIGNATURE"
	| "GENERIC_TARGET"
	| "ALIASED";

export interface SimpleTypePathStepBase {
	step: SimpleTypePathStepKind;
	from: SimpleType; // TODO: should we really include the "from" type in the path?
}

export interface SimpleTypePathStepNamedMember extends SimpleTypePathStepBase {
	step: "NAMED_MEMBER";
	member: SimpleTypeMemberNamed; // TODO: omit type?
	index: number;
}

export interface SimpleTypePathStepIndexedMember extends SimpleTypePathStepBase {
	step: "INDEXED_MEMBER";
	member: SimpleTypeMember;
	index: number;
}

export interface SimpleTypePathStepStringIndex extends SimpleTypePathStepBase {
	step: "STRING_INDEX";
}

export interface SimpleTypePathStepNumberIndex extends SimpleTypePathStepBase {
	step: "NUMBER_INDEX";
}

/**
 * Variant in a union, intersection, or enum type.
 */
export interface SimpleTypePathStepVariant extends SimpleTypePathStepBase {
	step: "VARIANT";
	index: number;
}

export interface SimpleTypePathStepAwaited extends SimpleTypePathStepBase {
	step: "AWAITED";
}

export interface SimpleTypePathStepTypeParameter extends SimpleTypePathStepBase {
	step: "TYPE_PARAMETER";
	index: number;
	name: string;
}

export interface SimpleTypePathStepTypeParameterConstraint extends SimpleTypePathStepBase {
	step: "TYPE_PARAMETER_CONSTRAINT";
}

export interface SimpleTypePathStepTypeParameterDefault extends SimpleTypePathStepBase {
	step: "TYPE_PARAMETER_DEFAULT";
}

export interface SimpleTypePathStepParameter extends SimpleTypePathStepBase {
	step: "PARAMETER";
	index: number;
	parameter: SimpleTypeFunctionParameter; // TODO: omit type?
}

export interface SimpleTypePathStepReturn extends SimpleTypePathStepBase {
	step: "RETURN";
}

/** Visit a call signature of a interface or class type. Arguably could use "variant", but... */
export interface SimpleTypePathStepCallSignature extends SimpleTypePathStepBase {
	step: "CALL_SIGNATURE";
}

/** Visit a call signature of a interface or class type. Arguably could use "variant", but... */
export interface SimpleTypePathStepCtorSignature extends SimpleTypePathStepBase {
	step: "CTOR_SIGNATURE";
}

/**
 * Step from a generic instantiation (GENERIC_ARGUMENTS) to one of the arguments
 * used for the instantiation.
 *
 * ```typescript
 * interface Foo<T> {
 *   bar: T
 * }
 *
 * //                     vvvvvv GENERIC_ARGUMENT
 * type FooInstance = Foo<string>
 * //                 ^^^^^^^^^^^ GENERIC_ARGUMENTS
 * ```
 */
export interface SimpleTypePathStepGenericArgument extends SimpleTypePathStepBase {
	step: "GENERIC_ARGUMENT";
	index: number;
	name?: string;
}

/**
 * Step from a generic instantiation (GENERIC_ARGUMENTS) to the target of the
 * instantiation.
 *
 * ```typescript
 * interface Foo<T> {
 *   bar: T
 * }
 *
 * //                 vvv GENERIC_TARGET
 * type FooInstance = Foo<string>
 * //                 ^^^^^^^^^^^ GENERIC_ARGUMENTS
 * ```
 */
export interface SimpleTypePathStepGenericTarget extends SimpleTypePathStepBase {
	step: "GENERIC_TARGET";
}

export interface SimpleTypePathStepAliased extends SimpleTypePathStepBase {
	step: "ALIASED";
}

export type SimpleTypePathStep =
	| SimpleTypePathStepNamedMember
	| SimpleTypePathStepIndexedMember
	| SimpleTypePathStepStringIndex
	| SimpleTypePathStepNumberIndex
	| SimpleTypePathStepVariant
	| SimpleTypePathStepAwaited
	| SimpleTypePathStepTypeParameter
	| SimpleTypePathStepTypeParameterConstraint
	| SimpleTypePathStepTypeParameterDefault
	| SimpleTypePathStepCallSignature
	| SimpleTypePathStepCtorSignature
	| SimpleTypePathStepParameter
	| SimpleTypePathStepReturn
	| SimpleTypePathStepGenericArgument
	| SimpleTypePathStepGenericTarget
	| SimpleTypePathStepAliased;

/**
 * Describes a traversal path from a starting type to a destination type.
 *
 * Given this type:
 * ```typescript
 * type Deep = {
 *   foo: {
 *     [key: string]: () => string | number
 *                                // ^^^^^^
 *   }
 * }
 * ```
 *
 * A path from `Deep` to the `number` type highlighted would be:
 *
 * 1. NAMED_MEMBER (name foo)
 * 2. STRING_INDEX
 * 3. RETURN
 * 4. VARIANT (index 1)
 */
export type SimpleTypePath = SimpleTypePathStep[]; // TODO: consider single linked list to save memory?

export const SimpleTypePath = {
	empty(): SimpleTypePath {
		return [] as SimpleTypePath;
	},

	/** @returns true if `path` includes a step from `type`. */
	includes(path: SimpleTypePath, type: SimpleType): boolean {
		return path.some(step => step.from === type);
	},

	/** @returns A subpath from `fromType`, or undefined if not present in the path. */
	getSubpathFrom(path: SimpleTypePath, fromType: SimpleType): SimpleTypePath | undefined {
		const fromIndex = path.findIndex(step => step.from === fromType);
		if (fromIndex < 0) {
			return undefined;
		}

		return path.slice(fromIndex);
	},

	concat(prefix: SimpleTypePath, suffix: SimpleTypePath | SimpleTypePath[number] | undefined): SimpleTypePath {
		return suffix ? prefix.concat(suffix) : prefix.concat();
	},

	last(path: SimpleTypePath): SimpleTypePathStep | undefined {
		return path[path.length - 1];
	},

	toTypescript(path: SimpleTypePath): string {
		const parts: string[] = [];
		if (path.length === 0) {
			parts.push("T");
		}

		for (const step of path) {
			if (parts.length === 0) {
				parts.push(step.from.name ?? "T");
			}

			switch (step.step) {
				case "ALIASED":
					continue;
				case "AWAITED":
					parts.unshift("Awaited<");
					parts.push(">");
					continue;
				case "CALL_SIGNATURE":
				case "CTOR_SIGNATURE":
				case "GENERIC_TARGET":
					continue;
				case "INDEXED_MEMBER":
					parts.push(`[${step.index}]`);
					continue;
				case "NAMED_MEMBER":
					parts.push(`["${step.member.name}"]`);
					continue;
				case "NUMBER_INDEX":
					parts.push(`[number]`);
					continue;
				case "STRING_INDEX":
					parts.push(`[string]`);
					continue;
				case "PARAMETER":
					parts.unshift("Parameters<");
					parts.push(`>[${step.index}]`);
					continue;
				case "TYPE_PARAMETER":
				case "TYPE_PARAMETER_CONSTRAINT":
				case "TYPE_PARAMETER_DEFAULT":
					continue;
				case "VARIANT":
					continue;
				case "RETURN":
					parts.unshift("ReturnType<");
					parts.push(">");
					continue;
				case "GENERIC_ARGUMENT":
					continue;
				default:
					unreachable(step);
			}
		}

		return parts.join("");
	},

	toString(path: SimpleTypePath, target?: SimpleType): string {
		const arrow = (name: string) => `~${name}~>`;
		const typeName = (type: SimpleType) => {
			try {
				return type.name ?? simpleTypeToString(type);
			} catch (error) {
				return `(Error converting type to string: ${error})`;
			}
		};

		const parts: string[] = [];
		if (path.length === 0) {
			parts.push("T");
		}

		for (const step of path) {
			if (parts.length === 0) {
				parts.push(step.from.name ?? "T");
			}

			switch (step.step) {
				case "ALIASED":
					continue;
				case "AWAITED":
					parts.push(arrow("awaited"));
					break;
				case "CALL_SIGNATURE":
					parts.push(arrow("asFunction"));
					break;
				case "CTOR_SIGNATURE":
					parts.push(arrow("asConstructor"));
					break;
				case "GENERIC_ARGUMENT":
					parts.push(`<<${step.name ?? step.index}>>`);
					break;
				case "GENERIC_TARGET":
					parts.push(arrow("instantiatedFrom"));
					break;
				case "INDEXED_MEMBER": {
					const optional = step.member.optional ? "?" : "";
					parts.push(`[${step.index}]${optional}`);
					break;
				}
				case "NAMED_MEMBER": {
					const optional = step.member.optional ? "?" : "";
					// parts.push(`["${step.member.name}"]${optional}`);
					parts.push(`.${step.member.name}${optional}`);
					break;
				}
				case "NUMBER_INDEX": {
					parts.push(`[number]`);
					break;
				}
				case "PARAMETER":
					parts.push(arrow(`(${step.parameter.name ?? step.index})`));
					break;
				case "RETURN":
					parts.push(".()");
					break;
				case "STRING_INDEX":
					parts.push("[string]");
					break;
				case "TYPE_PARAMETER":
					parts.push(`<${step.name ?? step.index}>`);
					break;
				case "TYPE_PARAMETER_CONSTRAINT":
					parts.push(arrow("constraintType"));
					break;
				case "TYPE_PARAMETER_DEFAULT":
					parts.push(arrow("defaultType"));
					break;
				case "VARIANT": {
					switch (step.from.kind) {
						case "UNION":
							parts.push(arrow(`|${step.index}`));
							break;
						case "INTERSECTION":
							parts.push(arrow(`&${step.index}`));
							break;
						case "ENUM":
							parts.push(arrow(`.${step.index}`));
							break;
					}
					break;
				}
				default:
					unreachable(step);
			}
		}

		if (target) {
			parts.push(`: ${typeName(target)}`);
		}

		return parts.join("");
	}
} as const;

interface Foo<A extends Map<string, string>> {
	bar: A;
}

// path to Map<string, string>
// Foo<A extends>

export function unreachable(x: never): never {
	throw new Error(`Should be unreachable, instead exists: ${JSON.stringify(x)}`);
}

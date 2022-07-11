import test from "ava";
import { SourceNode } from "source-map";
import type * as ts from "typescript";
import {
	Cyclical,
	getTypescriptModule,
	isSimpleTypeLiteral,
	SimpleType,
	SimpleTypeFunction,
	SimpleTypeInterface,
	SimpleTypePath,
	SimpleTypePathStep,
	toSimpleType,
	ToSimpleTypeOptions,
	unreachable,
	VisitFnArgs,
	Visitor,
	walkRecursive
} from "../src";
import { simpleTypeToString } from "../src/transform/simple-type-to-string";
import { getTestTypes } from "./helpers/get-test-types";

const EXAMPLE_TS = `

export interface Table {
  header: string[]
  rows: string[][]
}

export interface Text {
  plain: string
  annotations: Annotation[]
}

export interface Annotation {
  type: string
  start: number
  end: number
  data: unknown
}

export interface Document {
  title: string
  author: string
  body: Array<Text | Table>
}

`;
const NO_SOURCE_LOCATION_FOUND = {
	source: null,
	line: null,
	column: null
};

type Chunks = Array<string | SourceNode> | SourceNode | string;

class SimpleTypeCompiler {
	constructor(public readonly checker: ts.TypeChecker) {}

	private compileCache = new WeakMap<SimpleType, SimpleTypeCompilerNode>();
	private toSimpleTypeOptions: ToSimpleTypeOptions = {
		addMethods: true,
		cache: new WeakMap<ts.Type, SimpleType>()
	};
	private names = new Map<string, number>();

	compileType(type: SimpleType | ts.Type, visitor: Visitor<SimpleTypeCompilerNode>): SimpleTypeCompilerNode {
		const simpleType = this.toSimpleType(type);
		const result = walkRecursive<SimpleTypeCompilerNode>(SimpleTypePath.empty(), simpleType, args => {
			if (this.compileCache.has(args.type)) {
				return this.compileCache.get(args.type)!;
			}

			const result = visitor(args);
			if (result.cacheable) {
				this.compileCache.set(args.type, result);
			}
			return result;
		});
		if (Cyclical.is(result)) {
			throw new Error(`TODO: figure out cyclical types`);
		}
		return result;
	}

	toSimpleType(type: SimpleType | ts.Type): SimpleType {
		return toSimpleType(type, this.checker, this.toSimpleTypeOptions);
	}

	getUniqueName(type: SimpleType): string {
		const name = type.name || "Anonymous";
		if (!this.names.has(name)) {
			this.names.set(name, 0);
			return name;
		}

		const count = this.names.get(name)! + 1;
		this.names.set(name, count);
		return `${name}${count}`;
	}

	newNode(type: SimpleType, path: SimpleTypePath, chunks: Chunks): SimpleTypeCompilerNode {
		const location = this.locate(type);
		const node = new SimpleTypeCompilerNode(location.line, location.column, location.source, chunks);
		node.type = type;
		node.path = path;
		node.step = SimpleTypePath.last(path);
		return node;
	}

	nodeBuilder(type: SimpleType, path: SimpleTypePath) {
		return {
			node: (chunks: Chunks) => this.newNode(type, path, chunks)
		};
	}

	locate(type: SimpleType): { source: string | null; line: number | null; column: number | null } {
		// TODO: inspect symbols and such
		const ts = type.getTypescript?.();
		if (!ts) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const symbol = ts.symbol || ts.type.aliasSymbol || ts.type.getSymbol();
		if (!symbol) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const decl = symbol.getDeclarations();
		if (!decl || decl.length === 0) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const node = decl[0];
		const sourceFile = node.getSourceFile();
		const ts2 = getTypescriptModule();
		const loc = ts2.getLineAndCharacterOfPosition(sourceFile, node.getStart());
		return {
			column: loc.character,
			line: loc.line,
			source: sourceFile.fileName
		};
	}
}

class SimpleTypeCompilerNode extends SourceNode {
	type!: SimpleType;
	path!: SimpleTypePath;
	step!: SimpleTypePathStep | undefined;
	cacheable = true;

	/**
	 * Mark this node as non-cacheable for a type.
	 * Use this method when you may compile a type two different ways depending on
	 * how it's referenced. Eg, for an enum member should be compiled one way
	 * inside its containing enum declaration, and another way when referenced by a
	 * member in another type.
	 */
	doNotCache(): this {
		this.cacheable = false;
		return this;
	}

	// Improve typing to `this` : https://github.com/mozilla/source-map/blob/58819f09018d56ef84dc41ba9c93f554e0645169/lib/source-node.js#L271
	/**
	 * Mutate this node by inserting `sep` between every child.
	 */
	join(sep: string): this {
		return super.join(sep) as this;
	}
}

class Indent {
	static fourSpaces() {
		return new this("    ", 0);
	}

	constructor(public tab: string, public level: number) {}

	get() {
		return this.tab.repeat(this.level);
	}

	withLevel<T>(level: number, fn: () => T) {
		const prevLevel = this.level;
		try {
			this.level = level;
			return fn();
		} finally {
			this.level = prevLevel;
		}
	}
}

test("Compiler example: compile to Python", ctx => {
	const { types, typeChecker } = getTestTypes(["Document"], EXAMPLE_TS);
	const compiler = new SimpleTypeCompiler(typeChecker);

	function mustBeDefined<T>(val: T | undefined): T {
		if (val === undefined) {
			throw new Error("Value must be defined");
		}
		return val;
	}

	/**
	 * TASK LIST FOR COMPILER:
	 *
	 * - Should unscrew the traversal types so that the object-like ones don't need gnarly casting.
	 * - ensure eg `from typings import TypedDoc` shows up at top of files
	 * - problem with "reference to class" : class should be declared in another file or at top level, and just use absolute name.
	 * - class & enum members: visit.with has bad type inference
	 *
	 */
	const indent = Indent.fourSpaces();
	compiler.compileType(types.Document, ({ type, path, visit }: VisitFnArgs<SimpleTypeCompilerNode>) => {
		const builder = compiler.nodeBuilder(type, path);
		const step = SimpleTypePath.last(path);

		if (isSimpleTypeLiteral(type)) {
			if (typeof type.value === "boolean") {
				return type.value ? builder.node("True") : builder.node("False");
			}
			return builder.node(`Literal[${type.value}]`);
		}

		if (type.error) {
			throw new Error(`SimpleType ${type.kind} has error: ${type.error}`);
		}

		switch (type.kind) {
			// Primitive-like
			case "BOOLEAN":
				return builder.node(`bool`);
			case "STRING":
				return builder.node("str");
			case "BIG_INT":
			case "NUMBER":
				return builder.node("float");
			case "NULL":
			case "UNDEFINED":
			case "VOID":
				return builder.node("None");
			case "DATE":
				return builder.node("DateTime");
			case "UNKNOWN":
				return builder.node("object"); // Top type https://github.com/python/mypy/issues/3712
			case "ANY":
				return builder.node("Any");
			case "NEVER":
				return builder.node("NoReturn");

			// Skip generic shenanigans.
			case "ALIAS":
				return mustBeDefined(Visitor.ALIAS.aliased({ path, type, visit })); // TODO: these don't need to be Optional
			case "GENERIC_ARGUMENTS":
				return mustBeDefined(Visitor.GENERIC_ARGUMENTS.aliased({ path, type, visit }));

			// Algebraic types
			case "UNION":
				return builder.node([`Union[`, builder.node(Visitor.UNION.mapVariants({ path, type, visit }) ?? []).join(", "), `]`]);
			case "INTERSECTION":
				return builder.node([`Intersection[`, builder.node(Visitor.INTERSECTION.mapVariants({ path, type, visit })).join(", "), `]`]);

			// List types
			case "ARRAY":
				return builder.node([`list[`, Visitor.ARRAY.numberIndex({ path, type, visit }) ?? "", "]"]);
			case "TUPLE":
				return builder.node([`Tuple[`, builder.node(Visitor.TUPLE.mapIndexedMembers({ path, type, visit })).join(", "), `]`]);

			// Object
			case "INTERFACE":
			case "CLASS":
			case "OBJECT": {
				const name = compiler.getUniqueName(type);
				// TODO: ugly hack
				const type2 = type as SimpleTypeInterface;
				/// blarg...
				const members = indent.withLevel(indent.level + 1, () => Visitor[type2.kind].mapNamedMembers({ path, type: type2, visit }));
				return builder.node([`@dataclass\nclass ${name}:\n`, members.join("\n") ?? "pass"]);
			}

			case "ENUM": {
				const name = compiler.getUniqueName(type);
				const members = indent.withLevel(indent.level + 1, () => Visitor.ENUM.mapVariants({ path, type, visit }));
				return builder.node([`class ${name}(Enum):\n`, builder.node(members).join("\n") ?? "pass"]);
			}

			case "ENUM_MEMBER": {
				const isInsideOwnEnum = step?.step === "VARIANT" && step.from.kind === "ENUM" && step.from.types.includes(type);
				if (!isInsideOwnEnum) {
					throw new Error(`TODO: enum references!`);
				}

				if (!isSimpleTypeLiteral(type.type)) {
					throw new Error(`Non-literal enum member type: ${simpleTypeToString(type.type)}`);
				}

				const enumValue = type.type.value;
				return builder.node([`${indent.get()}${type.name} = `, compiler.newNode(type.type, path, JSON.stringify(enumValue))]).doNotCache();
			}

			case "METHOD":
			case "FUNCTION": {
				const type2 = type as SimpleTypeFunction;
				return builder.node([
					`Callable[[`,
					builder.node(Visitor[type2.kind].mapParameters({ path, type: type2, visit })).join(", "),
					`]`,
					Visitor.FUNCTION.return({ path, type: type2, visit }) ?? "Any",
					`]`
				]);
			}

			case "GENERIC_PARAMETER":
			case "ES_SYMBOL":
			case "NON_PRIMITIVE":
			case "PROMISE":
				throw new Error(`Unsupported type`);

			default:
				unreachable(type);
		}
	});
});

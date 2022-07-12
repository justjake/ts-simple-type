import test from "ava";
import {
	isSimpleTypeLiteral,
	SimpleTypeEnumMember,
	SimpleTypeFunction,
	SimpleTypeInterface,
	SimpleTypeKind,
	SimpleTypePath,
	SimpleTypePathStepNamedMember,
	unreachable,
	VisitFnArgs,
	Visitor
} from "../src";
import { SimpleTypeCompiler, SimpleTypeCompilerNode } from "../src/transform/compile-simple-type";
import { toNullableSimpleType } from "../src/transform/inspect-simple-type";
import { simpleTypeToString } from "../src/transform/simple-type-to-string";
import { getTestTypes } from "./helpers/get-test-types";

const EXAMPLE_TS = `
type DBTable = 
	| 'block'
	| 'collection'
	| 'space'

type RecordPointer<T extends DBTable = DBTable> = T extends 'space' ?
	{ table: T; id: string } :
	{ table: T; id: string; spaceId: string }

enum AnnotationType {
	Bold,
	Italic,
	Underline,
	Strike,
	Code
}

export interface Table {
  header: string[]
  rows: string[][]
	parent: RecordPointer<'block'>
	rect?: Rect
}

export interface Text {
  plain: string
  annotations: Annotation[]
	rect?: Rect
	toString(): string
}

export interface Annotation {
  type: AnnotationType
  start: number
  end: number
  data: unknown
}

type Position = {
	x: number,
	y: number
	move(dx: number, dy: number): void
}

type Dimension = {
	width: number,
	height: number
	resize(width: number, height: number): void
}

type Rect = Position & Dimension

export interface Document {
	parent: RecordPointer
  title: string
  author: string
  body: Array<Text | Table>
}

`;

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
	const declarations: SimpleTypeCompilerNode[] = [];
	const compileToPython: Visitor<SimpleTypeCompilerNode> = ({ type, path, visit }: VisitFnArgs<SimpleTypeCompilerNode>) => {
		const builder = compiler.nodeBuilder(type, path);

		if (type.error) {
			throw new Error(`SimpleType ${type.kind} has error: ${type.error}`);
		}

		if (isSimpleTypeLiteral(type)) {
			if (typeof type.value === "boolean") {
				return type.value ? builder.node("True") : builder.node("False");
			}
			return builder.node(`Literal[${JSON.stringify(type.value)}]`);
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
			case "UNION": {
				const nullable = toNullableSimpleType(type);
				if (nullable.kind === "NULLABLE" && nullable.type.kind !== "NEVER") {
					return builder.node(["Optional[", visit(undefined, nullable.type), "]"]);
				} else {
					return builder.node([`Union[`, builder.node(Visitor.UNION.mapVariants({ path, type, visit })).join(", "), `]`]);
				}
			}
			case "INTERSECTION":
				if (!type.intersected) {
					throw new Error(`Cannot convert to Python because python has no intersection concept`);
				}
				return visit(undefined, type.intersected);

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
				// TODO: remove need for ugly hack by normalizing Visitor interface.
				const type2 = type as SimpleTypeInterface;

				const members = Visitor[type2.kind].mapNamedMembers({
					path,
					type: type2,
					visit: visit.with(({ type, path }) => {
						const builder = compiler.nodeBuilder(type, path);
						const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember;
						const member = step.member;
						return builder.node([`    ${member.name}: `, compiler.compileType(type, compileToPython, path)]);
					})
				});
				const declaration = builder.node([`@dataclass\nclass ${name}:\n`, members.join("\n") ?? "pass"]);
				declarations.push(declaration);
				return builder.node(name);
			}

			case "ENUM": {
				const name = compiler.getUniqueName(type);
				if (name !== type.name) {
					// eslint-disable-next-line no-console
					console.warn(`Warning: Enum name ${type.name} does not match class name ${name}; enum type will be incorrect.`);
				}
				const members = Visitor.ENUM.mapVariants<SimpleTypeCompilerNode>({
					path,
					type,
					visit: visit.with(({ type, path }) => {
						if (type.kind !== "ENUM_MEMBER") {
							throw new Error(`Non ENUM_MEMBER in ENUM`);
						}
						if (!isSimpleTypeLiteral(type.type)) {
							throw new Error(`Non-literal ENUM_MEMBER type: ${simpleTypeToString(type.type)}`);
						}

						const builder = compiler.nodeBuilder(type, path);
						return builder.node([`    ${type.name} = `, JSON.stringify(type.type.value)]);
					})
				});
				const declaration = builder.node([`class ${name}(Enum):\n`, builder.node(members).join("\n")]);
				declarations.push(declaration);
				return builder.node(name);
			}

			case "ENUM_MEMBER": {
				// TODO: ensure this `fullName` matches the actual name of the Enum class declaration, which could be
				//       renamed by `uniqueName`.
				return builder.node(type.fullName);
			}

			case "METHOD":
			case "FUNCTION": {
				const type2 = type as SimpleTypeFunction;
				return builder.node([
					`Callable[[`,
					builder.node(Visitor[type2.kind].mapParameters({ path, type: type2, visit })).join(", "),
					`], `,
					Visitor.FUNCTION.return({ path, type: type2, visit }) ?? "None",
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
	};
	const compiledType = compiler.compileType(types.Document, compileToPython);
	const program = compiler.newNode(compiler.toSimpleType(types.Document), [], [...declarations, compiledType]).join("\n\n");
	const withSourceMap = program.toStringWithSourceMap();
	compiler.setSourceContent(withSourceMap.map);
	ctx.snapshot(program.toString() + "\n#" + withSourceMap.map.toString());
});

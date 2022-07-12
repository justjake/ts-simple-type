import test from "ava";
import { isSimpleTypeLiteral, SimpleTypeFunction, SimpleTypeInterface, SimpleTypePath, SimpleTypePathStepNamedMember, unreachable, VisitFnArgs, Visitor } from "../src";
import { SimpleTypeCompiler, SimpleTypeCompilerNode } from "../src/transform/compile-simple-type";
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
}

export interface Text {
  plain: string
  annotations: Annotation[]
}

export interface Annotation {
  type: AnnotationType
  start: number
  end: number
  data: unknown
}

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
		const step = SimpleTypePath.last(path);

		if (isSimpleTypeLiteral(type)) {
			if (typeof type.value === "boolean") {
				return type.value ? builder.node("True") : builder.node("False");
			}
			return builder.node(`Literal[${JSON.stringify(type.value)}]`);
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
				// TODO: python doesn't have intersection types
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

				const members = Visitor[type2.kind].mapNamedMembers({
					path,
					type: type2,
					visit: visit.with(({ type, path }) => {
						const builder = compiler.nodeBuilder(type, path);
						const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember;
						const member = step.member;
						return builder.node([`    ${member.name}: `, compiler.compileType(type, compileToPython, path)]).doNotCache();
					})
				});
				const declaration = builder.node([`@dataclass\nclass ${name}:\n`, members.join("\n") ?? "pass"]);
				declarations.push(declaration);
				return builder.node(name);
			}

			case "ENUM": {
				const name = compiler.getUniqueName(type);
				const members = Visitor.ENUM.mapVariants<SimpleTypeCompilerNode>({
					path,
					type,
					visit: visit.with(({ type, path }) => {
						const builder = compiler.nodeBuilder(type, path);
						return builder.node(["    ", compiler.compileType(type, compileToPython, path)]).doNotCache();
					})
				});
				const declaration = builder.node([`class ${name}(Enum):\n`, builder.node(members).join("\n")]);
				declarations.push(declaration);
				return builder.node(name);
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
				return builder.node([`    ${type.name} = `, compiler.newNode(type.type, path, JSON.stringify(enumValue))]).doNotCache();
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
	};
	const compiledType = compiler.compileType(types.Document, compileToPython);
	const program = compiler.newNode(compiler.toSimpleType(types.Document), [], [...declarations, compiledType]).join("\n\n");
	const withSourceMap = program.toStringWithSourceMap();
	compiler.setSourceContent(withSourceMap.map);
	ctx.snapshot(program.toString() + "\n#" + withSourceMap.map.toString());
});

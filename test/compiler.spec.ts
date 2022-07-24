import test from "ava";
import { isSimpleTypeLiteral, SimpleTypePath, SimpleTypePathStepNamedMember, unreachable, Visitor } from "../src";
import { SimpleTypeCompiler, SimpleTypeCompilerLocation, SimpleTypeCompilerNode } from "../src/transform/compile-simple-type";
import { toNullableSimpleType } from "../src/transform/inspect-simple-type";
import { simpleTypeToString } from "../src/transform/simple-type-to-string";
import { getTestTypes } from "./helpers/get-test-types";
import * as path from "path";
import { RawSourceMap } from "source-map";

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

type AliasedType = Text | Table

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
  unknownData: unknown
  anyData: any
}

type Position = {
	x: number,
	y: number
	move(dx: number, dy: number): Position
}

type Dimension = {
	width: number,
	height: number
	resize(width: number, height: number): Dimension
}

type Rect = Position & Dimension

export interface Document {
	parent: RecordPointer
  title: string
  author: string
  body: Array<AliasedType>
}
`;

test("Compiler example: compile to Python", ctx => {
	const { types, typeChecker } = getTestTypes(["Document"], EXAMPLE_TS);

	const getPythonImportPath = (outputFileName: string) => {
		const parsed = path.parse(outputFileName);
		const dir = parsed.dir === "" ? [] : parsed.dir.split(path.sep);
		return [...dir, parsed.name].join(".");
	};

	function mustBeDefined<T>(val: T | undefined): T {
		if (val === undefined) {
			throw new Error("Value must be defined");
		}
		return val;
	}

	const compiler = new SimpleTypeCompiler(typeChecker, compiler => ({
		compileFile(file) {
			const importFiles = new Set<string>();
			file.references.forEach(ref => {
				if (ref.fileName === file.fileName) {
					return;
				}
				importFiles.add(`import ${getPythonImportPath(ref.fileName)}`);
			});
			const builder = compiler.anonymousNodeBuilder();
			const finalNodeList = [...file.nodes];
			if (importFiles.size) {
				const refNode = builder.node(Array.from(importFiles)).join("\n");
				finalNodeList.unshift(refNode);
			}
			return builder.node(finalNodeList).join("\n\n");
		},
		compileReference(args) {
			const builder = compiler.anonymousNodeBuilder(args.from);
			if (SimpleTypeCompilerLocation.fileAndNamespaceEqual(args.from, args.to.location)) {
				return builder.reference(args.to, `${args.to.location.name}`);
			}

			const location = args.to.location;
			const absoluteName = [getPythonImportPath(location.fileName), ...(location.namespace || []), location.name].join(".");
			return builder.reference(args.to, absoluteName);
		},
		compileType: ({ type, path, visit }) => {
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

			const stdlib = (moduleName: string, name: string) => {
				return builder.reference({
					location: {
						fileName: moduleName,
						name
					}
				});
			};

			switch (type.kind) {
				// Primitive-like
				case "BOOLEAN":
					return builder.node`bool`;
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
					return stdlib("datetime", "datetime");
				case "UNKNOWN":
					return builder.node("object"); // Top type https://github.com/python/mypy/issues/3712
				case "ANY":
					return stdlib("typing", "Any");
				case "NEVER":
					return stdlib("typing", "NoReturn");

				// Skip generic shenanigans.
				case "ALIAS":
					return mustBeDefined(Visitor.ALIAS.aliased({ path, type, visit })); // TODO: these don't need to be Optional
				case "GENERIC_ARGUMENTS":
					return mustBeDefined(Visitor.GENERIC_ARGUMENTS.aliased({ path, type, visit }));

				// Algebraic types
				case "UNION": {
					const nullable = toNullableSimpleType(type);
					if (nullable.kind === "NULLABLE" && nullable.type.kind !== "NEVER") {
						const Optional = stdlib("typing", "Optional");
						return builder.node`${Optional}[${builder.reference(visit(undefined, nullable.type))}]`;
					} else {
						const Union = stdlib("typing", "Union");
						return builder.node([Union, `[`, builder.references(Visitor.UNION.mapVariants({ path, type, visit })).join(", "), `]`]);
					}
				}
				case "INTERSECTION":
					if (!type.intersected) {
						throw new Error(`Cannot convert to Python because python has no intersection concept`);
					}
					return visit(undefined, type.intersected);

				// List types
				case "ARRAY":
					return builder.node`list[${builder.reference(Visitor.ARRAY.numberIndex({ path, type, visit })) ?? "object"}]`;
				case "TUPLE":
					return builder.node`${stdlib("typing", "Tuple")}[${builder.references(Visitor.TUPLE.mapIndexedMembers({ path, type, visit })).join(", ")}]`;

				// Object
				case "INTERFACE":
				case "CLASS":
				case "OBJECT": {
					const name = compiler.assignDeclarationLocation(
						type,
						type.name
							? undefined
							: {
									fileName: "editor/generated.py"
							  }
					);
					const members = Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
						path,
						type,
						visit: visit.with(({ type, path }) => {
							const builder = compiler.nodeBuilder(type, path);
							const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember;
							const member = step.member;
							return builder.node`    ${member.name}: ${builder.reference(compiler.compileType(type, path, name))}`;
						})
					});

					return builder.declaration(name, ["@", stdlib("dataclasses", "dataclass"), `\nclass ${name.name}:\n`, builder.node(members).join("\n") ?? "pass"]);
				}

				case "ENUM": {
					const name = compiler.assignDeclarationLocation(type);
					if (name.name !== type.name) {
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
					const enumReference = stdlib("enum", "Enum");
					return builder.declaration(name, [`class ${name.name}(`, enumReference, `):\n`, builder.node(members).join("\n")]);
				}

				case "ENUM_MEMBER": {
					// TODO: ensure this `fullName` matches the actual name of the Enum class declaration, which could be
					//       renamed by `uniqueName`.
					return builder.node(type.fullName);
				}

				case "METHOD":
				case "FUNCTION": {
					return builder.node([
						`Callable[[`,
						builder.references(Visitor[type.kind].mapParameters({ path, type, visit })).join(", "),
						`], `,
						builder.reference(Visitor.FUNCTION.return({ path, type, visit })) ?? "None",
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
		}
	}));

	const outputs = compiler.compileProgram([
		{
			inputType: types.Document,
			outputLocation: {
				fileName: "editor/document.py"
			}
		}
	]);

	for (const [fileName, output] of outputs.files) {
		ctx.snapshot(output.text, fileName);
		const map = output.sourceMap.toJSON();
		const snapshotSourceMap: RawSourceMap = {
			...map,
			sources: map.sources.map((s, i) => `source ${i}`),
			sourcesContent: map.sourcesContent?.map((s, i) => `source ${i}: length ${s?.length}`)
		};
		ctx.snapshot(snapshotSourceMap, `${fileName}.map`);
	}

	ctx.snapshot(outputs.files.size, "output count");
});

test("assignDeclarationLocation: same location = same name", ctx => {
	const { types, typeChecker } = getTestTypes(["Document"], EXAMPLE_TS);
	const compiler = new SimpleTypeCompiler(typeChecker, () => {
		return {} as any;
	});

	const DocumentType = compiler.toSimpleType(types.Document);
	const name = compiler.assignDeclarationLocation(DocumentType);
	const name2 = compiler.assignDeclarationLocation(DocumentType);
	ctx.is(name, name2);

	const name3 = compiler.assignDeclarationLocation(DocumentType, {
		fileName: "random/output.py"
	});
	ctx.is(name, name3);
});

test("assignDeclarationLocation: same location with different type gives unique names", ctx => {
	const one = getTestTypes(["Document"], EXAMPLE_TS);
	const two = getTestTypes(["Document"], EXAMPLE_TS);
	const compiler1 = new SimpleTypeCompiler(one.typeChecker, () => {
		return {} as any;
	});
	const compiler2 = new SimpleTypeCompiler(two.typeChecker, () => {
		return {} as any;
	});

	const doc1 = compiler1.toSimpleType(one.types.Document);
	const doc2 = compiler2.toSimpleType(two.types.Document);
	const name1 = compiler1.assignDeclarationLocation(doc1);
	const name2 = compiler1.assignDeclarationLocation(doc2);

	ctx.not(name1.name, name2.name);
	ctx.true(SimpleTypeCompilerLocation.fileAndNamespaceEqual(name1, name2));
});

test("README example: Typescript to C", ctx => {
	const { types, typeChecker } = getTestTypes(
		["TypeA"],
		`
export interface TypeA {
	name: string;
	workplace: Location;
}

interface Location {
	id: bigint;
	title: string;
	description: string;
	lat: number;
	lng: number;
}
	`
	);
	const typeA = types.TypeA;

	const typescriptToC = new SimpleTypeCompiler(typeChecker, compiler => ({
		// Called by the compiler to compile a SimpleType (`type`) to an AST node.
		compileType({ type, path, visit }) {
			const builder = compiler.nodeBuilder(type, path);
			switch (type.kind) {
				// Usually types translate directly to the target language,
				// so your compileType function can return a normal AST node.
				case "BOOLEAN":
					return builder.node`bool_t`;
				case "STRING":
					return builder.node`char*`;
				case "BIG_INT":
					return builder.node`int64_t`;
				case "NUMBER":
					return builder.node`double`;
				// In some cases, we need to map a type to a declaration in the target language.
				// For this example, we'll map all object-like types to a `typedef struct {}` declaration.
				case "INTERFACE":
				case "CLASS":
				case "OBJECT": {
					// Declarations are assigned locations in a compiler output file.
					const declarationLocation = compiler.assignDeclarationLocation(type);
					const fields = Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
						path,
						type,
						visit: visit.with(({ type, path }) => {
							const builder = compiler.nodeBuilder(type, path);
							// `path` is a list of steps from a root type to the current type.
							// In this example, we're mapping over the member types in a object-like Typescript type.
							const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember;
							const member = step.member;
							// Often, declarations aren't syntactically valid in arbitrary locations.
							// Instead we refer to declarations by name, and sometimes need an import.
							// The `builder.reference` function will compiler a *reference* to the target declaration
							// using your `compileReference` callback.
							// If the target is not a declaration, it's returned as-is.
							const memberType = builder.reference(compiler.compileType(type, path));
							return builder.node`  ${memberType} ${member.name};`;
						})
					});
					const newlineSeparatedFields = builder.node(fields).join("\n");
					return builder.declaration(declarationLocation, builder.node`typedef struct {\n${newlineSeparatedFields}\n} ${declarationLocation.name};`);
				}
				default:
					throw new Error(`Unsupported type: ${type.kind}`);
			}
		},
		// Called by the compiler to compile a reference to a declaration.
		// Declaration locations can have a fileName, namespace, and name,
		// although not all languages need to use these.
		compileReference({ to }) {
			const builder = compiler.anonymousNodeBuilder();
			const isPointerType = builder.isDeclaration(to) && to.type?.kind === "INTERFACE";
			return builder.node`${to.location.name}${isPointerType ? "*" : ""}`;
		},
		// Called by the compiler after compiling all types to AST nodes.
		// This function is called once per output file to compile any references
		// that file has to other files, and combine together the declarations in the file.
		compileFile(file) {
			const builder = compiler.anonymousNodeBuilder();
			const includes = Array.from(new Set(file.references.map(ref => ref.fileName))).filter(fileName => fileName !== file.fileName);
			return builder.node([...includes.map(include => builder.node`#include "${include}"`), ...file.nodes]).join("\n\n");
		}
	}));

	// Run the compiler to produce outputs files.
	// It's up to you to write these to disk, post-process them, etc.
	const { files } = typescriptToC.compileProgram([
		{
			inputType: typeA,
			outputLocation: {
				fileName: "c/types.h"
			}
		}
	]);

	for (const [fileName, outputFile] of files) {
		ctx.snapshot(outputFile.text, fileName);
	}
});

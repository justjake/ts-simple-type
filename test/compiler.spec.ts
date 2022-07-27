import test from "ava";
import { RawSourceMap } from "source-map";
import { SimpleType, SimpleTypePath, SimpleTypePathStepNamedMember, Visitor } from "../src";
import { PythonCompilerTarget } from "../src/compile-to/python3";
import { ThriftCompilerTarget } from "../src/compile-to/thrift";
import { SimpleTypeCompiler, SimpleTypeCompilerDeclarationLocation, SimpleTypeCompilerLocation, SimpleTypeCompilerNode, SimpleTypeCompilerTarget } from "../src/transform/compiler";
import { getTestTypes } from "./helpers/get-test-types";

const EXAMPLE_TS = `
type DBTable = 
	| 'block'
	| 'collection'
	| 'space'

type RecordPointer<T extends DBTable = DBTable> = T extends 'space' ?
	{ table: T; id: string } :
	{ table: T; id: string; spaceId: string }

type TableModal<T extends DBTable = DBTable> = T extends 'space'
	? { open: false }
	: ({ open: true, view: string } | { open: false })

enum AnnotationType {
	Bold,
	Italic,
	Underline,
	Strike,
	Code
}

export type DocumentBlock = Text | Table

export interface Table {
  header: string[]
  rows: string[][]
	parent: RecordPointer<'block'>
	modal: TableModal<'block'>
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
  body: Array<DocumentBlock>
}
`;

test("Compiler example: compile to Python", ctx => {
	const { types, typeChecker } = getTestTypes(["Document"], EXAMPLE_TS);

	class TestPythonTarget extends PythonCompilerTarget implements SimpleTypeCompilerTarget {
		suggestDeclarationLocation(type: SimpleType, from: SimpleTypeCompilerLocation): SimpleTypeCompilerLocation | SimpleTypeCompilerDeclarationLocation {
			if (!type.name) {
				return {
					fileName: "editor/generated.py"
				};
			}
			return from;
		}
	}

	const compiler = TestPythonTarget.createCompiler(typeChecker);

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
							const memberType = builder.reference(compiler.compileType(type, path, declarationLocation));
							return builder.node`  ${memberType} ${member.name};`;
						})
					});
					const newlineSeparatedFields = builder.node(fields).joinNodes("\n");
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
			return builder.node([...includes.map(include => builder.node`#include "${include}"`), ...file.nodes]).joinNodes("\n\n");
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

test("Compiler example: compile to Thrift", ctx => {
	const { types, typeChecker } = getTestTypes(["Document"], EXAMPLE_TS);

	const compiler = ThriftCompilerTarget.createCompiler(typeChecker);

	const outputs = compiler.compileProgram([
		{
			inputType: types.Document,
			outputLocation: {
				fileName: "thrift/schema.thrift"
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

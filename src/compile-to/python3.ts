import * as path from "path"

import type * as ts from "typescript"

import { isSimpleTypeLiteral, SimpleType, SimpleTypeClass, SimpleTypeFunction, SimpleTypeInterface, SimpleTypeLiteral, SimpleTypeMethod, SimpleTypeObject } from "../simple-type"
import { SimpleTypePath, SimpleTypePathStepNamedMember } from "../simple-type-path"
import {
	SimpleTypeCompiler,
	SimpleTypeCompilerDeclarationNode,
	SimpleTypeCompilerLocation,
	SimpleTypeCompilerNode,
	SimpleTypeCompilerNodeBuilder,
	SimpleTypeCompilerReferenceArgs,
	SimpleTypeCompilerReferenceNode,
	SimpleTypeCompilerTarget,
	SimpleTypeCompilerTargetFile,
} from "../transform/compiler"
import { toNullableSimpleType } from "../transform/inspect-simple-type"
import { simpleTypeToString } from "../transform/simple-type-to-string"
import { SimpleTypeKindVisitors, VisitorArgs, Visitor } from "../visitor"

/**
 * Compiles types to Python3.
 * To customize the compilation, make a subclass.
 */
export class PythonCompilerTarget implements SimpleTypeCompilerTarget {
	static createCompiler<T extends PythonCompilerTarget>(this: { new (compiler: SimpleTypeCompiler): T }, typeChecker: ts.TypeChecker): SimpleTypeCompiler {
		return new SimpleTypeCompiler(typeChecker, compiler => new this(compiler))
	}

	constructor(public compiler: SimpleTypeCompiler) {}

	compileType: Visitor<SimpleTypeCompilerNode, SimpleType> = args => {
		const { type, path, visit } = args
		if (type.error) {
			throw new Error(`SimpleType kind ${type.kind} has error: ${type.error}`)
		}
		const compileTypeKind = this.compileKind[type.kind]
		if (!compileTypeKind) {
			throw new ReferenceError(`SimpleType kind ${type.kind} has no compiler defined`)
		}

		const typeExpression = compileTypeKind({ type: type as never, path, visit })
		if (this.compiler.isExportedFromSourceLocation(args.type)) {
			return this.toTypeAliasDeclaration(args, typeExpression)
		} else {
			return typeExpression
		}
	}

	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder(args.from)
		if (SimpleTypeCompilerLocation.fileAndNamespaceEqual(args.from, args.to.location)) {
			return builder.reference(args.to, `${args.to.location.name}`)
		}

		const location = args.to.location
		const absoluteName = [this.getPythonImportPath(location.fileName), ...(location.namespace || []), location.name].join(".")
		return builder.reference(args.to, absoluteName)
	}

	compileFile(file: SimpleTypeCompilerTargetFile): SimpleTypeCompilerNode {
		const importFiles = new Set<string>()
		file.references.forEach(ref => {
			if (ref.fileName === file.fileName) {
				return
			}
			importFiles.add(`import ${this.getPythonImportPath(ref.fileName)}`)
		})
		const builder = this.compiler.anonymousNodeBuilder()
		const finalNodeList = [...file.nodes]
		if (importFiles.size) {
			const refNode = builder.node(Array.from(importFiles)).joinNodes("\n")
			finalNodeList.unshift(refNode)
		}
		return builder.node(finalNodeList).joinNodes("\n\n")
	}

	getPythonImportPath(outputFileName: string): string {
		const parsed = path.parse(outputFileName)
		const dir = parsed.dir === "" ? [] : parsed.dir.split(path.sep)
		return [...dir, parsed.name].join(".")
	}

	withBuilder = <ST extends SimpleType>(
		visitor: (args: VisitorArgs<SimpleTypeCompilerNode, ST> & { builder: SimpleTypeCompilerNodeBuilder }) => SimpleTypeCompilerNode
	): Visitor<SimpleTypeCompilerNode, ST> => {
		return args => {
			const builder = this.compiler.nodeBuilder(args.type, args.path)
			return visitor({ ...args, builder })
		}
	}

	compileLiteral = this.withBuilder<SimpleTypeLiteral>(({ builder, type }) => {
		if (typeof type.value === "boolean") {
			return type.value ? builder.node("True") : builder.node("False")
		}

		return builder.node(`Literal[${JSON.stringify(type.value)}]`)
	})

	compileNone = this.withBuilder(({ builder }) => builder.node`None`)

	compileObjectLike: Visitor<SimpleTypeCompilerNode, SimpleTypeObject | SimpleTypeClass | SimpleTypeInterface> = this.withBuilder(({ builder, type, path, visit }) => {
		const name = this.compiler.assignDeclarationLocation(type, path)
		const members = Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
			path,
			type,
			visit: visit.with(({ type, path }) => {
				const builder = this.compiler.nodeBuilder(type, path)
				const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember
				const member = step.member
				return builder.node`    ${member.name}: ${builder.reference(this.compiler.compileType(type, path, name))}`
			}),
		})

		const dataclass = this.stdlibReference(builder, "dataclasses", "dataclass")
		return builder.declaration(name, ["@", dataclass, `\nclass ${name.name}:\n`, builder.node(members).joinNodes("\n") ?? "pass"])
	})

	compileCallable: Visitor<SimpleTypeCompilerNode, SimpleTypeMethod | SimpleTypeFunction> = this.withBuilder(({ builder, type, path, visit }) => {
		return builder.node([
			`Callable[[`,
			builder.references(Visitor[type.kind].mapParameters({ path, type, visit })).joinNodes(", "),
			`], `,
			builder.reference(Visitor.FUNCTION.return({ path, type, visit })) ?? "None",
			`]`,
		])
	})

	toTypeAliasDeclaration(args: VisitorArgs<SimpleTypeCompilerNode>, inner: SimpleTypeCompilerNode): SimpleTypeCompilerNode {
		if (inner instanceof SimpleTypeCompilerReferenceNode || inner instanceof SimpleTypeCompilerDeclarationNode) {
			return inner
		}

		const builder = this.compiler.nodeBuilder(args.type, args.path)
		const declarationLocation = this.compiler.assignDeclarationLocation(args.type, args.path)
		return builder.declaration(declarationLocation, builder.node`${declarationLocation.name} = ${inner}`)
	}

	throwUnsupported: Visitor<SimpleTypeCompilerNode> = ({ type }) => {
		throw new Error(`Unsupported SimpleType kind: ${type.kind}`)
	}

	stdlibReference(builder: SimpleTypeCompilerNodeBuilder, moduleName: string, exportName: string): SimpleTypeCompilerReferenceNode {
		return builder.reference({
			location: {
				fileName: moduleName,
				name: exportName,
			},
		})
	}

	compileKind: SimpleTypeKindVisitors<SimpleTypeCompilerNode> = {
		// Literals
		STRING_LITERAL: this.compileLiteral,
		NUMBER_LITERAL: this.compileLiteral,
		BOOLEAN_LITERAL: this.compileLiteral,
		BIG_INT_LITERAL: this.compileLiteral,
		ES_SYMBOL_UNIQUE: this.compileLiteral,

		// Primitives
		BOOLEAN: this.withBuilder(({ builder }) => builder.node`bool`),
		STRING: this.withBuilder(({ builder }) => builder.node`str`),
		BIG_INT: this.withBuilder(({ builder }) => builder.node`int`),
		NUMBER: this.withBuilder(({ builder }) => builder.node`float`),

		// None-like
		NULL: this.compileNone,
		UNDEFINED: this.compileNone,
		VOID: this.compileNone,

		// Top & bottom
		// Top type https://github.com/python/mypy/issues/3712
		UNKNOWN: this.withBuilder(({ builder }) => builder.node`object`),
		ANY: this.withBuilder(({ builder }) => this.stdlibReference(builder, "typing", "Any")),
		NEVER: this.withBuilder(({ builder }) => this.stdlibReference(builder, "typing", "NoReturn")),

		// Well-known
		DATE: this.withBuilder(({ builder }) => this.stdlibReference(builder, "datetime", "date")),

		// Compile instantiated generics instead of copying the whole generic type
		ALIAS: Visitor.ALIAS.aliased,
		GENERIC_ARGUMENTS: Visitor.GENERIC_ARGUMENTS.aliased,

		// Algebraic types
		UNION: this.withBuilder(({ builder, type, path, visit }) => {
			const nullable = toNullableSimpleType(type)
			if (nullable.kind === "NULLABLE" && nullable.type.kind !== "NEVER") {
				const Optional = this.stdlibReference(builder, "typing", "Optional")
				return builder.node`${Optional}[${builder.reference(visit(undefined, nullable.type))}]`
			} else {
				const Union = this.stdlibReference(builder, "typing", "Union")
				return builder.node`${Union}[${builder.references(Visitor.UNION.mapVariants({ path, type, visit })).joinNodes(", ")}]`
			}
		}),
		INTERSECTION: ({ type, visit }) => {
			if (!type.intersected) {
				throw new Error(`Cannot convert to Python because python has no intersection concept`)
			}
			return visit(undefined, type.intersected)
		},

		// List types
		ARRAY: this.withBuilder(({ builder, type, path, visit }) => builder.node`list[${builder.reference(Visitor.ARRAY.numberIndex({ path, type, visit })) ?? "object"}]`),
		TUPLE: this.withBuilder(({ builder, path, type, visit }) => {
			const Tuple = this.stdlibReference(builder, "typing", "Tuple")
			return builder.node`${Tuple}[${builder.references(Visitor.TUPLE.mapIndexedMembers({ path, type, visit })).joinNodes(", ")}]`
		}),

		// Object
		INTERFACE: this.compileObjectLike,
		CLASS: this.compileObjectLike,
		OBJECT: this.compileObjectLike,

		// Enum
		ENUM: this.withBuilder(({ builder, type, path, visit }) => {
			const name = this.compiler.assignDeclarationLocation(type, path)
			if (name.name !== type.name) {
				// eslint-disable-next-line no-console
				console.warn(`Warning: Enum name ${type.name} does not match class name ${name}; ENUM_MEMBER references will be incorrect.`)
			}
			const members = Visitor.ENUM.mapVariants<SimpleTypeCompilerNode>({
				path,
				type,
				visit: visit.with(({ type, path }) => {
					if (type.kind !== "ENUM_MEMBER") {
						throw new Error(`Non ENUM_MEMBER in ENUM`)
					}
					if (!isSimpleTypeLiteral(type.type)) {
						throw new Error(`Non-literal ENUM_MEMBER type: ${simpleTypeToString(type.type)}`)
					}

					const builder = this.compiler.nodeBuilder(type, path)
					return builder.node([`    ${type.name} = `, JSON.stringify(type.type.value)])
				}),
			})
			const Enum = this.stdlibReference(builder, "enum", "Enum")
			return builder.declaration(name, [`class ${name.name}(`, Enum, `):\n`, builder.node(members).joinNodes("\n")])
		}),
		ENUM_MEMBER: this.withBuilder(({ builder, type }) => {
			// TODO: ensure this `fullName` matches the actual name of the Enum class declaration, which could be
			//       renamed by `uniqueName`.
			// We may need to add ENUM_MEMBER -> ENUM to support this, but maybe not.
			return builder.node(type.fullName)
		}),

		// Callable
		FUNCTION: this.compileCallable,
		METHOD: this.compileCallable,

		// Unsupported
		GENERIC_PARAMETER: this.throwUnsupported,
		ES_SYMBOL: this.throwUnsupported,
		NON_PRIMITIVE: this.throwUnsupported,
		PROMISE: this.throwUnsupported,
	}
}

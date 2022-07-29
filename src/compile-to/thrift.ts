import * as path from "path";
import type * as ts from "typescript";
import { isSimpleTypeLiteral, SimpleType, SimpleTypeClass, SimpleTypeInterface, SimpleTypeKind, SimpleTypeLiteral, SimpleTypeMember, SimpleTypeObject } from "../simple-type";
import { SimpleTypePath } from "../simple-type-path";
import {
	SimpleTypeCompiler,
	SimpleTypeCompilerDeclarationNode,
	SimpleTypeCompilerLocation,
	SimpleTypeCompilerNode,
	SimpleTypeCompilerNodeBuilder,
	SimpleTypeCompilerReferenceArgs,
	SimpleTypeCompilerReferenceNode,
	SimpleTypeCompilerTarget,
	SimpleTypeCompilerTargetFile
} from "../transform/compiler";
import { toEnumTaggedUnion, toNullableSimpleType } from "../transform/inspect-simple-type";
import { simpleTypeToString } from "../transform/simple-type-to-string";
import { SimpleTypeKindVisitors, Visitor, VisitorArgs } from "../visitor";

/**
 * Compiles types to Thrift.
 * To customize the compilation, make a subclass.
 *
 * https://github.com/apache/thrift/blob/master/test/ThriftTest.thrift
 */
export class ThriftCompilerTarget implements SimpleTypeCompilerTarget {
	static createCompiler<T extends ThriftCompilerTarget>(this: { new (compiler: SimpleTypeCompiler): T }, typeChecker: ts.TypeChecker): SimpleTypeCompiler {
		return new SimpleTypeCompiler(typeChecker, compiler => new this(compiler));
	}

	constructor(public compiler: SimpleTypeCompiler) {}

	compileType: Visitor<SimpleTypeCompilerNode, SimpleType> = args => {
		const { type, path, visit } = args;
		if (type.error) {
			throw new Error(`SimpleType kind ${type.kind} has error: ${type.error}`);
		}
		const compileTypeKind = this.compileKind[type.kind];
		if (!compileTypeKind) {
			throw new ReferenceError(`SimpleType kind ${type.kind} has no compiler defined`);
		}

		const typeExpression = compileTypeKind({ type: type as never, path, visit });
		if (this.compiler.isExportedFromSourceLocation(args.type)) {
			return this.toTypeAliasDeclaration(args, typeExpression);
		} else {
			return typeExpression;
		}
	};

	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder(args.from);
		if (SimpleTypeCompilerLocation.fileAndNamespaceEqual(args.from, args.to.location)) {
			return builder.reference(args.to, `${args.to.location.name}`);
		}

		const location = args.to.location;
		const namespace = path.basename(location.fileName, ".thrift");
		return builder.reference(args.to, builder.node`${namespace}.${location.name}`);
	}

	compileFile(file: SimpleTypeCompilerTargetFile): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder();

		const includes = new Set<string>();
		file.references.forEach(ref => {
			if (ref.fileName === file.fileName) {
				return;
			}
			const relativePath = path.relative(file.fileName, ref.fileName);
			includes.add(`include ${JSON.stringify(relativePath)}`);
		});

		const includesNode = includes.size ? builder.node(Array.from(includes)).joinNodes("\n") : builder.node`# No includes`;
		const thriftNamespaceNode = builder.node`namespace * ${path.basename(file.fileName, ".thrift")}`;

		return builder.node([includesNode, thriftNamespaceNode, ...file.nodes, builder.node``]).joinNodes("\n\n");
	}

	withBuilder = <ST extends SimpleType>(
		visitor: (args: VisitorArgs<SimpleTypeCompilerNode, ST> & { builder: SimpleTypeCompilerNodeBuilder }) => SimpleTypeCompilerNode
	): Visitor<SimpleTypeCompilerNode, ST> => {
		return args => {
			const builder = this.compiler.nodeBuilder(args.type, args.path);
			return visitor({ ...args, builder });
		};
	};

	compileLiteralValue = this.withBuilder<SimpleTypeLiteral>(({ builder, type }) => {
		return builder.node(JSON.stringify(type.value));
	});

	compileVoid = this.withBuilder(({ builder }) => builder.node`void`);

	compileNotRepresentable = this.withBuilder(({ builder, type }) => builder.node`/** Typescript: ${simpleTypeToString(type)} */ void`);

	compileObjectLike: Visitor<SimpleTypeCompilerNode, SimpleTypeObject | SimpleTypeClass | SimpleTypeInterface> = ({ type, path, visit }) => {
		const loc = this.compiler.assignDeclarationLocation(type, path);
		return this.compiler.withLocation(loc, () => {
			const builder = this.compiler.nodeBuilder(type, path);
			const members = this.filterMembers(
				Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
					path,
					type,
					visit: visit.with(this.compileMember)
				})
			);

			return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`struct ${loc.name} {\n${builder.node(members).joinNodes(",\n")}\n}`));
		});
	};

	toTypeAliasDeclaration(args: VisitorArgs<SimpleTypeCompilerNode>, inner: SimpleTypeCompilerNode): SimpleTypeCompilerNode {
		if (inner instanceof SimpleTypeCompilerReferenceNode || inner instanceof SimpleTypeCompilerDeclarationNode) {
			return inner;
		}

		const builder = this.compiler.nodeBuilder(args.type, args.path);
		const declarationLocation = this.compiler.assignDeclarationLocation(args.type, args.path);
		return builder.declaration(declarationLocation, this.withDeclarationDocComment(args.type, args.path, builder.node`typedef ${inner} ${declarationLocation.name}`));
	}

	throwUnsupported: Visitor<SimpleTypeCompilerNode> = ({ type }) => {
		throw new Error(`Unsupported SimpleType kind: ${type.kind}`);
	};

	compilePrimitive = this.withBuilder(({ type, builder }) => {
		if (!(type.kind in this.primitiveKind)) {
			throw new Error(`Unsupported SimpleTypePrimitive kind: ${type.kind}`);
		}

		const typeNode = builder.node(this.primitiveKind[type.kind as keyof typeof this.primitiveKind]);
		const preCommentNode = isSimpleTypeLiteral(type) ? builder.node`/** always ${simpleTypeToString(type)} */ ` : undefined;
		return builder.node([preCommentNode, typeNode].filter(isDefined));
	});

	/**
	 * Compiles a member of a struct or union type.
	 */
	compileMember = this.withBuilder(({ type, path }) => {
		const step = SimpleTypePath.last(path);
		const builder = this.compiler.nodeBuilder(type, path);

		if (!step || !(step.step === "INDEXED_MEMBER" || step.step === "NAMED_MEMBER" || step.step === "VARIANT")) {
			throw new Error(`Type not in a INDEXED_MEMBER, NAMED_MEMBER, or VARIANT`);
		}

		const thriftType = builder.reference(this.compiler.compileType(type, path));

		const nullable = type.kind === "UNION" && toNullableSimpleType(type).kind === "NULLABLE";
		const optional = nullable || (step.step !== "VARIANT" && Boolean(step.member.optional));
		const defaultValue = isSimpleTypeLiteral(type) ? JSON.stringify(type.value) : undefined;

		const thriftTypeName = thriftType instanceof SimpleTypeCompilerReferenceNode ? thriftType.refersTo.name : undefined;
		const indexFieldName = `_${step.index}`;
		const memberName = step.step === "NAMED_MEMBER" ? step.member.name : step.step === "INDEXED_MEMBER" ? indexFieldName : thriftTypeName || this.compiler.inferTypeName(type, path);

		// Assign name among members.
		const parentLocation: SimpleTypeCompilerLocation = {
			...(this.compiler.getCurrentLocation() || { fileName: "<unknown file>", name: "UnknownType" })
		};
		const namespace: SimpleTypeCompilerLocation = {
			fileName: parentLocation.fileName,
			namespace: (parentLocation.namespace || []).concat(parentLocation.name || "unknown"),
			name: memberName
		};
		const location = this.compiler.createUniqueLocation(type, path, namespace);

		const docCommentNode = step.step !== "VARIANT" ? this.docCommentNode(builder, "  ", step.member) : undefined;
		const memberNode: SimpleTypeCompilerNode = builder.node`  ${String(step.index)}: ${optional ? "optional " : ""}${thriftType} ${location.name}${defaultValue ? " = " + defaultValue : ""}`;
		return builder.node([docCommentNode, memberNode].filter(isDefined)).joinNodes("\n");
	});

	docCommentNode(builder: SimpleTypeCompilerNodeBuilder, prefix: string, typeOrMember: SimpleType | SimpleTypeMember): SimpleTypeCompilerNode | undefined {
		const docCommentInfo = this.compiler.getDocumentationComment(typeOrMember);
		if (!docCommentInfo) {
			return;
		}

		const { docComment, jsDocTags } = docCommentInfo;
		const unIndentedParts: string[] = [];
		if (docComment) {
			unIndentedParts.push(docComment);
		}
		if (jsDocTags) {
			if (unIndentedParts.length) {
				unIndentedParts.push("");
			}

			for (const [tag, value] of jsDocTags) {
				unIndentedParts.push(`@${tag}${value ? " " + value : ""}`);
			}
		}

		const text = unIndentedParts.join("\n");
		if (text) {
			const body = text.split("\n").map(line => `${prefix} * ${line}`);
			return builder.node([`${prefix}/**`, ...body, `${prefix} */`]).joinNodes("\n");
		}
	}

	withDeclarationDocComment(type: SimpleType, path: SimpleTypePath, inner: SimpleTypeCompilerNode): SimpleTypeCompilerNode {
		const builder = this.compiler.nodeBuilder(type, path);
		const docCommentNode = this.docCommentNode(builder, "", type);
		return docCommentNode ? builder.node([docCommentNode, inner]).joinNodes("\n") : inner;
	}

	dropMemberKinds = new Set<SimpleTypeKind>(["FUNCTION", "METHOD"]);
	private filterMembers = (members: SimpleTypeCompilerNode[]) => members.filter(node => !(node.type?.kind && this.dropMemberKinds.has(node.type.kind)));

	private primitiveKind = {
		STRING_LITERAL: "string",
		NUMBER_LITERAL: "double",
		BOOLEAN_LITERAL: "bool",
		BIG_INT_LITERAL: "i64",
		BOOLEAN: "bool",
		STRING: "string",
		BIG_INT: "i64",
		NUMBER: "double"
	};

	compileKind: SimpleTypeKindVisitors<SimpleTypeCompilerNode> = {
		// Literals
		STRING_LITERAL: this.compilePrimitive,
		NUMBER_LITERAL: this.compilePrimitive,
		BOOLEAN_LITERAL: this.compilePrimitive,
		BIG_INT_LITERAL: this.compilePrimitive,
		ES_SYMBOL_UNIQUE: this.compilePrimitive,

		// Primitives
		BOOLEAN: this.compilePrimitive,
		STRING: this.compilePrimitive,
		BIG_INT: this.compilePrimitive,
		NUMBER: this.compilePrimitive,

		// None-like
		NULL: this.compileVoid,
		UNDEFINED: this.compileVoid,
		VOID: this.compileVoid,

		// Top & bottom
		// Top type https://github.com/python/mypy/issues/3712
		UNKNOWN: this.compileNotRepresentable,
		ANY: this.compileNotRepresentable,
		NEVER: this.compileNotRepresentable,

		// Well-known
		DATE: this.throwUnsupported,

		// Compile instantiated generics instead of copying the whole generic type
		ALIAS: Visitor.ALIAS.aliased,
		GENERIC_ARGUMENTS: Visitor.GENERIC_ARGUMENTS.aliased,

		/*
union SomeUnion {
  1: map<Numberz, UserId> map_thing,
  2: string string_thing,
  3: i32 i32_thing,
  4: Xtruct3 xtruct_thing,
  5: Insanity insanity_thing
}
*/

		// Algebraic types
		UNION: ({ type, path, visit }) => {
			// Eliminate null / undefined from union type
			const nullable = toNullableSimpleType(type);
			if (nullable.kind === "NULLABLE") {
				return visit(undefined, nullable.type);
			}

			// If this is discriminated union, convert the discriminant to an enum
			let unionType = type;
			const taggedEnumUnion = toEnumTaggedUnion(type);
			if (taggedEnumUnion) {
				unionType = taggedEnumUnion.union;
			}

			const loc = this.compiler.assignDeclarationLocation(unionType, path);

			return this.compiler.withLocation(loc, () => {
				const builder = this.compiler.nodeBuilder(unionType, path);
				const members = this.filterMembers(
					Visitor.UNION.mapVariants({
						path,
						type,
						visit: visit.with(this.compileMember)
					})
				);

				return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`union ${loc.name} {\n${builder.node(members).joinNodes(",\n")}\n}`));
			});
		},
		INTERSECTION: ({ type, visit }) => {
			if (!type.intersected) {
				throw new Error(`Target type system doesn't support intersection types`);
			}
			return visit(undefined, type.intersected);
		},

		// List types
		ARRAY: this.withBuilder(({ builder, type, path, visit }) => builder.node`list<${builder.reference(Visitor.ARRAY.numberIndex({ path, type, visit }))}>`),
		TUPLE: ({ path, type, visit }) => {
			// Compile tuple as a struct with indexed fields
			const loc = this.compiler.assignDeclarationLocation(type, path);
			return this.compiler.withLocation(loc, () => {
				const builder = this.compiler.nodeBuilder(type, path);
				const members = this.filterMembers(
					Visitor.TUPLE.mapIndexedMembers<SimpleTypeCompilerNode>({
						path,
						type,
						visit: visit.with(this.compileMember)
					})
				);
				return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`struct ${loc.name} {\n${builder.node(members).joinNodes(",\n")}\n}`));
			});
		},

		// Object
		INTERFACE: this.compileObjectLike,
		CLASS: this.compileObjectLike,
		OBJECT: this.compileObjectLike,

		// Enum
		ENUM: ({ type, path, visit }) => {
			const loc = this.compiler.assignDeclarationLocation(type, path);
			if (loc.name !== type.name) {
				// eslint-disable-next-line no-console
				console.warn(`Warning: Enum name ${type.name} does not match class name ${loc}; ENUM_MEMBER references will be incorrect.`);
			}
			return this.compiler.withLocation(loc, () => {
				const builder = this.compiler.nodeBuilder(type, path);
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

						const builder = this.compiler.nodeBuilder(type, path);
						return builder.node`  ${type.name} = ${JSON.stringify(type.type.value)}`;
					})
				});
				return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`enum ${loc.name} {\n${builder.node(members).joinNodes(",\n")}\n}`));
			});
		},
		ENUM_MEMBER: this.withBuilder(({ builder, type }) => {
			// TODO: ensure this `fullName` matches the actual name of the Enum class declaration, which could be
			//       renamed by `uniqueName`.
			// We may need to add ENUM_MEMBER -> ENUM to support this, but maybe not.
			return builder.node(type.fullName);
		}),

		// Callable
		FUNCTION: this.compileVoid,
		METHOD: this.compileVoid,

		// Unsupported
		GENERIC_PARAMETER: this.throwUnsupported,
		ES_SYMBOL: this.throwUnsupported,
		NON_PRIMITIVE: this.throwUnsupported,
		PROMISE: this.throwUnsupported
	};
}

export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

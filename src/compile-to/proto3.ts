import * as path from "path";
import type * as ts from "typescript";
import { isSimpleTypeLiteral, SimpleType, SimpleTypeClass, SimpleTypeInterface, SimpleTypeKind, SimpleTypeLiteral, SimpleTypeMember, SimpleTypeObject } from "../simple-type";
import { SimpleTypePath } from "../simple-type-path";
import {
	SimpleTypeCompiler,
	SimpleTypeCompilerLocation,
	SimpleTypeCompilerNode,
	SimpleTypeCompilerNodeBuilder,
	SimpleTypeCompilerReferenceArgs,
	SimpleTypeCompilerTarget,
	SimpleTypeCompilerTargetFile
} from "../transform/compiler";
import { toNullableSimpleType } from "../transform/inspect-simple-type";
import { simpleTypeToString } from "../transform/simple-type-to-string";
import { SimpleTypeKindVisitors, Visitor, VisitorArgs } from "../visitor";

/**
 * Compiles types to Proto3 (Protobuf).
 * To customize the compilation, make a subclass.
 *
 * https://github.com/apache/thrift/blob/master/test/ThriftTest.thrift
 */
export class Proto3CompilerTarget implements SimpleTypeCompilerTarget {
	static createCompiler<T extends Proto3CompilerTarget>(this: { new (compiler: SimpleTypeCompiler): T }, typeChecker: ts.TypeChecker): SimpleTypeCompiler {
		return new SimpleTypeCompiler(typeChecker, compiler => new this(compiler));
	}

	constructor(public compiler: SimpleTypeCompiler) {}

	private wrapperTypeMap = new WeakMap<SimpleType, SimpleTypeInterface>();

	compileType: Visitor<SimpleTypeCompilerNode, SimpleType> = args => {
		const { type, path, visit } = args;
		if (type.error) {
			throw new Error(`SimpleType kind ${type.kind} has error: ${type.error}`);
		}
		const compileTypeKind = this.compileKind[type.kind];
		if (!compileTypeKind) {
			throw new ReferenceError(`SimpleType kind ${type.kind} has no compiler defined`);
		}

		if (this.compiler.isExportedFromSourceLocation(type)) {
			const location = this.compiler.assignDeclarationLocation(type, path);
			return this.compiler.withLocation(location, () => {
				return compileTypeKind({ type: type as never, path, visit });
			});
		} else {
			return compileTypeKind({ type: type as never, path, visit });
		}
	};

	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder(args.from);
		if (SimpleTypeCompilerLocation.fileAndNamespaceEqual(args.from, args.to.location)) {
			return builder.reference(args.to, `${args.to.location.name}`);
		}

		if (args.to.location.fileName.startsWith("google/")) {
			const name = (args.to.location.namespace || []).concat(args.to.location.name).join(".");
			return builder.reference(args.to, name);
		}

		const location = args.to.location;
		const namespace = path.basename(location.fileName, ".proto");
		return builder.reference(args.to, builder.node`${namespace}.${location.name}`);
	}

	compileFile(file: SimpleTypeCompilerTargetFile): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder();

		const syntaxProto3Node = builder.node`syntax = "proto3";`;

		const imports = new Set<string>();
		file.references.forEach(ref => {
			if (ref.fileName === file.fileName) {
				return;
			}

			const relativePath = ref.fileName.startsWith("google/") ? ref.fileName : path.relative(path.dirname(file.fileName), ref.fileName);
			imports.add(`import ${JSON.stringify(relativePath)};`);
		});

		const includesNode = imports.size ? builder.node(Array.from(imports)).joinNodes("\n") : builder.node`// No imports`;

		return builder.node([syntaxProto3Node, includesNode, ...file.nodes, builder.node``]).joinNodes("\n\n");
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

			return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`message ${loc.name} {\n${builder.node(members).joinNodes("\n")}\n}`));
		});
	};

	// TODO: unlike Thrift, there are no type aliases here.
	// Should we implement as a wrapper message type?
	// Although, it seems like in many cases we may already be wrapping.
	//
	// toTypeAliasDeclaration(args: VisitorArgs<SimpleTypeCompilerNode>, inner: SimpleTypeCompilerNode): SimpleTypeCompilerNode {
	// 	if (inner instanceof SimpleTypeCompilerReferenceNode || inner instanceof SimpleTypeCompilerDeclarationNode) {
	// 		return inner;
	// 	}

	// 	const builder = this.compiler.nodeBuilder(args.type, args.path);
	// 	const declarationLocation = this.compiler.assignDeclarationLocation(args.type, args.path);
	// 	return builder.declaration(declarationLocation, this.withDeclarationDocComment(args.type, args.path, builder.node`typedef ${inner} ${declarationLocation.name}`));
	// }

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

	preferWrappedType(type: SimpleType, path: SimpleTypePath): boolean {
		const step = SimpleTypePath.last(path);
		if (step && this.wrapperTypeMap.get(type) === step.from) {
			return false;
		}

		if (type.kind === "ARRAY" || type.kind === "UNION") {
			const program = this.compiler.getCurrentProgram();
			if (program.getDeclarationLocation(type) || program.entryPoints.get(type)) {
				return true;
			}
		}

		return false;
	}

	compileIndex = (index: number) => String(index + 1);

	/**
	 * Compiles a member of a message or message oneOf.
	 * This function does quite a bit of work for Protobuf:
	 *
	 * - If member type is Array, member should be repeated, unless we already declared a wrapper type.
	 * - If member type is Union, member should be oneOf, unless we already declared a wrapper type.
	 */
	compileMember = this.withBuilder(({ type, path, visit }) => {
		const builder = this.compiler.nodeBuilder(type, path);
		const step = SimpleTypePath.lastMustBe(path, "INDEXED_MEMBER", "NAMED_MEMBER", "VARIANT");

		// member attributes
		const nullableType = type.kind === "UNION" && toNullableSimpleType(type);
		const nullable = nullableType && nullableType.kind === "NULLABLE";
		if (nullableType && nullableType.kind === "NULLABLE") {
			type = nullableType.type;
		}
		const optional = nullable || (step.step !== "VARIANT" && Boolean(step.member.optional));
		const defaultValue = isSimpleTypeLiteral(type) ? JSON.stringify(type.value) : undefined;

		// member name
		const targetTypeName = this.compiler.inferTypeName(type, path);
		const indexFieldName = `_${step.index}`;
		const memberName = step.step === "NAMED_MEMBER" ? step.member.name : step.step === "INDEXED_MEMBER" ? indexFieldName : targetTypeName || this.compiler.inferTypeName(type, path);
		const parentLocation: SimpleTypeCompilerLocation = {
			...(this.compiler.getCurrentLocation() || { fileName: "<unknown file>", name: "UnknownType" })
		};
		const namespace: SimpleTypeCompilerLocation = {
			fileName: parentLocation.fileName,
			namespace: (parentLocation.namespace || []).concat(parentLocation.name || "unknown"),
			name: memberName
		};
		const location = this.compiler.createUniqueLocation(type, path, namespace);

		// member documentation
		const docCommentNode: SimpleTypeCompilerNode | undefined = step.step !== "VARIANT" ? this.docCommentNode(builder, "  ", step.member) : undefined;

		if (type.kind === "UNION" && !this.preferWrappedType(type, path)) {
			// Compile oneOf field.
			// TODO: support reasonable handling of oneOf index.
			// but, that requires that we plumb index through multiple compileMember calls
			let i = this.preferWrappedType(type, []) ? 0 : 100;
			const oneOfVariants = Visitor.UNION.mapVariants<SimpleTypeCompilerNode>({
				type,
				path,
				visit: visit.with(({ type: variantType, path }) => {
					const variantTypeNode = builder.reference(this.compiler.compileType(variantType, path));
					const name = this.compiler.inferTypeName(variantType, path);
					const memberName = name[0].toLocaleLowerCase() + name.slice(1);
					const variantLocation = this.compiler.createUniqueLocation(variantType, path, {
						...SimpleTypeCompilerLocation.nestInside(location),
						name: memberName
					});
					return builder.node`    ${variantTypeNode} ${variantLocation.name} = ${this.compileIndex(i++)}; /* TODO: sound oneOf field number assignment */`;
				})
			});
			const oneOfMemberNode = builder.node`  oneOf ${location.name} {\n${builder.node(oneOfVariants).joinNodes("\n")}\n  };`;
			return builder.node([docCommentNode, oneOfMemberNode].filter(isDefined)).joinNodes("\n");
		} else if (type.kind === "ARRAY" && !this.preferWrappedType(type, path)) {
			const innerType = builder.reference(this.compiler.compileType(type.type, path));

			const memberNode: SimpleTypeCompilerNode = builder.node`  repeated ${optional ? "optional " : ""}${innerType} ${location.name} = ${this.compileIndex(step.index)}${
				defaultValue ? ` /* proto2 only: [default = ${defaultValue}] */` : ""
			};`;
			return builder.node([docCommentNode, memberNode].filter(isDefined)).joinNodes("\n");
		} else {
			const targetType = builder.reference(this.compiler.compileType(type, path));
			const memberNode: SimpleTypeCompilerNode = builder.node`  ${optional ? "optional " : ""}${targetType} ${location.name} = ${this.compileIndex(step.index)}${
				defaultValue ? ` /* proto2 only: [default = ${defaultValue}] */` : ""
			};`;
			return builder.node([docCommentNode, memberNode].filter(isDefined)).joinNodes("\n");
		}
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

	createWrapperInterfaceType(wrap: SimpleType, path: SimpleTypePath): SimpleTypeInterface {
		if (this.wrapperTypeMap.has(wrap)) {
			return this.wrapperTypeMap.get(wrap)!;
		}

		const newType: SimpleTypeInterface = {
			name: wrap.name ?? this.compiler.inferTypeName(wrap, path),
			getTypescript: wrap.getTypescript,
			kind: "INTERFACE",
			members: [
				{
					name: "t", // Should we use the type name?
					type: wrap
				}
			]
		};
		this.wrapperTypeMap.set(wrap, newType);

		return newType;
	}

	dropMemberKinds = new Set<SimpleTypeKind>(["FUNCTION", "METHOD"]);
	private filterMembers = (members: SimpleTypeCompilerNode[]) => members.filter(node => !(node.type?.kind && this.dropMemberKinds.has(node.type.kind)));

	private primitiveKind = {
		STRING_LITERAL: "string",
		NUMBER_LITERAL: "double",
		BOOLEAN_LITERAL: "bool",
		BIG_INT_LITERAL: "int64",
		BOOLEAN: "bool",
		STRING: "string",
		BIG_INT: "int64",
		NUMBER: "double"
	};

	private compileAny = this.withBuilder(({ builder }) => {
		return builder.reference({
			location: {
				fileName: "google/protobuf/any.proto",
				namespace: ["google", "protobuf"],
				name: "Any"
			}
		});
	});

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
		UNKNOWN: this.compileAny,
		ANY: this.compileAny,
		NEVER: this.compileNotRepresentable,

		// Well-known
		DATE: this.throwUnsupported,

		// Compile instantiated generics instead of copying the whole generic type
		ALIAS: Visitor.ALIAS.aliased,
		GENERIC_ARGUMENTS: Visitor.GENERIC_ARGUMENTS.aliased,

		// Algebraic types
		UNION: ({ type, path, visit }) => {
			// Eliminate trivial nullable unions.
			// Most fields in protobuf are nullable, so it seems like this is fine to do without any handling in Proto syntax?
			const nullable = toNullableSimpleType(type);
			if (nullable.kind === "NULLABLE") {
				return visit(undefined, nullable.type);
			}

			// Protobuf doesn't support stand-alone union types like Thrift does.
			// Instead we need to wrap in a message.
			//
			// Essentially, we are delegating to the compileMember function.
			const location = this.compiler.assignDeclarationLocation(type, path);
			const wrapper = this.createWrapperInterfaceType(nullable.type, path);
			this.compiler.getCurrentProgram().setDeclarationLocation(wrapper, location);
			this.compiler.getCurrentProgram().setDeclarationLocation(nullable.type, location);

			// TODO: instead of recursing, we should just call compileObjectLike directly
			return this.compiler.withLocation(location, () => visit(undefined, wrapper));
		},
		INTERSECTION: ({ type, visit }) => {
			if (!type.intersected) {
				throw new Error(`Target type system doesn't support intersection types`);
			}
			return visit(undefined, type.intersected);
		},

		// List types
		// No stand-alone list type. Delegate to member rendering in an interface
		ARRAY: ({ type, path, visit }) => visit(undefined, this.createWrapperInterfaceType(type, path)),
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
				return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`message ${loc.name} {\n${builder.node(members).joinNodes(",\n")}\n}`));
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
						return builder.node`  ${type.name} = ${JSON.stringify(type.type.value)};`;
					})
				});
				return builder.declaration(loc, this.withDeclarationDocComment(type, path, builder.node`enum ${loc.name} {\n${builder.node(members).joinNodes("\n")}\n}`));
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

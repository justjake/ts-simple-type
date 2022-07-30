import { SchemaOptions, TAnySchema, Type as ST } from "@sinclair/typebox";
import * as path from "path";
import type * as ts from "typescript";
import { isSimpleTypeLiteral, SimpleType, SimpleTypeClass, SimpleTypeInterface, SimpleTypeKind, SimpleTypeLiteral, SimpleTypeObject } from "../simple-type";
import { SimpleTypePath } from "../simple-type-path";
import {
	SimpleTypeCompiler,
	SimpleTypeCompilerDeclarationLocation,
	SimpleTypeCompilerDeclarationNode,
	SimpleTypeCompilerLocation,
	SimpleTypeCompilerNode,
	SimpleTypeCompilerNodeBuilder,
	SimpleTypeCompilerReferenceArgs,
	SimpleTypeCompilerReferenceNode,
	SimpleTypeCompilerTarget,
	SimpleTypeCompilerTargetFile
} from "../transform/compiler";
import { SimpleTypeKindVisitors, Visitor, VisitorArgs } from "../visitor";

// TODO: extract more common features? Not sure if an inheritance hierarchy here is a good idea.
class BaseCompilerTarget {
	static createCompiler<T extends JSONSchemaCompilerTarget>(this: { new (compiler: SimpleTypeCompiler): T }, typeChecker: ts.TypeChecker): SimpleTypeCompiler {
		return new SimpleTypeCompiler(typeChecker, compiler => new this(compiler));
	}

	constructor(public compiler: SimpleTypeCompiler) {}
}

/**
 * Compiles types to JSONSchema (via @sinclair/typebox).
 * To customize the compilation, make a subclass.
 *
 * https://github.com/sinclairzx81/typebox
 */
export class JSONSchemaCompilerTarget extends BaseCompilerTarget implements SimpleTypeCompilerTarget {
	private nodeToJsonSchema = new Map<SimpleTypeCompilerNode, TAnySchema>();

	private withSchema<T extends SimpleTypeCompilerNode>(node: T, schema: TAnySchema): T {
		const existing = this.nodeToJsonSchema.get(node);
		if (existing) {
			throw new Error(`Node ${node} already has a schema: ${JSON.stringify(existing)} (new: ${JSON.stringify(schema)})`);
		}
		this.nodeToJsonSchema.set(node, schema);
		return node;
	}

	private mustGetSchema = (node: SimpleTypeCompilerNode): TAnySchema => {
		const schema = this.nodeToJsonSchema.get(node);
		if (!schema) {
			const { type, path } = node;
			const pathString = (path && SimpleTypePath.toString(path, type)) || "<unknown>";
			throw new Error(`No schema for node ${node} at path ${pathString}`);
		}
		return schema;
	};

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
		const schema = this.mustGetSchema(typeExpression);
		if ("$id" in schema) {
			return this.asReference(args, typeExpression);
		} else {
			return typeExpression;
		}
	};

	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		const builder = this.compiler.anonymousNodeBuilder(args.from);
		const fsPath = path
			.relative(args.from.fileName, args.to.location.fileName)
			.replace(/^\.\.\//, "")
			.split(path.sep);
		const schemaPath = (args.to.location.namespace || []).concat(args.to.location.name);
		const ref = ST.Unsafe({
			ref: [...fsPath, ...schemaPath].join("/")
		});
		return this.withSchema(builder.reference(args.to, JSON.stringify(ref)), ref);
	}

	suggestDeclarationLocation: ((type: SimpleType, from: SimpleTypeCompilerLocation) => SimpleTypeCompilerLocation | SimpleTypeCompilerDeclarationLocation) | undefined = (type, from) => {
		// TODO: this is set to SimpleTypeCompilerLocation instead of SimpleTypeCompilerDeclarationLocation
		// should correct the type...
		const entrypoint = this.compiler.getCurrentProgram().entryPoints.get(type);

		if (entrypoint) {
			const suggest = {
				name: "",
				namespace: [],
				...(entrypoint as SimpleTypeCompilerLocation)
			};
			return suggest;
		}

		return {
			fileName: from.fileName,
			namespace: ["schemas"]
		};
	};

	/*
	{
    "$schema": "http://json-schema.org/draft-04/schema#",
    "type": "object",
    "additionalProperties": false,
    "properties": {
        "ReferenceToLocalSchema": {
            "$ref": "#/definitions/LocalType"
        },
        "ReferenceToExternalSchema": {
            "$ref": "Common.json#/definitions/ExternalType"
        }
    },
    "definitions": {
        "LocalType": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "no-write": {
                    "type": "boolean",
                    "default": false
                }
            }
        }
    }
}
*/

	compileFile(file: SimpleTypeCompilerTargetFile): SimpleTypeCompilerNode {
		const builder: SimpleTypeCompilerNodeBuilder = this.compiler.anonymousNodeBuilder();
		const program = this.compiler.getCurrentProgram();
		const schemaMainNode = file.nodes.find(node => {
			if (!node.type) {
				return false;
			}
			const entryLocation = program.entryPoints.get(node.type);
			if (entryLocation && node instanceof SimpleTypeCompilerDeclarationNode) {
				const equal = SimpleTypeCompilerLocation.fileAndNamespaceEqual(entryLocation, node.location);
				return equal;
			}
		});

		const definitionNodes = file.nodes.filter((node): node is SimpleTypeCompilerDeclarationNode => node instanceof SimpleTypeCompilerDeclarationNode && (node.location.namespace?.length || 0) > 0);

		const schemaMainType = schemaMainNode ? this.mustGetSchema(schemaMainNode) : undefined;

		const schema = ST.Unsafe({
			// TODO: $schema
			...schemaMainType,
			$id: schemaMainType?.$id === "" ? undefined : schemaMainType?.$id,
			$defs: Object.fromEntries(
				definitionNodes.map(node => {
					return [node.location.name, this.mustGetSchema(node)];
				})
			)
		});

		return this.withSchema(builder.node(JSON.stringify(schema, undefined, "  ") + "\n"), schema);
	}

	asSchema =
		<ST extends SimpleType>(getSchema: (args: VisitorArgs<SimpleTypeCompilerNode, ST>) => TAnySchema | [TAnySchema, SimpleTypeCompilerNode[]]): Visitor<SimpleTypeCompilerNode, ST> =>
		args => {
			const schemaOrTuple = getSchema(args);
			const schema = Array.isArray(schemaOrTuple) ? schemaOrTuple[0] : schemaOrTuple;
			const content = Array.isArray(schemaOrTuple) ? schemaOrTuple[1] : [JSON.stringify(schema)];
			const builder = this.compiler.nodeBuilder(args.type, args.path);
			return this.withSchema(builder.node(content), schema);
		};

	withBuilder = <ST extends SimpleType>(
		visitor: (args: VisitorArgs<SimpleTypeCompilerNode, ST> & { builder: SimpleTypeCompilerNodeBuilder }) => SimpleTypeCompilerNode
	): Visitor<SimpleTypeCompilerNode, ST> => {
		return args => {
			const builder = this.compiler.nodeBuilder(args.type, args.path);
			return visitor({ ...args, builder });
		};
	};

	compileObjectLike: Visitor<SimpleTypeCompilerNode, SimpleTypeObject | SimpleTypeClass | SimpleTypeInterface> = ({ type, path, visit }) => {
		const members = this.filterMembers(
			Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
				path,
				type,
				visit: visit.with(({ type, path }) => {
					const step = SimpleTypePath.lastMustBe(path, "NAMED_MEMBER");
					const innerNode = this.compiler.compileType(type, path);
					const schema = step.member.optional ? ST.Optional(this.mustGetSchema(innerNode)) : this.mustGetSchema(innerNode);
					const node: SimpleTypeCompilerNode = this.withSchema(this.compiler.nodeBuilder(type, path).node(innerNode), schema);
					node.name = step.member.name;
					return node;
				})
			})
		);

		const builder = this.compiler.nodeBuilder(type, path);
		const schema = ST.Object(Object.fromEntries(members.map(member => [member.name, this.mustGetSchema(member)])), this.getSchemaOptions(type, path));
		return this.withSchema(builder.node(members), schema);
	};

	asReference(args: VisitorArgs<SimpleTypeCompilerNode>, inner: SimpleTypeCompilerNode): SimpleTypeCompilerNode {
		if (inner instanceof SimpleTypeCompilerReferenceNode) {
			return inner;
		}

		const builder = this.compiler.nodeBuilder(args.type, args.path);
		const declarationLocation = this.compiler.assignDeclarationLocation(args.type, args.path);
		const schema = this.mustGetSchema(inner);
		const declaration = builder.isDeclaration(inner) ? inner : this.withSchema(builder.declaration(declarationLocation, inner), schema);
		return builder.reference(declaration);
	}

	throwUnsupported: Visitor<SimpleTypeCompilerNode> = ({ type }) => {
		throw new Error(`Unsupported SimpleType kind: ${type.kind}`);
	};

	getSchemaOptions(type: SimpleType, path: SimpleTypePath): SchemaOptions {
		const options: SchemaOptions = {};

		if (type.name) {
			options.title = type.name;
		}

		if (this.compiler.isExportedFromSourceLocation(type) || this.compiler.getCurrentProgram().entryPoints.has(type)) {
			const loc = this.compiler.assignDeclarationLocation(type, path);
			options.$id = loc.name;
		}

		const docInfo = this.compiler.getDocumentationComment(type);
		if (docInfo && docInfo.docComment) {
			options.description = docInfo.docComment;
		}

		return options;
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

	compileLiteral = this.asSchema<SimpleTypeLiteral>(args => ST.Literal(typeof args.type.value === "bigint" ? Number(args.type.value) : args.type.value));

	compileKind: SimpleTypeKindVisitors<SimpleTypeCompilerNode> = {
		// Literals
		STRING_LITERAL: this.compileLiteral,
		NUMBER_LITERAL: this.compileLiteral,
		BOOLEAN_LITERAL: this.compileLiteral,
		BIG_INT_LITERAL: this.compileLiteral,
		ES_SYMBOL_UNIQUE: this.compileLiteral,

		// Primitives
		BOOLEAN: this.asSchema(() => ST.Boolean()),
		STRING: this.asSchema(() => ST.String()),
		BIG_INT: this.asSchema(() => ST.Integer()),
		NUMBER: this.asSchema(() => ST.Number()),

		// None-like
		NULL: this.asSchema(() => ST.Null()),
		UNDEFINED: this.asSchema(() => ST.Undefined()),
		VOID: this.asSchema(() => ST.Void()),

		// Top & bottom
		UNKNOWN: this.asSchema(() => ST.Unknown()),
		ANY: this.asSchema(() => ST.Any()),
		NEVER: this.throwUnsupported,

		// Well-known
		DATE: this.throwUnsupported,

		// Compile instantiated generics instead of copying the whole generic type
		ALIAS: Visitor.ALIAS.aliased,
		GENERIC_ARGUMENTS: Visitor.GENERIC_ARGUMENTS.aliased,

		// Algebraic types
		UNION: this.asSchema(({ type, path, visit }) => {
			// TODO: what about references?
			const variants = Visitor.UNION.mapVariants({
				path,
				type,
				visit
			});
			return [ST.Union(variants.map(this.mustGetSchema), this.getSchemaOptions(type, path)), variants];
		}),
		INTERSECTION: ({ type, visit }) => {
			const intersected = type.intersected;
			if (!intersected) {
				throw new Error(`Target type system doesn't support intersection types`);
			}
			return visit(undefined, intersected);
		},

		// List types
		ARRAY: this.asSchema(({ type, path, visit }) => {
			const inner = Visitor.ARRAY.numberIndex({ type, path, visit });
			return [ST.Array(this.mustGetSchema(inner), this.getSchemaOptions(type, path)), [inner]];
		}),
		TUPLE: this.asSchema(({ path, type, visit }) => {
			const members = Visitor.TUPLE.mapIndexedMembers({ path, type, visit });
			return [ST.Tuple(members.map(this.mustGetSchema), this.getSchemaOptions(type, path)), members];
		}),

		// Object
		INTERFACE: this.compileObjectLike,
		CLASS: this.compileObjectLike,
		OBJECT: this.compileObjectLike,

		// Enum
		ENUM: this.asSchema(({ type, path }) => {
			const memberLiterals = type.types.map(member => [member.name, isSimpleTypeLiteral(member.type) ? member.type.value : "<UNKNOWN ENUM MEMBER>"]);
			return ST.Enum(Object.fromEntries(memberLiterals), this.getSchemaOptions(type, path));
		}),
		ENUM_MEMBER: this.throwUnsupported,

		// Callable
		FUNCTION: args => this.compileKind.VOID(args as any),
		METHOD: args => this.compileKind.VOID(args as any),

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

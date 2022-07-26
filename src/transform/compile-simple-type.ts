/**
 * API to convert SimpleType to strings, and emit those strings in one or more
 * files.
 */

import { SourceMapGenerator, SourceNode } from "source-map";
import type * as ts from "typescript";
import { SimpleType, SimpleTypeAsTypescript, SimpleTypeMember, SimpleTypeMemberAsTypescript } from "../simple-type";
import { SimpleTypePath, SimpleTypePathStep } from "../simple-type-path";
import { getTypescriptModule } from "../ts-module";
import { Visitor, walkRecursive } from "../visitor";
import { toSimpleType, ToSimpleTypeOptions } from "./to-simple-type";

const NO_SOURCE_LOCATION_FOUND = {
	typescript: undefined,
	sourceMap: {
		source: null,
		sourceContent: null,
		line: null,
		column: null
	}
};

const NO_DESTINATION_LOCATION: SimpleTypeCompilerLocation = {
	fileName: ""
};

type Chunks = Array<string | SourceNode> | SourceNode | string;

interface SimpleTypeCompilerState {
	readonly outputLocation: SimpleTypeCompilerLocation | undefined;
	readonly program: SimpleTypeCompilerProgram;
}

/**
 * SimpleTypeCompiler helps you compile {@link SimpleType}s or TypeScript types
 * to an arbitrary textual target format.
 */
export class SimpleTypeCompiler {
	constructor(public readonly checker: ts.TypeChecker, getTarget: (compiler: SimpleTypeCompiler) => SimpleTypeCompilerTarget) {
		this.target = getTarget(this);
	}
	private target: SimpleTypeCompilerTarget;
	private current: SimpleTypeCompilerState = {
		outputLocation: undefined,
		program: new SimpleTypeCompilerProgram()
	};

	private toSimpleTypeOptions: ToSimpleTypeOptions = {
		addMethods: true,
		cache: new WeakMap()
	};

	/**
	 * Compile a list of entrypoint types.
	 */
	compileProgram(
		entryPoints: Array<{
			inputType: SimpleType | ts.Type;
			outputLocation: SimpleTypeCompilerLocation;
		}>,
		outputProgram = new SimpleTypeCompilerProgram()
	): SimpleTypeCompilerOutput {
		return this.withState(
			{
				outputLocation: undefined,
				program: outputProgram
			},
			() => {
				// Assign declarations for each entrypoint before we start compiling.
				// That way, compilations can rely on entrypoint info.
				for (const entry of entryPoints) {
					const type = this.toSimpleType(entry.inputType);
					outputProgram.entryPoints.set(type, this.assignDeclarationLocation(type, entry.outputLocation));
				}

				// Compile each type into an AST node.
				// Assign all those AST nodes to files in the program.
				const assignedToFile = new Set<SourceNode>();
				const outputFileNames = new Set<string>();
				const assignNodeToFile = (node: SourceNode, currentFile: SimpleTypeCompilerTargetFile, top?: boolean) => {
					outputFileNames.add(currentFile.fileName);

					if (assignedToFile.has(node)) {
						return;
					}
					assignedToFile.add(node);

					if (node instanceof SimpleTypeCompilerReferenceNode) {
						currentFile.addReference(node.refersTo);
					}

					if (node instanceof SimpleTypeCompilerDeclarationReferenceNode) {
						const declarationFile = outputProgram.getOrCreateFile(node.refersToDeclaration.location.fileName);
						assignNodeToFile(node.refersToDeclaration, declarationFile);
					}

					if (node instanceof SimpleTypeCompilerDeclarationNode) {
						currentFile = outputProgram.getOrCreateFile(node.location.fileName);
					}

					if (node instanceof SimpleTypeCompilerNode && (top || node instanceof SimpleTypeCompilerDeclarationNode)) {
						currentFile.addNode(node);
					}

					if (node.children) {
						node.children.forEach(child => {
							if (child instanceof SourceNode) {
								assignNodeToFile(child, currentFile);
							}
						});
					}
				};

				for (const [type, location] of outputProgram.entryPoints) {
					const node = this.compileType(type, undefined, location);
					const currentFile = outputProgram.getOrCreateFile(location.fileName);
					assignNodeToFile(node, currentFile, true);
				}

				// Compile each file to a final AST node, which we turn into a string and a source map.
				const output: SimpleTypeCompilerOutput = {
					files: new Map(),
					program: outputProgram
				};
				for (const fileName of outputFileNames) {
					const file = outputProgram.getOrCreateFile(fileName);
					const fileNode = this.target.compileFile(file);
					const fileWithSourceMap = fileNode.toStringWithSourceMap({ file: fileName });
					output.files.set(fileName, {
						fileName,
						ast: fileNode,
						compiledFrom: file,
						sourceMap: fileWithSourceMap.map,
						text: fileWithSourceMap.code
					});
				}

				return output;
			}
		);
	}

	compileType(
		type: SimpleType | ts.Type,
		path: SimpleTypePath = SimpleTypePath.empty(),
		outputLocation?: {
			fileName: string;
			namespace?: string[];
		}
	): SimpleTypeCompilerNode {
		const simpleType = this.toSimpleType(type);
		return this.withState(
			{
				...this.current,
				outputLocation: outputLocation ?? this.current.outputLocation
			},
			() => {
				try {
					return walkRecursive<SimpleTypeCompilerNode>(path, simpleType, args => {
						const cachedNode = this.current.program.getAstNode(args.type);
						if (cachedNode) {
							return cachedNode;
						} else if (SimpleTypePath.includes(args.path, args.type)) {
							// Circular compilation: try to use a reference if possible.
							const declarationLocation = this.current.program.getDeclarationLocation(args.type);
							if (declarationLocation) {
								if (!this.current.outputLocation) {
									throw new Error(`Circular compilation: cannot create reference because current location is not set.`);
								}
								return this.compileReference({
									from: this.current.outputLocation,
									to: { location: declarationLocation }
								});
							}
						}
						const result = this.target.compileType(args);
						if (result.shouldCache) {
							this.current.program.setAstNode(args.type, result);
						}
						return result;
					});
				} catch (error) {
					if (error && error instanceof RangeError && error.message.includes("call stack size")) {
						const circularPart = SimpleTypePath.getSubpathFrom(path, simpleType);
						const firstNamedType = circularPart?.find(step => step.from.name)?.from.name;
						const circularError = new Error(
							`Circular compilation: ${firstNamedType ? `in type ${firstNamedType}: ` : ""}use compiler.assignDeclarationLocation(${
								firstNamedType || "type"
							}) before recursing, or build a reference node manually.`
						);
						circularError.cause = error;
						throw circularError;
					}
					throw error;
				}
			}
		);
	}

	compileReference(referenceArgs: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		return this.withState(
			{
				...this.current,
				outputLocation: referenceArgs.from
			},
			() => {
				const result = this.target.compileReference(referenceArgs);
				if (result.constructor === SimpleTypeCompilerNode && result.shouldCache) {
					const upgrade = this.anonymousNodeBuilder().reference(referenceArgs.to, result);
					return upgrade;
				}
				return result;
			}
		);
	}

	/**
	 * During a call to {@link compileProgram}, this method returns the in-progress program.
	 * You can use it to explicitly add nodes or references to files before they are compiled.
	 */
	getCurrentProgram(): SimpleTypeCompilerProgram {
		return this.current.program;
	}

	/**
	 * During a call to {@link compileProgram}, this method returns the in-progress location.
	 */
	getCurrentLocation(): SimpleTypeCompilerLocation | undefined {
		return this.current.outputLocation;
	}

	/**
	 * Convert a type to a SimpleType.
	 */
	toSimpleType(type: SimpleType | ts.Type): SimpleType {
		return toSimpleType(type, this.checker, this.toSimpleTypeOptions);
	}

	/**
	 * Retrieve typescript information about the given type.
	 * @throws if `type` was converted to SimpleType by a different compiler.
	 */
	toTypescript(type: SimpleType): SimpleTypeAsTypescript;
	/**
	 * Retrieve typescript information about the given member.
	 * @throws if `type` was compiled by a different compiler.
	 */
	toTypescript(type: SimpleTypeMember): SimpleTypeMemberAsTypescript;
	toTypescript(type: SimpleType | SimpleTypeMember): SimpleTypeAsTypescript | SimpleTypeMemberAsTypescript {
		const ts = type.getTypescript?.();
		if (!ts) {
			throw new Error("Cannot retrieve Typescript representation: make sure type was by this compiler or with `addMethods: true`");
		}
		return ts;
	}

	/**
	 * Return the type's name, or try to infer one if it is anonymous.
	 */
	inferTypeName(rootType: SimpleType): string {
		const visitor: Visitor<string | undefined> = ({ type: derivedType, path, visit }) => {
			if (derivedType.name) {
				return derivedType.name;
			}

			const typescriptType = derivedType.getTypescript?.().type;
			const originalSimpleType = typescriptType && this.toSimpleType(typescriptType);
			const type = originalSimpleType || derivedType;

			if (type.name) {
				return type.name;
			}

			switch (type.kind) {
				case "ARRAY": {
					const inner = Visitor.ARRAY.numberIndex({ type, path, visit });
					return inner ? `ArrayOf${inner}` : "Array";
				}
				case "UNION": {
					const inner = Visitor.UNION.mapVariants({ type, path, visit });
					return inner.some(Boolean) ? inner.filter(Boolean).join("Or") : "Union";
				}
				case "INTERSECTION": {
					const inner = Visitor.INTERSECTION.mapVariants({ type, path, visit });
					return inner.some(Boolean) ? inner.filter(Boolean).join("And") : "Intersection";
				}
				case "GENERIC_ARGUMENTS": {
					const inner = Visitor.GENERIC_ARGUMENTS.mapGenericArguments({ type, path, visit });
					const args = inner.some(Boolean) ? inner.filter(Boolean).join("And") : undefined;
					const genericName = Visitor.GENERIC_ARGUMENTS.genericTarget({ type, path, visit }) ?? "Generic";
					const outputName = Visitor.GENERIC_ARGUMENTS.aliased({ type, path, visit });
					return outputName ? outputName : `${genericName || "Generic"}${args ? "Of" : ""}${args || ""}`;
				}
				case "ALIAS": {
					const aliasedName = Visitor.ALIAS.aliased({ type, path, visit });
					if (!aliasedName) {
						// Try some crazy stuff.
						return undefined;
					}
					return aliasedName;
				}
			}

			return undefined;
		};

		const name = walkRecursive([], rootType, visitor);
		return name ?? snakeCaseToCamelCase(`ANONYMOUS_${rootType.kind}`);
	}

	getSourceLocation = getSourceLocationOfSimpleType;

	isExportedFromSourceLocation(type: SimpleType): boolean {
		const { typescript } = getSourceLocationOfSimpleType(type);
		if (!typescript) {
			return false;
		}

		const exportedSymbol = typescript.checker.getExportSymbolOfSymbol(typescript.symbol);
		const moduleSymbol = typescript.checker.getSymbolAtLocation(typescript.sourceFile);
		return Boolean(moduleSymbol && typescript.checker.getExportsOfModule(moduleSymbol).includes(exportedSymbol));
	}

	/**
	 * Assign a declaration location in the output program to the given `type`.
	 * If the type already has an assigned declaration location, it's returned instead.
	 * By default, the location will be a unique name inside the current file and namespace of the compiler.
	 *
	 * Once a location is assigned to a type, the compiler can use references to that location instead
	 * of repeatedly compiling the same type. This is critical for recursive type definitions.
	 *
	 * It is the caller's responsibility to ensure a {@link SimpleTypeCompilerDeclarationNode}
	 * exists at that location in the compiler's output.
	 *
	 * @param location Assign the type to this location.
	 * @returns The assigned location, suitable for use
	 */
	assignDeclarationLocation(type: SimpleType, location?: SimpleTypeCompilerLocation & { name?: string }): SimpleTypeCompilerDeclarationLocation {
		const existingLocationForType = this.current.program.getDeclarationLocation(type);
		if (existingLocationForType) {
			return existingLocationForType;
		}

		const currentFilenameNamespace: SimpleTypeCompilerLocation | undefined = this.current.outputLocation && {
			fileName: this.current.outputLocation.fileName,
			namespace: this.current.outputLocation.namespace
		};

		const suggestedLocation: SimpleTypeCompilerLocation & { name?: string } =
			location ?? this.target.suggestDeclarationLocation?.(type, currentFilenameNamespace ?? NO_DESTINATION_LOCATION) ?? currentFilenameNamespace ?? NO_DESTINATION_LOCATION;

		const maybeUniqueLocation: SimpleTypeCompilerDeclarationLocation = {
			name: suggestedLocation.name ?? this.inferTypeName(type),
			fileName: suggestedLocation.fileName,
			namespace: suggestedLocation.namespace
		};

		const count = this.current.program.getDeclarationLocationCount(maybeUniqueLocation);
		this.current.program.setDeclarationLocationCount(maybeUniqueLocation, count + 1);

		const uniqueLocation: SimpleTypeCompilerDeclarationLocation = {
			...maybeUniqueLocation,
			name: count > 0 ? `${maybeUniqueLocation.name}${count}` : maybeUniqueLocation.name,
			toString() {
				return this.name;
			}
		};

		this.current.program.setDeclarationLocation(type, uniqueLocation);
		return uniqueLocation;
	}

	/**
	 * Create an AST node builder.
	 * @param type AST nodes will be source-mapped to the input declaration location of this type.
	 * @param path AST nodes will reference this path. Useful for debugging.
	 * @param location An alternate output location, used when building references to locations or declarations. See {@link SimpleTypeCompilerNodeBuilder#reference}.
	 */
	nodeBuilder(type: SimpleType, path: SimpleTypePath, location?: SimpleTypeCompilerLocation): SimpleTypeCompilerNodeBuilder {
		const fromLocation = location ?? this.current.outputLocation;
		return new SimpleTypeCompilerNodeBuilder(type, path, fromLocation, this);
	}

	/**
	 * Create an AST node builder without an associated type.
	 * Prefer to use {@link nodeBuilder} when compiling types.
	 * @param location An alternate output location, used when building references to locations or declarations. See {@link SimpleTypeCompilerNodeBuilder#reference}.
	 */
	anonymousNodeBuilder(location?: SimpleTypeCompilerLocation): SimpleTypeCompilerNodeBuilder {
		const fromLocation = location ?? this.current.outputLocation;
		return new SimpleTypeCompilerNodeBuilder(undefined, undefined, fromLocation, this);
	}

	private withState<T>(state: SimpleTypeCompilerState, fn: () => T): T {
		const prevState = this.current;
		try {
			this.current = state;
			return fn();
		} finally {
			this.current = prevState;
		}
	}
}

function outputLocationToKey(location: Partial<SimpleTypeCompilerDeclarationLocation>) {
	return `file:${location.fileName} namespace:${location.namespace?.join("/") ?? "<none>"} name:${location.name ?? "<none>"}`;
}

function snakeCaseToCamelCase(snakeCase: string) {
	const lowerCamelCase = snakeCase.toLowerCase().replace(/(_[a-z])/g, match => match.toUpperCase().slice(1));
	return lowerCamelCase.slice(0, 1).toUpperCase() + lowerCamelCase.slice(1);
}

function getSourceLocationOfSimpleType(type: SimpleType) {
	const typescriptType = type.getTypescript?.();
	if (!typescriptType) {
		return NO_SOURCE_LOCATION_FOUND;
	}

	const symbol = typescriptType.symbol || typescriptType.type.aliasSymbol || typescriptType.type.getSymbol();
	if (!symbol) {
		return NO_SOURCE_LOCATION_FOUND;
	}

	const node = symbol.getDeclarations()?.[0] || symbol.valueDeclaration;
	if (!node) {
		return NO_SOURCE_LOCATION_FOUND;
	}

	const sourceFile = node.getSourceFile();
	const ts = getTypescriptModule();
	const loc = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
	return {
		typescript: {
			...typescriptType,
			symbol,
			declaration: node,
			sourceFile
		},
		sourceMap: {
			column: loc.character,
			line: loc.line,
			source: sourceFile.fileName,
			sourceContent: sourceFile.text
		}
	};
}

export class SimpleTypeCompilerNodeBuilder {
	constructor(private type: SimpleType | undefined, private path: SimpleTypePath | undefined, private fromLocation: SimpleTypeCompilerLocation | undefined, private compiler: SimpleTypeCompiler) {
		this.node = this.node.bind(this);
		this.references = this.references.bind(this);
		this.reference = this.reference.bind(this);
		this.isDeclaration = this.isDeclaration.bind(this);
		this.declaration = this.declaration.bind(this);
	}

	private nodeOfType<T extends SimpleTypeCompilerNode>(kind: SimpleTypeCompilerNodeConstructors<T>, chunks: Chunks): T {
		if (this.type && this.path) {
			return kind.forType(this.type, this.path, chunks);
		} else {
			return kind.fromScratch(chunks);
		}
	}

	isNode(node: object): node is SimpleTypeCompilerNode {
		return node instanceof SimpleTypeCompilerNode;
	}

	/** Create an output AST node */
	node(template: TemplateStringsArray, ...chunks: Chunks[]): SimpleTypeCompilerNode;
	/** Create an output AST node */
	node(chunks: Chunks): SimpleTypeCompilerNode;
	node(something: Chunks | TemplateStringsArray, ...manyChunks: Chunks[]): SimpleTypeCompilerNode {
		if (manyChunks.length === 0) {
			return this.nodeOfType(SimpleTypeCompilerNode, something as Chunks);
		}
		const template = something as TemplateStringsArray;
		let finalChunks: Chunks = [];
		for (let i = 0; i < template.length; i++) {
			finalChunks.push(template[i]);
			if (i in manyChunks) {
				finalChunks = finalChunks.concat(manyChunks[i]);
			}
		}
		return this.nodeOfType(SimpleTypeCompilerNode, finalChunks);
	}

	/**
	 * Map over the given nodes, returning a {@link SimpleTypeCompilerReferenceNode} for any declaration nodes.
	 */
	references(nodes: SimpleTypeCompilerNode[]): SimpleTypeCompilerNode {
		const chunk = nodes.map(node => this.reference(node));
		return this.node(chunk);
	}

	/** Create a new reference node. */
	reference(toLocation: { location: SimpleTypeCompilerDeclarationLocation }, chunks: Chunks): SimpleTypeCompilerReferenceNode;
	/** Compile a reference to the given declaration. */
	reference(toLocation: { location: SimpleTypeCompilerDeclarationLocation }): SimpleTypeCompilerReferenceNode;
	/** Create a new reference node. */
	reference(toDeclaration: SimpleTypeCompilerDeclarationNode, chunks: Chunks): SimpleTypeCompilerDeclarationReferenceNode;
	/** Compile a reference to the given declaration. */
	reference(toDeclaration: SimpleTypeCompilerDeclarationNode): SimpleTypeCompilerDeclarationReferenceNode;
	/** Compile a reference to the given node if it's a declaration. Otherwise, return the node. */
	reference(toNode: SimpleTypeCompilerNode): SimpleTypeCompilerNode;
	reference(toNode: SimpleTypeCompilerNode | undefined): SimpleTypeCompilerNode | undefined;
	reference(
		toDeclaration: SimpleTypeCompilerDeclarationNode | SimpleTypeCompilerNode | { location: SimpleTypeCompilerDeclarationLocation } | undefined,
		chunks?: Chunks
	): SimpleTypeCompilerNode | undefined {
		// Pass through undefined
		if (!toDeclaration) {
			return undefined;
		}

		// Pass through non-declaration nodes
		if (this.isNode(toDeclaration) && !this.isDeclaration(toDeclaration)) {
			return toDeclaration;
		}

		// No chunks: compile reference
		const toLocation = toDeclaration.location;
		if (chunks === undefined) {
			const { fromLocation } = this;
			if (!fromLocation) {
				throw new Error(`Cannot build reference to ${toLocation.fileName}:${toLocation.namespace?.join(".")}.${toLocation.name}: no current location`);
			}
			return this.compiler.compileReference({ from: fromLocation, to: toDeclaration });
		}

		// Chunk: build node from scratch
		let node;
		if (this.isNode(toDeclaration)) {
			node = this.nodeOfType(SimpleTypeCompilerDeclarationReferenceNode, chunks);
			node.refersToDeclaration = toDeclaration;
		} else {
			node = this.nodeOfType(SimpleTypeCompilerReferenceNode, chunks);
		}
		node.refersTo = toLocation;
		return node;
	}

	isDeclaration(node: object): node is SimpleTypeCompilerDeclarationNode {
		return node instanceof SimpleTypeCompilerDeclarationNode;
	}

	/**
	 * Create a declaration node at the given location.
	 * @param location The declaration will be rendered in this file by the compilation.
	 */
	declaration(location: SimpleTypeCompilerDeclarationLocation, chunks: Chunks): SimpleTypeCompilerDeclarationNode {
		const node = this.nodeOfType(SimpleTypeCompilerDeclarationNode, chunks);
		node.location = location;
		return node;
	}
}

interface SourceNodeConstructor<T> {
	new (line: number | null, column: number | null, source: string | null, chunks?: Chunks, name?: string): T;
}

interface SimpleTypeCompilerNodeConstructors<T> extends SourceNodeConstructor<T> {
	forType<T extends SimpleTypeCompilerNode>(this: SourceNodeConstructor<T>, type: SimpleType, path: SimpleTypePath, chunks: Chunks): T;
	fromScratch<T extends SimpleTypeCompilerNode>(this: SourceNodeConstructor<T>, chunks: Chunks): T;
}

export class SimpleTypeCompilerNode extends SourceNode {
	static forType<T extends SimpleTypeCompilerNode>(this: SourceNodeConstructor<T>, type: SimpleType, path: SimpleTypePath, chunks: Chunks): T {
		const location = getSourceLocationOfSimpleType(type).sourceMap;
		const node = new this(location.line, location.column, location.source, chunks);
		node.type = type;
		node.path = path;
		node.step = SimpleTypePath.last(path);
		if (location.sourceContent !== null && !(node.source.startsWith("lib.") && node.source.endsWith(".d.ts"))) {
			node.setSourceContent(location.source, location.sourceContent);
		}
		return node;
	}

	static fromScratch<T extends SimpleTypeCompilerNode>(this: SourceNodeConstructor<T>, chunks: Chunks): T {
		return new this(null, null, null, chunks);
	}

	type?: SimpleType;
	path?: SimpleTypePath;
	step?: SimpleTypePathStep;

	shouldCache = true;

	/**
	 * Mark this node as non-cacheable for a type.
	 * Use this method when you may compile a type two different ways depending on
	 * how it's referenced. Eg, for an enum member should be compiled one way
	 * inside its containing enum declaration, and another way when referenced by a
	 * member in another type.
	 */
	doNotCache(): this {
		this.shouldCache = false;
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

export class SimpleTypeCompilerDeclarationNode extends SimpleTypeCompilerNode {
	location!: SimpleTypeCompilerDeclarationLocation;
}

export class SimpleTypeCompilerReferenceNode extends SimpleTypeCompilerNode {
	refersTo!: SimpleTypeCompilerDeclarationLocation;
	shouldCache = false;
}

export class SimpleTypeCompilerDeclarationReferenceNode extends SimpleTypeCompilerReferenceNode {
	refersToDeclaration!: SimpleTypeCompilerDeclarationNode;
}
export interface SimpleTypeCompilerLocation {
	fileName: string;
	namespace?: string[];
}

export interface SimpleTypeCompilerDeclarationLocation extends SimpleTypeCompilerLocation {
	name: string;
	toString?: () => string;
}

export const SimpleTypeCompilerLocation = {
	fileNameEqual(a: SimpleTypeCompilerLocation, b: SimpleTypeCompilerLocation): boolean {
		return a.fileName === b.fileName;
	},

	namespaceEqual(a: SimpleTypeCompilerLocation, b: SimpleTypeCompilerLocation): boolean {
		if (a.namespace === b.namespace) {
			return true;
		}

		if (!a.namespace || !b.namespace) {
			return false;
		}

		return a.namespace.length === b.namespace.length && a.namespace.every((name, i) => name === b.namespace?.[i]);
	},

	fileAndNamespaceEqual(a: SimpleTypeCompilerLocation, b: SimpleTypeCompilerLocation): boolean {
		return SimpleTypeCompilerLocation.fileNameEqual(a, b) && SimpleTypeCompilerLocation.namespaceEqual(a, b);
	}
};

class SimpleTypeCompilerProgram {
	public entryPoints = new Map<SimpleType, SimpleTypeCompilerDeclarationLocation>();
	public files = new Map<string, SimpleTypeCompilerTargetFile>();

	private declarationLocationNameCount = new Map<string, number>();
	private typeToDeclarationLocationCache = new WeakMap<SimpleType, SimpleTypeCompilerDeclarationLocation>();
	private typeToAstNodeCache = new WeakMap<SimpleType, SimpleTypeCompilerNode>();

	getOrCreateFile(fileName: string): SimpleTypeCompilerTargetFile {
		let file = this.files.get(fileName);
		if (!file) {
			file = new SimpleTypeCompilerTargetFile(fileName);
			this.files.set(fileName, file);
		}
		return file;
	}

	getDeclarationLocation(type: SimpleType): SimpleTypeCompilerDeclarationLocation | undefined {
		return this.typeToDeclarationLocationCache.get(type);
	}

	setDeclarationLocation(type: SimpleType, location: SimpleTypeCompilerDeclarationLocation): void {
		this.typeToDeclarationLocationCache.set(type, location);
	}

	getDeclarationLocationCount(location: SimpleTypeCompilerDeclarationLocation): number {
		return this.declarationLocationNameCount.get(outputLocationToKey(location)) ?? 0;
	}

	setDeclarationLocationCount(location: SimpleTypeCompilerDeclarationLocation, count: number): void {
		this.declarationLocationNameCount.set(outputLocationToKey(location), count);
	}

	getAstNode(type: SimpleType): SimpleTypeCompilerNode | undefined {
		return this.typeToAstNodeCache.get(type);
	}

	setAstNode(type: SimpleType, node: SimpleTypeCompilerNode): void {
		this.typeToAstNodeCache.set(type, node);
	}
}

export class SimpleTypeCompilerTargetFile {
	constructor(public fileName: string) {}

	private _references = new Map<string, SimpleTypeCompilerDeclarationLocation>();
	private _nodes = new Set<SimpleTypeCompilerNode>();

	get references(): readonly SimpleTypeCompilerDeclarationLocation[] {
		return Array.from(this._references.values());
	}

	addReference(location: SimpleTypeCompilerDeclarationLocation) {
		this._references.set(outputLocationToKey(location), location);
	}

	get nodes(): readonly SimpleTypeCompilerNode[] {
		return Array.from(this._nodes);
	}

	addNode(node: SimpleTypeCompilerNode) {
		this._nodes.add(node);
	}

	get isEmpty() {
		return this._references.size === 0 && this._nodes.size === 0;
	}
}

export interface SimpleTypeCompilerOutputFile {
	fileName: string;
	compiledFrom: SimpleTypeCompilerTargetFile;
	ast: SimpleTypeCompilerNode;
	text: string;
	sourceMap: SourceMapGenerator;
}

export interface SimpleTypeCompilerOutput {
	files: Map<string, SimpleTypeCompilerOutputFile>;
	program: SimpleTypeCompilerProgram;
}

export interface SimpleTypeCompilerReferenceArgs {
	from: SimpleTypeCompilerLocation;
	to: { location: SimpleTypeCompilerDeclarationLocation } | SimpleTypeCompilerDeclarationNode;
}

export interface SimpleTypeCompilerTarget {
	/**
	 * Called by the type compiler to compile a type.
	 * Most of a compiler target's logic lives in this function.
	 *
	 * Use {@link SimpleTypeCompiler#nodeBuilder} to create nodes during the compilation.
	 */
	compileType: Visitor<SimpleTypeCompilerNode>;

	/**
	 * Called by the type compiler if you build a reference node using a location.
	 *
	 * @see {@link SimpleTypeCompilerNodeBuilder#reference}
	 */
	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode;

	/**
	 * Compile a file that contains one or more declarations.
	 */
	compileFile(file: SimpleTypeCompilerTargetFile): SimpleTypeCompilerNode;

	/**
	 * Called by the type compiler in {@link SimpleTypeCompiler#assignDeclarationLocation}.
	 *
	 * Assign a destination file and namespace to a type when it's compiled to declaration node.
	 * If you have no opinion about the placement of this type, you can return `from` - which will place it in the current file and namespace.
	 *
	 * @param type The type to assign a destination declaration location to.
	 * @param from The current file and namespace we are compiling from.
	 */
	suggestDeclarationLocation?: (type: SimpleType, from: SimpleTypeCompilerLocation) => SimpleTypeCompilerLocation | SimpleTypeCompilerDeclarationLocation;
}

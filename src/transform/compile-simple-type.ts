/**
 * API to convert SimpleType to strings, and emit those strings in one or more
 * files.
 */

import { SourceNode } from "source-map";
import type * as ts from "typescript";
import { SimpleType } from "../simple-type";
import { SimpleTypePath, SimpleTypePathStep } from "../simple-type-path";
import { getTypescriptModule } from "../ts-module";
import { VisitFnArgs as VisitorArgs, Visitor, walkRecursive } from "../visitor";
import { toSimpleType, ToSimpleTypeOptions } from "./to-simple-type";

const NO_SOURCE_LOCATION_FOUND = {
	source: null,
	sourceContent: null,
	line: null,
	column: null
};

const ALREADY_ANNOTATED_WITH_ADVICE = new WeakSet<Error>();

type Chunks = Array<string | SourceNode> | SourceNode | string;

export class SimpleTypeCompiler {
	constructor(public readonly checker: ts.TypeChecker, getTarget: (compiler: SimpleTypeCompiler) => SimpleTypeCompilerTarget) {
		this.target = getTarget(this);
	}
	private target: SimpleTypeCompilerTarget;
	private currentOutputLocation?: SimpleTypeCompilerNamespaceLocation;

	private uniqueNames = new Map<string, number>();

	private compileCache = new WeakMap<SimpleType, SimpleTypeCompilerNode>();
	private typeToDeclarationLocation = new WeakMap<SimpleType, SimpleTypeCompilerDeclarationLocation>();
	private toSimpleTypeOptions: ToSimpleTypeOptions = {
		addMethods: true,
		cache: new WeakMap()
	};

	compile(
		entryPoints: Array<{
			type: SimpleType | ts.Type;
			location: {
				fileName: string;
				namespace?: string[];
			};
		}>
	) {
		const outputBuilder = new SimpleTypeCompilerOutputBuilder();
		const assignedToFile = new Set<SourceNode>();
		const outputFileNames = new Set<string>();
		const assignNodeToFile = (node: SourceNode, currentFile: SimpleTypeCompilerOutputFileBuilder, top?: boolean) => {
			outputFileNames.add(currentFile.fileName);

			if (assignedToFile.has(node)) {
				return;
			}
			assignedToFile.add(node);

			if (node instanceof SimpleTypeCompilerReferenceNode) {
				currentFile.addReference(node.refersTo);
			}

			if (node instanceof SimpleTypeCompilerDeclarationReferenceNode) {
				const declarationFile = outputBuilder.getFileBuilder(node.refersToDeclaration.location.fileName);
				assignNodeToFile(node.refersToDeclaration, declarationFile);
			}

			if (node instanceof SimpleTypeCompilerDeclarationNode) {
				currentFile = outputBuilder.getFileBuilder(node.location.fileName);
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
		for (const entry of entryPoints) {
			const type = this.toSimpleType(entry.type);
			const node = this.compileType(type, undefined, entry.location);
			const currentFile = outputBuilder.getFileBuilder(entry.location.fileName);
			assignNodeToFile(node, currentFile, true);
		}

		const files = Array.from(outputFileNames).map(fileName => {
			const fileBuilder = outputBuilder.getFileBuilder(fileName);
			const file = fileBuilder.getContents();
			const fileNode = this.target.compileFile(file);
			const fileWithSourceMap = fileNode.toStringWithSourceMap({ file: fileName });
			return {
				file,
				ast: fileNode,
				...fileWithSourceMap
			};
		});

		return files;
	}

	compileType(
		type: SimpleType | ts.Type,
		path: SimpleTypePath = SimpleTypePath.empty(),
		outputLocation?: {
			fileName: string;
			namespace?: string[];
		}
	): SimpleTypeCompilerNode {
		const prevOutputLocation = this.currentOutputLocation;
		const simpleType = this.toSimpleType(type);
		try {
			this.currentOutputLocation = outputLocation;
			const result = walkRecursive<SimpleTypeCompilerNode>(path, simpleType, args => {
				if (this.compileCache.has(args.type)) {
					return this.compileCache.get(args.type)!;
				} else if (SimpleTypePath.includes(args.path, args.type)) {
					// Circular compilation: try to use a reference if possible.
					if (this.typeToDeclarationLocation.has(args.type)) {
						if (!this.currentOutputLocation) {
							throw new Error(`Circular compilation: cannot create reference because current location is not set.`);
						}
						return this.compileReference({
							from: this.currentOutputLocation,
							to: { location: this.typeToDeclarationLocation.get(args.type)! }
						});
					}
				}
				return this.compileTypeAndCacheResult(args, this.currentOutputLocation);
			});
			return result;
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
		} finally {
			this.currentOutputLocation = prevOutputLocation;
		}
	}

	compileReference(referenceArgs: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode {
		const prevOutputLocation = this.currentOutputLocation;
		try {
			this.currentOutputLocation = referenceArgs.from;
			return this.target.compileReference(referenceArgs);
		} finally {
			this.currentOutputLocation = prevOutputLocation;
		}
	}

	private compileTypeAndCacheResult(args: VisitorArgs<SimpleTypeCompilerNode>, outputLocation: SimpleTypeCompilerNamespaceLocation | undefined): SimpleTypeCompilerNode {
		const prevOutputLocation = this.currentOutputLocation;
		try {
			this.currentOutputLocation = outputLocation;
			const result = this.target.compileType(args);
			if (result.cacheable) {
				this.compileCache.set(args.type, result);
			}
			return result;
		} finally {
			this.currentOutputLocation = prevOutputLocation;
		}
	}

	toSimpleType(type: SimpleType | ts.Type): SimpleType {
		return toSimpleType(type, this.checker, this.toSimpleTypeOptions);
	}

	assignDeclarationLocation(type: SimpleType, location?: SimpleTypeCompilerNamespaceLocation): SimpleTypeCompilerDeclarationLocation {
		const existingLocationForType = this.typeToDeclarationLocation.get(type);
		if (existingLocationForType) {
			return existingLocationForType;
		}

		const containingLocation = location ??
			this.currentOutputLocation ?? {
				fileName: ""
			};

		const name = type.name || "Anonymous";
		const uniquePrefix = outputLocationToKey(containingLocation) + `:${name}`;
		let count = 0;
		if (this.uniqueNames.has(uniquePrefix)) {
			count = this.uniqueNames.get(uniquePrefix)! + 1;
			this.uniqueNames.set(uniquePrefix, count);
		}
		const uniqueLocation: SimpleTypeCompilerDeclarationLocation = {
			...containingLocation,
			name,
			toString() {
				return this.name;
			}
		};
		this.typeToDeclarationLocation.set(type, uniqueLocation);
		return uniqueLocation;
	}

	nodeBuilder(type: SimpleType, path: SimpleTypePath, location?: SimpleTypeCompilerNamespaceLocation) {
		const fromLocation = location ?? this.currentOutputLocation;
		return new SimpleTypeCompilerNodeBuilder(type, path, fromLocation, this);
	}

	anonymousNodeBuilder(location?: SimpleTypeCompilerNamespaceLocation): SimpleTypeCompilerNodeBuilder {
		const fromLocation = location ?? this.currentOutputLocation;
		return new SimpleTypeCompilerNodeBuilder(undefined, undefined, fromLocation, this);
	}
}

function outputLocationToKey(location: Partial<SimpleTypeCompilerDeclarationLocation>) {
	return `file-${location.fileName}:namespace-${location.namespace?.join("/")}:name-${location.name}`;
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

	const decl = symbol.getDeclarations();
	if (!decl || decl.length === 0) {
		return NO_SOURCE_LOCATION_FOUND;
	}

	const node = decl[0];
	const sourceFile = node.getSourceFile();
	const ts = getTypescriptModule();
	const loc = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
	return {
		column: loc.character,
		line: loc.line,
		source: sourceFile.fileName,
		sourceContent: sourceFile.text
	};
}

export class SimpleTypeCompilerNodeBuilder {
	constructor(
		private type: SimpleType | undefined,
		private path: SimpleTypePath | undefined,
		private fromLocation: SimpleTypeCompilerNamespaceLocation | undefined,
		private compiler: SimpleTypeCompiler
	) {
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

	node(template: TemplateStringsArray, ...chunks: Chunks[]): SimpleTypeCompilerNode;
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

	isDeclaration(node: SimpleTypeCompilerNode): node is SimpleTypeCompilerDeclarationNode {
		return node instanceof SimpleTypeCompilerDeclarationNode;
	}

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
		const location = getSourceLocationOfSimpleType(type);
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

export interface SimpleTypeCompilerDeclarationLocation extends SimpleTypeCompilerNamespaceLocation {
	name: string;
	toString?: () => string;
}

export interface SimpleTypeCompilerNamespaceLocation {
	fileName: string;
	namespace?: string[];
}

export const SimpleTypeCompilerNamespaceLocation = {
	fileNameEqual(a: SimpleTypeCompilerNamespaceLocation, b: SimpleTypeCompilerNamespaceLocation): boolean {
		return a.fileName === b.fileName;
	},

	namespaceEqual(a: SimpleTypeCompilerNamespaceLocation, b: SimpleTypeCompilerNamespaceLocation): boolean {
		if (a.namespace === b.namespace) {
			return true;
		}

		if (!a.namespace || !b.namespace) {
			return false;
		}

		return a.namespace.length === b.namespace.length && a.namespace.every((name, i) => name === b.namespace?.[i]);
	},

	equal(a: SimpleTypeCompilerNamespaceLocation, b: SimpleTypeCompilerNamespaceLocation): boolean {
		return SimpleTypeCompilerNamespaceLocation.fileNameEqual(a, b) && SimpleTypeCompilerNamespaceLocation.namespaceEqual(a, b);
	}
};

class SimpleTypeCompilerOutputBuilder {
	private files = new Map<string, SimpleTypeCompilerOutputFileBuilder>();

	getFileBuilder(fileName: string): SimpleTypeCompilerOutputFileBuilder {
		let file = this.files.get(fileName);
		if (!file) {
			file = new SimpleTypeCompilerOutputFileBuilder(fileName);
			this.files.set(fileName, file);
		}
		return file;
	}
}

class SimpleTypeCompilerOutputFileBuilder {
	constructor(public fileName: string) {}

	private _references = new Map<string, SimpleTypeCompilerDeclarationLocation>();
	private _nodes = new Set<SimpleTypeCompilerNode>();

	addReference(location: SimpleTypeCompilerDeclarationLocation) {
		this._references.set(outputLocationToKey(location), location);
	}

	addNode(node: SimpleTypeCompilerNode) {
		this._nodes.add(node);
	}

	getContents(): SimpleTypeCompilerOutputFile {
		const references = Array.from(this._references.values());
		const nodes = Array.from(this._nodes);
		return { fileName: this.fileName, references, nodes };
	}
}

interface SimpleTypeCompilerOutputFile {
	fileName: string;
	references: SimpleTypeCompilerDeclarationLocation[];
	nodes: SimpleTypeCompilerNode[];
}

export class SimpleTypeCompilerDeclarationNode extends SimpleTypeCompilerNode {
	location!: SimpleTypeCompilerDeclarationLocation;
}

export class SimpleTypeCompilerReferenceNode extends SimpleTypeCompilerNode {
	refersTo!: SimpleTypeCompilerDeclarationLocation;
	cacheable = false;
}

export class SimpleTypeCompilerDeclarationReferenceNode extends SimpleTypeCompilerReferenceNode {
	refersToDeclaration!: SimpleTypeCompilerDeclarationNode;
}

export interface SimpleTypeCompilerReferenceArgs {
	from: SimpleTypeCompilerNamespaceLocation;
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
	 * Called by the type compiler if you build a reference node.
	 *
	 * @see {@link SimpleTypeCompiler#nodeBuilder.reference}
	 */
	compileReference(args: SimpleTypeCompilerReferenceArgs): SimpleTypeCompilerNode;

	/**
	 * Compile a file that contains one or more declarations.
	 */
	compileFile: (file: SimpleTypeCompilerOutputFile) => SimpleTypeCompilerNode;
}

class SimpleTypeCompilerPlaceholderNode extends SimpleTypeCompilerDeclarationNode {
	cacheable = false;
}

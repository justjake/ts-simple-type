/**
 * API to convert SimpleType to strings, and emit those strings in one or more
 * files.
 */

import { SourceMapGenerator, SourceNode } from "source-map";
import type * as ts from "typescript";
import { SimpleType } from "../simple-type";
import { SimpleTypePath, SimpleTypePathStep } from "../simple-type-path";
import { getTypescriptModule } from "../ts-module";
import { Cyclical, Visitor, walkRecursive } from "../visitor";
import { toSimpleType, ToSimpleTypeOptions } from "./to-simple-type";

const NO_SOURCE_LOCATION_FOUND = {
	source: null,
	line: null,
	column: null
};

type Chunks = Array<string | SourceNode> | SourceNode | string;

export class SimpleTypeCompiler {
	constructor(public readonly checker: ts.TypeChecker) {}

	private sourceTextCache = new Map<string, string>();
	private compileCache = new WeakMap<SimpleType, SimpleTypeCompilerNode>();
	private toSimpleTypeOptions: ToSimpleTypeOptions = {
		addMethods: true,
		cache: new WeakMap<ts.Type, SimpleType>()
	};
	private names = new Map<string, number>();

	compileType(type: SimpleType | ts.Type, visitor: Visitor<SimpleTypeCompilerNode>, path: SimpleTypePath = SimpleTypePath.empty()): SimpleTypeCompilerNode {
		const simpleType = this.toSimpleType(type);
		const result = walkRecursive<SimpleTypeCompilerNode>(path, simpleType, args => {
			if (this.compileCache.has(args.type)) {
				return this.compileCache.get(args.type)!;
			}

			const result = visitor(args);
			if (result.cacheable) {
				this.compileCache.set(args.type, result);
			}
			return result;
		});
		if (Cyclical.is(result)) {
			throw new Error(`TODO: figure out cyclical types`);
		}
		return result;
	}

	toSimpleType(type: SimpleType | ts.Type): SimpleType {
		return toSimpleType(type, this.checker, this.toSimpleTypeOptions);
	}

	getUniqueName(type: SimpleType): string {
		const name = type.name || "Anonymous";
		if (!this.names.has(name)) {
			this.names.set(name, 0);
			return name;
		}

		const count = this.names.get(name)! + 1;
		this.names.set(name, count);
		return `${name}${count}`;
	}

	newNode(type: SimpleType, path: SimpleTypePath, chunks: Chunks): SimpleTypeCompilerNode {
		const location = this.locate(type);
		const node = new SimpleTypeCompilerNode(location.line, location.column, location.source, chunks);
		node.type = type;
		node.path = path;
		node.step = SimpleTypePath.last(path);
		return node;
	}

	nodeBuilder(type: SimpleType, path: SimpleTypePath) {
		return {
			node: (chunks: Chunks) => this.newNode(type, path, chunks)
		};
	}

	locate(type: SimpleType): { source: string | null; line: number | null; column: number | null } {
		const ts = type.getTypescript?.();
		if (!ts) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const symbol = ts.symbol || ts.type.aliasSymbol || ts.type.getSymbol();
		if (!symbol) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const decl = symbol.getDeclarations();
		if (!decl || decl.length === 0) {
			return NO_SOURCE_LOCATION_FOUND;
		}

		const node = decl[0];
		const sourceFile = node.getSourceFile();
		this.sourceTextCache.set(sourceFile.fileName, sourceFile.text);
		const ts2 = getTypescriptModule();
		const loc = ts2.getLineAndCharacterOfPosition(sourceFile, node.getStart());
		return {
			column: loc.character,
			line: loc.line,
			source: sourceFile.fileName
		};
	}

	setSourceContent(mapGenerator: SourceMapGenerator) {
		for (const [fileName, text] of this.sourceTextCache) {
			mapGenerator.setSourceContent(fileName, text);
		}
	}
}

export class SimpleTypeCompilerNode extends SourceNode {
	type!: SimpleType;
	path!: SimpleTypePath;
	step!: SimpleTypePathStep | undefined;
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

/**
 * API to convert SimpleType to strings, and emit those strings in one or more
 * files.
 */

import ts = require("typescript");
import { SimpleType } from "../simple-type";

interface Emitted<T> {
	name: string;
	namespace?: string[];
	fileName: string;

	/** Data stored / supplied by the compiler pass */
	extra: T;

	/** Raw string to export */
	getText(): string;
}

interface Reference<T> {
	id: number;
}

interface CompilerAPI<T> {
	compile(simpleType: SimpleType, path: SimpleTypePath | SimpleTypePath[number] | undefined): Emitted<T>;
	emit(emitted: Emitted<T>): Emitted<T>;
}

/** User implements this */
interface CompilerPass {}

function newTypeCompiler(checker: ts.TypeChecker): CompilerAPI {
	// TODO
}

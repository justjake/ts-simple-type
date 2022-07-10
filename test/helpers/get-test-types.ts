import * as ts from "typescript";
import { ITestFile, programWithVirtualFiles } from "./analyze-text";

export function getTestTypes<TypeNames extends string>(
	typeNames: TypeNames[],
	source: string
): {
	types: Record<TypeNames, ts.Type>;
	program: ts.Program;
	typeChecker: ts.TypeChecker;
} {
	const testFile: ITestFile = {
		fileName: "test.ts",
		text: source
	};
	const program = programWithVirtualFiles(testFile, {
		options: {
			strict: true
		}
	});
	const [sourceFile] = program
		.getSourceFiles()
		.filter(f => f.fileName.includes(testFile.fileName));
	const typeChecker = program.getTypeChecker();
	const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile)!;
	const result = {
		types: {} as Record<TypeNames, ts.Type>,
		program,
		typeChecker
	};

	for (const name of typeNames) {
		const symbol = assert(moduleSymbol.exports?.get(name as ts.__String), `${name} symbol`);
		const type = typeChecker.getDeclaredTypeOfSymbol(symbol);
		result.types[name] = type;
	}
	return result;
}

function assert<T>(val: T | undefined, msg: string): T {
	if (val == null) {
		throw new Error(`Expected value to be defined: ${msg}`);
	}
	return val;
}

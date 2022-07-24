import test from "ava";
import { getModuleExport, getTypeOfTypeSymbol, getTypeOfValueSymbol } from "../src/utils/ts-util";
import { programWithVirtualFiles } from "./helpers/analyze-text";
import * as ts from "typescript";

test("getTypeOfTypeSymbol", t => {
	const program = programWithVirtualFiles(
		{
			fileName: "test.ts",
			text: "export type Test = string;"
		},
		{
			includeLib: true,
			options: {
				strict: true
			}
		}
	);

	const checker = program.getTypeChecker();
	const [sourceFile] = program.getSourceFiles().filter(f => f.fileName.includes("test.ts"));
	const typeSymbol = getModuleExport(sourceFile, "Test", checker);
	const type = typeSymbol && getTypeOfTypeSymbol(typeSymbol, checker);
	if (!type) {
		t.not(type, undefined);
		throw "";
	}
	t.truthy(type.flags & ts.TypeFlags.String);
});

test("getTypeOfValueSymbol", t => {
	const program = programWithVirtualFiles(
		{
			fileName: "test.ts",
			text: `export const Test: string = "hello";`
		},
		{
			includeLib: true,
			options: {
				strict: true
			}
		}
	);

	const checker = program.getTypeChecker();
	const [sourceFile] = program.getSourceFiles().filter(f => f.fileName.includes("test.ts"));
	const typeSymbol = getModuleExport(sourceFile, "Test", checker);
	const type = typeSymbol && getTypeOfValueSymbol(typeSymbol, checker);
	if (!type) {
		t.not(type, undefined);
		throw "";
	}
	t.truthy(type.flags & ts.TypeFlags.String);
});

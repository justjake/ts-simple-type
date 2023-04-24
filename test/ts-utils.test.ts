import { test, expect } from "@jest/globals"
import * as ts from "typescript"

import { getModuleExport, getDeclaredTypeOfSymbol, getTypeOfSymbol } from "../src/utils/ts-util"

import { programWithVirtualFiles } from "./helpers/analyze-text"

test("getTypeOfTypeSymbol", () => {
	const program = programWithVirtualFiles(
		{
			fileName: "test.ts",
			text: "export type Test = string;",
		},
		{
			includeLib: true,
			options: {
				strict: true,
			},
		}
	)

	const checker = program.getTypeChecker()
	const [sourceFile] = program.getSourceFiles().filter(f => f.fileName.includes("test.ts"))
	const typeSymbol = getModuleExport(sourceFile, "Test", checker)
	const type = typeSymbol && getDeclaredTypeOfSymbol(typeSymbol, checker)
	if (!type) {
		expect(type).not.toBe(undefined)
		throw ""
	}
	expect(type.flags & ts.TypeFlags.String).toBeTruthy()
})

test("getTypeOfValueSymbol", () => {
	const program = programWithVirtualFiles(
		{
			fileName: "test.ts",
			text: `export const Test: string = "hello";`,
		},
		{
			includeLib: true,
			options: {
				strict: true,
			},
		}
	)

	const checker = program.getTypeChecker()
	const [sourceFile] = program.getSourceFiles().filter(f => f.fileName.includes("test.ts"))
	const typeSymbol = getModuleExport(sourceFile, "Test", checker)
	const type = typeSymbol && getTypeOfSymbol(typeSymbol, checker)
	if (!type) {
		expect(type).not.toBe(undefined)
		throw ""
	}
	expect(type.flags & ts.TypeFlags.String).toBeTruthy()
})

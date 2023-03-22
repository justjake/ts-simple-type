# @jitl/ts-simple-type

`ts-simple-type` provides a simple, type-safe API for analyzing types, constructing new types, and generating code based on types.

- Convert `ts.Type` to `SimpleType`, a clear and understandable union, with `toSimpleType(type, checker)`.
- Check type assignability with `isAssignableToType(baseType, variant)`.
- Compile your `SimpleType`s to any text-based format, with source maps that point to your Typescript sources, with `SimpleTypeCompiler`.

## Why use this?

Typescript's API for analyzing types is verbose and confusing. There's no public APIs for checking assignability or building types.
See issue [#9879](https://github.com/Microsoft/TypeScript/issues/9879) and [#29432](https://github.com/Microsoft/TypeScript/issues/29432) on the Typescript github repository.
Typescript also famously avoids emitting any code based on type level information.

There are many libraries that claim to convert your Typescript types to other formats, such as [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator), [ts-to-zod](https://github.com/fabien0102/ts-to-zod), or [typeconv](https://github.com/grantila/typeconv/)/[core-types-ts](https://github.com/grantila/core-types-ts). These libraries work by *interpreting the Typescript AST*, essentially re-implementing a bare-bones type system from scratch. Most do not support advanced Typescript features like generic application, mapped types, or string literal types. `@jitl/ts-simple-type` avoids these limitations by using Typescript's first-party `ts.TypeChecker` API to analyze types. This library is focused on the *semantic meaning* of your types, not on how they are *syntactically declared*.

Our `isAssignableToType` function has more than 35000 tests comparing results to actual Typescript diagnostics (see [test-types.ts](https://github.com/justjake/ts-simple-type/blob/main/test/helpers/test-assignment.ts).

## Installation

```bash
npm install @jitl/ts-simple-type
```

## Usage

### Setting up the Typescript compiler API

To use ts-simple-type, we first need to use the Typescript compiler API to build
a "program" to parse our code and compute types. We'll pass a list of the files we care about to the program, and then retrieve its TypeChecker.

Then, we'll retrieve types using the program's TypeChecker, so we can analyze those types with `@jitl/ts-simple-type`.

For more information, see [Typescript's Compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

```typescript
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { unstableTsUtils } from '@jitl/ts-simple-type';

function getCompilerOptions() {
  const tsconfigPath = path.resolve('./tsconfig.json');
  const rawConfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  const parsedConfig = ts.parseJsonConfigFileContent(
    rawConfig,
    ts.sys,
    path.resolve('.'),
    undefined,
    tsconfigPath
  );
  return parsedConfig.options;
}

const entrypoint = path.resolve('./src/types.ts');
const program = ts.createProgram(
  [entrypoint],
  getCompilerOptions()
);

const typeChecker = program.getTypeChecker();
const sourceFile = program.getSourceFile(entrypoint);
const exportedTypeSymbol = unstableTsUtils.getModuleExport(sourceFile, 'TypeA', typeChecker);
const exportedValueSymbol = unstableTsUtils.getModuleExport(sourceFile, 'CONSTANT_B', typeChecker);
const typeA = unstableTsUtils.getTypeOfTypeSymbol(exportedTypeSymbol, typeChecker);
const typeB = unstableTsUtils.getTypeOfValueSymbol(exportedValueSymbol, typeChecker);
```

### Assignability

The API is very simple. For example if you want to check if Typescript type typeB is assignable to typeA, you can use the following function.

```typescript
import { isAssignableToType } from "@jitl/ts-simple-type";

const isAssignable = isAssignableToType(typeA, typeB, typeChecker);
```

### SimpleType

To make it easier to work with typescript types this library works by (behind the curtain) converting them to the interface `SimpleType`. Most functions in this library work with both `SimpleType` and the known and loved Typescript-provided `ts.Type` interface. This means that you can easily create a complex type yourself and compare it to a native Typescript type. It also means that you can use this library to serialize types and even compare them in the browser.

The `SimpleType` interface can be used to construct your own types for typechecking.

```typescript
import { SimpleType, typeToString, isAssignableToType, isAssignableToValue } from "@jitl/ts-simple-type";

const colors: SimpleType = {
  kind: "UNION",
  types: [
    { kind: "STRING_LITERAL", value: "RED" },
    { kind: "STRING_LITERAL", value: "GREEN" },
    { kind: "STRING_LITERAL", value: "BLUE" }
  ]
};

typeToString(colors)
> `"RED" | "GREEN" | "BLUE"`

isAssignableToType(colors, { kind: "STRING_LITERAL", value: "YELLOW" })
> false

isAssignableToValue(colors, "BLUE")
> true

isAssignableToValue(colors, "PINK")
> false
```

### SimpleTypeCompiler

Use `SimpleTypeCompiler` to compile your `SimpleType`s to a target textual format. You can find a full-length example of compiling Typescript types to Python 3 in [compiler.spec](https://github.com/justjake/ts-simple-type/blob/main/test/compiler.spec.ts).

```typescript
import { SimpleTypeCompiler, Visitor } from "@jitl/ts-simple-type";

const typescriptToC = new SimpleTypeCompiler(typeChecker, compiler => ({
  // Called by the compiler to compile a SimpleType (`type`) to an AST node.
  compileType({ type, path, visit }) {
    const builder = compiler.nodeBuilder(type, path);
    switch (type.kind) {
      // Usually types translate directly to the target language,
      // so your compileType function can return a normal AST node.
      case "BOOLEAN":
        return builder.node`bool_t`;
      case "STRING":
        return builder.node`char*`;
      case "BIG_INT":
        return builder.node`int64_t`;
      case "NUMBER":
        return builder.node`double`;
      // In some cases, we need to map a type to a declaration in the target language.
      // For this example, we'll map all object-like types to a `typedef struct {}` declaration.
      case "INTERFACE":
      case "CLASS":
      case "OBJECT": {
        // Declarations are assigned locations in a compiler output file.
        const declarationLocation = compiler.assignDeclarationLocation(type);
        const fields = Visitor[type.kind].mapNamedMembers<SimpleTypeCompilerNode>({
          path,
          type,
          visit: visit.with(({ type, path }) => {
            const builder = compiler.nodeBuilder(type, path);
            // `path` is a list of steps from a root type to the current type.
            // In this example, we're mapping over the member types in a object-like Typescript type.
            const step = SimpleTypePath.last(path) as SimpleTypePathStepNamedMember;
            const member = step.member;
            // Often, declarations aren't syntactically valid in arbitrary locations.
            // Instead we refer to declarations by name, and sometimes need an import.
            // The `builder.reference` function will compiler a *reference* to the target declaration
            // using your `compileReference` callback.
            // If the target is not a declaration, it's returned as-is.
            const memberType = builder.reference(compiler.compileType(type, path));
            return builder.node`  ${memberType} ${member.name};`;
          })
        });
        const newlineSeparatedFields = builder.node(fields).join("\n");
        return builder.declaration(
          declarationLocation,
          builder.node`typedef struct {\n${newlineSeparatedFields}\n} ${declarationLocation.name};`
        );
      }
      default:
        throw new Error(`Unsupported type: ${type.kind}`);
    }
  },
  // Called by the compiler to compile a reference to a declaration.
  // Declaration locations can have a fileName, namespace, and name,
  // although not all languages need to use these.
  compileReference({ to }) {
    const builder = compiler.anonymousNodeBuilder();
    const isPointerType = builder.isDeclaration(to) && to.type?.kind === "INTERFACE";
    return builder.node`${to.location.name}${isPointerType ? "*" : ""}`;
  },
  // Called by the compiler after compiling all types to AST nodes.
  // This function is called once per output file to compile any references
  // that file has to other files, and combine together the declarations in the file.
  compileFile(file) {
    const builder = compiler.anonymousNodeBuilder();
    const includes = Array.from(new Set(file.references.map(ref => ref.fileName)))
      .filter(fileName => fileName !== file.fileName);
    return builder.node([
      ...includes.map(include => builder.node`#include "${include}"`),
      ...file.nodes
    ]).join("\n\n");
  }
}));

// Run the compiler to produce outputs files.
// It's up to you to write these to disk, post-process them, etc.
const { files } = typescriptToC.compileProgram([
  {
    inputType: typeA,
    outputLocation: {
      fileName: "c/types.h"
    }
  }
]);

for (const [fileName, outputFile] of files) {
  fs.writeFileSync(fileName, outputFile.text, 'utf8');
  console.log('source map for ', fileName, ':', outputFile.sourceMap.toString());
}
```

### More examples

```typescript
const typeA = checker.getTypeAtLocation(nodeA);
const typeB = checker.getTypeAtLocation(nodeB);

/*
  For this example, let's say:
  - typeA is number
  - typeB is string[]
*/

// typeToString
typeToString(typeA)
> "number"

typeToString(typeB)
> "string[]"


// isAssignableToType
isAssignableToType(typeA, typeB, checker)
> false

isAssignableToType(typeA, { kind: "NUMBER" }, checker)
> true

isAssignableToType(typeB, { kind: "ARRAY", type: {kind: "STRING"}}, checker)
> true

isAssignableToType(
  { kind: "STRING" },
  { kind: "STRING_LITERAL", value: "hello"})
> true


// isAssignableToPrimitiveType
isAssignableToPrimitiveType(typeA, checker)
> true

isAssignableToPrimitiveType(typeB, checker)
> false

isAssignableToPrimitiveType({ kind: "ARRAY", type: {kind: "STRING"} })
> false


// isAssignableToSimpleTypeKind
isAssignableToSimpleTypeKind(typeA, "NUMBER", checker)
> true

isAssignableToSimpleTypeKind(typeB, "BOOLEAN", checker)
> false

isAssignableToSimpleTypeKind(typeB, ["STRING", "UNDEFINED"], checker)
> true


// isAssignableToValue
isAssignableToValue(typeA, 123, checker)
> true

isAssignableToValue(typeA, "hello", checker)
> false

isAssignableToValue(typeB, true, checker)
> false


// toSimpleType
toSimpleType(typeA, {checker})
> { kind: "NUMBER" }

toSimpleType(typeB, {checker})
> { kind: "ARRAY", type: { kind: "NUMBER" } }

```

## API Documentation

For functions that take either a native Typescript `Type` or a `SimpleType` the `TypeChecker` is only required if a Typescript `Type` has been given to the function.

### isAssignableToType
> isAssignableToType(typeA: Type | SimpleType, typeB: Type | SimpleType, checker?: TypeChecker): boolean

Returns true if `typeB` is assignable to `typeA`.

### isAssignableToPrimitiveType
> isAssignableToPrimitiveType(type: Type | SimpleType, checker?: TypeChecker): boolean

Returns true if `type` is assignable to a primitive type like `string`, `number`, `boolean`, `bigint`, `null` or `undefined`.

### isAssignableToSimpleTypeKind
> isAssignableToSimpleTypeKind(type: Type | SimpleType, kind: SimpleTypeKind | SimpleTypeKind[], checker?: TypeChecker, options?: Options): boolean

Returns true if `type` is assignable to a `SimpleTypeKind`.
- `options.matchAny` (boolean): Can be used to allow the "any" type to match everything.

### isAssignableToValue
> isAssignableToValue(type: SimpleType | Type, value: any, checker?: TypeChecker): boolean

Returns true if the type of the value is assignable to `type`.

### typeToString
> typeToString(type: SimpleType): string

Returns a string representation of the simple type. The string representation matches the one that Typescript generates.

### toSimpleType
> toSimpleType(type: Type | Node, checker: TypeChecker): SimpleType

Returns a `SimpleType` that represents a native Typescript `Type`.


## Project History

This library forked from [github.com/runem/ts-simple-type](https://github.com/runem/ts-simple-type) in July 2022.

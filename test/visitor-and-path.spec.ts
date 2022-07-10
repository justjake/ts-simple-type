import test from "ava";
import { SimpleTypePath } from "../src/simple-type-path";
import { toSimpleType } from "../src/transform/to-simple-type";
import { mapOneJsonStep, visitDepthFirst } from "../src/visitor";
import { getTestTypes } from "./helpers/get-test-types";

const EXAMPLE_TYPES = `
interface GenericInterface<ParamWithConstraint extends Obj1, ParamWithDefault = Obj2> {
  constrained: ParamWithConstraint
  defaulted: ParamWithDefault
}

type Obj1 = {
  table: "block" | "collection" | "activity"
  method: (param: Obj2) => Obj2
}

type Obj2 = {
  object2: true
}

 export interface Haystack {
    hello: {
      world: string
    } & {
      today: [1, 2, 3]
    }
    frog: GenericInterface<{ table: "block" }, { value: string }>
 } 
`;

test("visitDepthFirst", ctx => {
	const { types, typeChecker } = getTestTypes(["Haystack"], EXAMPLE_TYPES);
	const simpleType = toSimpleType(types.Haystack, typeChecker, {
		addMethods: true,
		cache: new WeakMap()
	});

	const visitBeforeOrder: string[] = [];
	const visitAfterOrder: string[] = [];

	visitDepthFirst([], simpleType, {
		before(args) {
			visitBeforeOrder.push(SimpleTypePath.toString(args.path, args.type));
		},
		after(args) {
			visitAfterOrder.push(SimpleTypePath.toString(args.path, args.type));
		}
	});

	ctx.deepEqual(visitBeforeOrder, [
		"T: Haystack",
		"Haystack.hello: { world: string; } & { today: [1, 2, 3]; }",
		"Haystack.hello~&0~>: { world: string; }",
		"Haystack.hello~&0~>.world: string",
		"Haystack.hello~&1~>: { today: [1, 2, 3]; }",
		"Haystack.hello~&1~>.today: [1, 2, 3]",
		"Haystack.hello~&1~>.today[0]: 1",
		"Haystack.hello~&1~>.today[1]: 2",
		"Haystack.hello~&1~>.today[2]: 3",
		'Haystack.frog: GenericInterface<{ table: "block"; }, { value: string; }>',
		"Haystack.frog: GenericInterface",
		'Haystack.frog.constrained: { table: "block"; }',
		'Haystack.frog.constrained.table: "block"',
		"Haystack.frog.defaulted: { value: string; }",
		"Haystack.frog.defaulted.value: string",
		"Haystack.frog~instantiatedFrom~>: GenericInterface",
		"Haystack.frog~instantiatedFrom~>.constrained: ParamWithConstraint",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>: Obj1",
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table: "block" | "collection" | "activity"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|0~>: "block"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|1~>: "collection"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|2~>: "activity"',
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>~(param)~>: Obj2",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>~(param)~>.object2: true",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>.(): Obj2",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>.().object2: true",
		"Haystack.frog~instantiatedFrom~>.defaulted: ParamWithDefault",
		"Haystack.frog~instantiatedFrom~>.defaulted~defaultType~>: Obj2",
		"Haystack.frog~instantiatedFrom~>.defaulted~defaultType~>.object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>: ParamWithConstraint",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>: Obj1",
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table: "block" | "collection" | "activity"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|0~>: "block"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|1~>: "collection"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|2~>: "activity"',
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>~(param)~>: Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>~(param)~>.object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>.(): Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>.().object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>: ParamWithDefault",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>~defaultType~>: Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>~defaultType~>.object2: true",
		'Haystack.frog<<0>>: { table: "block"; }',
		'Haystack.frog<<0>>.table: "block"',
		"Haystack.frog<<1>>: { value: string; }",
		"Haystack.frog<<1>>.value: string"
	]);
	ctx.deepEqual(visitAfterOrder, [
		"Haystack.hello~&0~>.world: string",
		"Haystack.hello~&0~>: { world: string; }",
		"Haystack.hello~&1~>.today[0]: 1",
		"Haystack.hello~&1~>.today[1]: 2",
		"Haystack.hello~&1~>.today[2]: 3",
		"Haystack.hello~&1~>.today: [1, 2, 3]",
		"Haystack.hello~&1~>: { today: [1, 2, 3]; }",
		"Haystack.hello: { world: string; } & { today: [1, 2, 3]; }",
		'Haystack.frog.constrained.table: "block"',
		'Haystack.frog.constrained: { table: "block"; }',
		"Haystack.frog.defaulted.value: string",
		"Haystack.frog.defaulted: { value: string; }",
		"Haystack.frog: GenericInterface",
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|0~>: "block"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|1~>: "collection"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table~|2~>: "activity"',
		'Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.table: "block" | "collection" | "activity"',
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>~(param)~>.object2: true",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>~(param)~>: Obj2",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>.().object2: true",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>.(): Obj2",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method~asFunction~>: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>.method: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~>.constrained~constraintType~>: Obj1",
		"Haystack.frog~instantiatedFrom~>.constrained: ParamWithConstraint",
		"Haystack.frog~instantiatedFrom~>.defaulted~defaultType~>.object2: true",
		"Haystack.frog~instantiatedFrom~>.defaulted~defaultType~>: Obj2",
		"Haystack.frog~instantiatedFrom~>.defaulted: ParamWithDefault",
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|0~>: "block"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|1~>: "collection"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table~|2~>: "activity"',
		'Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.table: "block" | "collection" | "activity"',
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>~(param)~>.object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>~(param)~>: Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>.().object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>.(): Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method~asFunction~>: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>.method: (param: { object2: true; }) => { object2: true; }",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>~constraintType~>: Obj1",
		"Haystack.frog~instantiatedFrom~><ParamWithConstraint>: ParamWithConstraint",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>~defaultType~>.object2: true",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>~defaultType~>: Obj2",
		"Haystack.frog~instantiatedFrom~><ParamWithDefault>: ParamWithDefault",
		"Haystack.frog~instantiatedFrom~>: GenericInterface",
		'Haystack.frog<<0>>.table: "block"',
		'Haystack.frog<<0>>: { table: "block"; }',
		"Haystack.frog<<1>>.value: string",
		"Haystack.frog<<1>>: { value: string; }",
		'Haystack.frog: GenericInterface<{ table: "block"; }, { value: string; }>',
		"T: Haystack"
	]);
});

test("visitDepthFirst: makes errors nice", ctx => {
	const { types, typeChecker } = getTestTypes(["Haystack"], EXAMPLE_TYPES);
	const simpleType = toSimpleType(types.Haystack, typeChecker, {
		addMethods: true,
		cache: new WeakMap()
	});

	ctx.throws(
		() => {
			visitDepthFirst([], simpleType, {
				before: ({ path }) => {
					if (path.length > 5) throw new Error("oops");
				},
				after: undefined
			});
		},
		{
			message: /Path:.*$/
		}
	);
});

test("visitDepthFirst: JSON traversal", ctx => {
	const { types, typeChecker } = getTestTypes(["Haystack"], EXAMPLE_TYPES);
	const simpleType = toSimpleType(types.Haystack, typeChecker, {
		addMethods: true,
		cache: new WeakMap()
	});

	const visitBeforeOrder: string[] = [];

	visitDepthFirst([], simpleType, {
		before(args) {
			visitBeforeOrder.push(SimpleTypePath.toString(args.path, args.type));
		},
		after: undefined,
		traverse: mapOneJsonStep
	});

	ctx.deepEqual(visitBeforeOrder, [
		"T: Haystack",
		"Haystack.hello: { world: string; } & { today: [1, 2, 3]; }",
		"Haystack.hello~&0~>: { world: string; }",
		"Haystack.hello~&0~>.world: string",
		"Haystack.hello~&1~>: { today: [1, 2, 3]; }",
		"Haystack.hello~&1~>.today: [1, 2, 3]",
		"Haystack.hello~&1~>.today[0]: 1",
		"Haystack.hello~&1~>.today[1]: 2",
		"Haystack.hello~&1~>.today[2]: 3",
		'Haystack.frog: GenericInterface<{ table: "block"; }, { value: string; }>',
		"Haystack.frog: GenericInterface",
		'Haystack.frog.constrained: { table: "block"; }',
		'Haystack.frog.constrained.table: "block"',
		"Haystack.frog.defaulted: { value: string; }",
		"Haystack.frog.defaulted.value: string"
	]);
});

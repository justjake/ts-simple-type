import test from "ava";
import { SimpleTypePath } from "../src/simple-type-path";
import { toSimpleType } from "../src/transform/to-simple-type";
import { Visitor, walkDepthFirst } from "../src/visitor";
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

	walkDepthFirst([], simpleType, {
		before(args) {
			visitBeforeOrder.push(SimpleTypePath.toString(args.path, args.type));
		},
		after(args) {
			visitAfterOrder.push(SimpleTypePath.toString(args.path, args.type));
		}
	});

	ctx.snapshot(visitBeforeOrder, "pre-order");
	ctx.snapshot(visitAfterOrder, "post-order");
});

test("visitDepthFirst: makes errors nice", ctx => {
	const { types, typeChecker } = getTestTypes(["Haystack"], EXAMPLE_TYPES);
	const simpleType = toSimpleType(types.Haystack, typeChecker, {
		addMethods: true,
		cache: new WeakMap()
	});

	ctx.throws(
		() => {
			walkDepthFirst([], simpleType, {
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

test("mapJsonStep", ctx => {
	const { types, typeChecker } = getTestTypes(["Haystack"], EXAMPLE_TYPES);
	const simpleType = toSimpleType(types.Haystack, typeChecker, {
		addMethods: true,
		cache: new WeakMap()
	});

	const visitBeforeOrder: string[] = [];

	walkDepthFirst([], simpleType, {
		before(args) {
			visitBeforeOrder.push(SimpleTypePath.toString(args.path, args.type));
		},
		after: undefined,
		traverse: Visitor.mapJsonStep
	});

	ctx.snapshot(visitBeforeOrder);
});

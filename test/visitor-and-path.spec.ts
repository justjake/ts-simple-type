import test from "ava";
import { SimpleTypePath } from "../src/simple-type-path";
import { toSimpleType } from "../src/transform/to-simple-type";
import { VisitFnArgs, Visitor, walkDepthFirst } from "../src/visitor";
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

	const toStrings = (args: VisitFnArgs<void>) =>
		`
toString:     ${SimpleTypePath.toString(args.path, args.type)}
toTypescript: ${SimpleTypePath.toTypescript(args.path)}
`.trim();

	const visitBeforeOrder: string[] = [];
	const visitAfterOrder: string[] = [];

	walkDepthFirst([], simpleType, {
		before(args) {
			visitBeforeOrder.push(toStrings(args));
		},
		after(args) {
			visitBeforeOrder.push(toStrings(args));
		}
	});

	ctx.snapshot("\n" + visitBeforeOrder.join("\n\n"), "pre-order");
	ctx.snapshot("\n" + visitAfterOrder.join("\n\n"), "post-order");
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

import { isSimpleTypePrimitive, SimpleType, SimpleTypeFunctionParameter } from "../simple-type"

/**
 * Converts a simple type to a string.
 * @param type Simple Type
 */
export function simpleTypeToString(type: SimpleType): string {
	// if (type.getTypescript) {
	// 	const ts = type.getTypescript();
	// 	return ts.checker.typeToString(ts.type);
	// }

	return simpleTypeToStringInternal(type, new Set())
}

function simpleTypeToStringInternal(type: SimpleType, visitTypeSet: Set<SimpleType>): string {
	if (!isSimpleTypePrimitive(type)) {
		if (visitTypeSet.has(type)) {
			return ""
		}
		visitTypeSet = new Set([...visitTypeSet, type])
	}

	switch (type.kind) {
		case "BOOLEAN_LITERAL":
			return String(type.value)
		case "NUMBER_LITERAL":
			return String(type.value)
		case "STRING_LITERAL":
			return `"${type.value}"`
		case "BIG_INT_LITERAL":
			return `${type.value}n`
		case "ES_SYMBOL":
			return `Symbol()`
		case "ES_SYMBOL_UNIQUE":
			return `Symbol(${type.name})`
		case "STRING":
			return "string"
		case "BOOLEAN":
			return "boolean"
		case "NUMBER":
			return "number"
		case "BIG_INT":
			return "bigint"
		case "UNDEFINED":
			return "undefined"
		case "NULL":
			return "null"
		case "ANY":
			return "any"
		case "UNKNOWN":
			return "unknown"
		case "VOID":
			return "void"
		case "NEVER":
			return "never"
		case "FUNCTION":
		case "METHOD": {
			if (type.kind === "FUNCTION" && type.name !== undefined) {
				return type.name
			}
			const argText = functionArgTypesToString(type.parameters || [], visitTypeSet)
			return `${type.typeParameters !== undefined ? `<${type.typeParameters.map(tp => tp.name).join(",")}>` : ""}(${argText})${
				type.returnType !== undefined ? ` => ${simpleTypeToStringInternal(type.returnType, visitTypeSet)}` : ""
			}`
		}
		case "ARRAY": {
			const hasMultipleTypes = ["UNION", "INTERSECTION"].includes(type.type.kind)
			let memberType = simpleTypeToStringInternal(type.type, visitTypeSet)
			if (type.name !== undefined && ["ArrayLike", "ReadonlyArray"].includes(type.name)) {
				return `${type.name}<${memberType}>`
			}
			if (hasMultipleTypes && type.type.name === undefined) {
				memberType = `(${memberType})`
			}
			return `${memberType}[]`
		}
		case "UNION": {
			if (type.name !== undefined) {
				return type.name
			}
			return truncateAndJoinList(
				type.types.map(t => simpleTypeToStringInternal(t, visitTypeSet)),
				" | ",
				{ maxContentLength: 200 }
			)
		}
		case "ENUM":
			return type.name
		case "ENUM_MEMBER":
			return type.fullName
		case "INTERSECTION":
			if (type.name !== undefined) {
				return type.name
			}
			return truncateAndJoinList(
				type.types.map(t => simpleTypeToStringInternal(t, visitTypeSet)),
				" & ",
				{ maxContentLength: 200 }
			)
		case "INTERFACE":
			if (type.name !== undefined) {
				return type.name
			}
		// this fallthrough is intentional
		case "OBJECT": {
			if (type.members === undefined || type.members.length === 0) {
				if (type.call === undefined && type.ctor === undefined) {
					return "{}"
				}

				if (type.call !== undefined && type.ctor === undefined) {
					return simpleTypeToStringInternal(type.call, visitTypeSet)
				}
			}

			const entries: string[] = (type.members || []).map(member => {
				// this check needs to change in the future
				if (member.type.kind === "FUNCTION" || member.type.kind === "METHOD") {
					const result = simpleTypeToStringInternal(member.type, visitTypeSet)
					return `${member.name}${result.replace(" => ", ": ")}`
				}

				return `${member.name}: ${simpleTypeToStringInternal(member.type, visitTypeSet)}`
			})

			if (type.ctor !== undefined) {
				entries.push(`new${simpleTypeToStringInternal(type.ctor, visitTypeSet)}`)
			}

			if (type.call !== undefined) {
				entries.push(simpleTypeToStringInternal(type.call, visitTypeSet))
			}

			return `{ ${entries.join("; ")}${entries.length > 0 ? ";" : ""} }`
		}
		case "TUPLE":
			return `[${type.members.map(member => `${simpleTypeToStringInternal(member.type, visitTypeSet)}${member.optional ? "?" : ""}`).join(", ")}]`
		case "GENERIC_ARGUMENTS": {
			const { target, typeArguments } = type
			return typeArguments.length === 0 ? target.name || "" : `${target.name}<${typeArguments.map(t => simpleTypeToStringInternal(t, visitTypeSet)).join(", ")}>`
		}
		case "PROMISE":
			return `${type.name || "Promise"}<${simpleTypeToStringInternal(type.type, visitTypeSet)}>`
		case "DATE":
			return "Date"
		default:
			return type.name || ""
	}
}

function truncateAndJoinList(items: string[], combine: string, { maxLength, maxContentLength }: { maxLength?: number; maxContentLength?: number }): string {
	const text = items.join(combine)

	// Truncate if too long
	let slice = 0
	if (maxContentLength !== undefined && text.length > maxContentLength) {
		let curLength = 0
		for (const item of items) {
			curLength += item.length
			slice++

			if (curLength > maxContentLength) {
				break
			}
		}
	} else if (maxLength !== undefined && items.length > maxLength) {
		slice = maxLength
	}

	if (slice !== 0) {
		return [...items.slice(0, slice), `... ${items.length - slice} more ...`].join(combine)
	}

	return text
}

function functionArgTypesToString(argTypes: SimpleTypeFunctionParameter[], visitTypeSet: Set<SimpleType>): string {
	return argTypes
		.map(arg => {
			return `${arg.rest ? "..." : ""}${arg.name}${arg.optional ? "?" : ""}: ${simpleTypeToStringInternal(arg.type, visitTypeSet)}`
		})
		.join(", ")
}

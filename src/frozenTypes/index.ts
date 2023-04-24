import type { SimpleTypeInterface } from "../simple-type"
import { deserializeSimpleType } from "../transform/serialize-simple-type"

let stringInterface: SimpleTypeInterface | undefined
let numberInterface: SimpleTypeInterface | undefined
let symbolInterface: SimpleTypeInterface | undefined
let bigintInterface: SimpleTypeInterface | undefined

export function getStringInterfaceSimpleType(): SimpleTypeInterface {
	if (stringInterface) {
		return stringInterface
	}

	const json = require("./string.type.json")
	return (stringInterface = deserializeSimpleType(json) as SimpleTypeInterface)
}

export function getNumberInterfaceSimpleType(): SimpleTypeInterface {
	if (numberInterface) {
		return numberInterface
	}

	const json = require("./number.type.json")
	return (numberInterface = deserializeSimpleType(json) as SimpleTypeInterface)
}

export function getSymbolInterfaceSimpleType(): SimpleTypeInterface {
	if (symbolInterface) {
		return symbolInterface
	}

	const json = require("./symbol.type.json")
	return (symbolInterface = deserializeSimpleType(json) as SimpleTypeInterface)
}

export function getBigintInterfaceSimpleType(): SimpleTypeInterface {
	if (bigintInterface) {
		return bigintInterface
	}

	const json = require("./bigint.type.json")
	return (bigintInterface = deserializeSimpleType(json) as SimpleTypeInterface)
}

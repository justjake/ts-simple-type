import { runTypeCombinationsShard } from "./type-combinations"

const index = Number(__filename.split("/").pop()?.split(".")[1])

runTypeCombinationsShard({ index })

type System = import("typescript").System
type CompilerOptions = import("typescript").CompilerOptions
type CustomTransformers = import("typescript").CustomTransformers
type LanguageServiceHost = import("typescript").LanguageServiceHost
type CompilerHost = import("typescript").CompilerHost
type SourceFile = import("typescript").SourceFile
type TS = typeof import("typescript")

/**
 * typedef: https://github.com/justjake/TypeScript/blob/55e13e9115b3cc5458d76c39da1211dc28d7b51f/src/compiler/utilities.ts#L6605-L6609
 * implementation: https://github.com/justjake/TypeScript/blob/55e13e9115b3cc5458d76c39da1211dc28d7b51f/src/compiler/sys.ts#L1755-L1804
 * */
interface FileSystemEntries {
	readonly files: readonly string[]
	readonly directories: readonly string[]
}

/** https://github.com/justjake/TypeScript/blob/55e13e9115b3cc5458d76c39da1211dc28d7b51f/src/compiler/utilities.ts#L6639-L6641 */
type MatchFilesFn = (
	path: string,
	extensions: readonly string[] | undefined,
	excludes: readonly string[] | undefined,
	includes: readonly string[] | undefined,
	useCaseSensitiveFileNames: boolean,
	currentDirectory: string,
	depth: number | undefined,
	getFileSystemEntries: (path: string) => FileSystemEntries,
	realpath: (path: string) => string
) => string[]

let hasLocalStorage = false
try {
	hasLocalStorage = typeof localStorage !== `undefined`
} catch (error) {}

const hasProcess = typeof process !== `undefined`
// eslint-disable-next-line no-restricted-properties
const shouldDebug = (hasLocalStorage && localStorage.getItem("DEBUG")) || (hasProcess && process.env.DEBUG)
// eslint-disable-next-line no-console
const debugLog = shouldDebug ? console.log : (_message?: any, ..._optionalParams: any[]) => ""

export interface VirtualTypeScriptEnvironment {
	sys: System
	languageService: import("typescript").LanguageService
	getSourceFile: (fileName: string) => import("typescript").SourceFile | undefined
	createFile: (fileName: string, content: string) => void
	updateFile: (fileName: string, content: string, replaceTextSpan?: import("typescript").TextSpan) => void
}

/**
 * Grab the list of lib files for a particular target, will return a bit more than necessary (by including
 * the dom) but that's OK
 *
 * @param target The compiler settings target baseline
 * @param ts A copy of the TypeScript module
 */
export const knownLibFilesForCompilerOptions = (compilerOptions: CompilerOptions, ts: TS) => {
	const target = compilerOptions.target || ts.ScriptTarget.ES5
	const lib = compilerOptions.lib || []

	const files = [
		"lib.d.ts",
		"lib.dom.d.ts",
		"lib.dom.iterable.d.ts",
		"lib.webworker.d.ts",
		"lib.webworker.importscripts.d.ts",
		"lib.scripthost.d.ts",
		"lib.es5.d.ts",
		"lib.es6.d.ts",
		"lib.es2015.collection.d.ts",
		"lib.es2015.core.d.ts",
		"lib.es2015.d.ts",
		"lib.es2015.generator.d.ts",
		"lib.es2015.iterable.d.ts",
		"lib.es2015.promise.d.ts",
		"lib.es2015.proxy.d.ts",
		"lib.es2015.reflect.d.ts",
		"lib.es2015.symbol.d.ts",
		"lib.es2015.symbol.wellknown.d.ts",
		"lib.es2016.array.include.d.ts",
		"lib.es2016.d.ts",
		"lib.es2016.full.d.ts",
		"lib.es2017.d.ts",
		"lib.es2017.full.d.ts",
		"lib.es2017.intl.d.ts",
		"lib.es2017.object.d.ts",
		"lib.es2017.sharedmemory.d.ts",
		"lib.es2017.string.d.ts",
		"lib.es2017.typedarrays.d.ts",
		"lib.es2018.asyncgenerator.d.ts",
		"lib.es2018.asynciterable.d.ts",
		"lib.es2018.d.ts",
		"lib.es2018.full.d.ts",
		"lib.es2018.intl.d.ts",
		"lib.es2018.promise.d.ts",
		"lib.es2018.regexp.d.ts",
		"lib.es2019.array.d.ts",
		"lib.es2019.d.ts",
		"lib.es2019.full.d.ts",
		"lib.es2019.object.d.ts",
		"lib.es2019.string.d.ts",
		"lib.es2019.symbol.d.ts",
		"lib.es2020.d.ts",
		"lib.es2020.full.d.ts",
		"lib.es2020.string.d.ts",
		"lib.es2020.symbol.wellknown.d.ts",
		"lib.es2020.bigint.d.ts",
		"lib.es2020.promise.d.ts",
		"lib.es2020.sharedmemory.d.ts",
		"lib.es2020.intl.d.ts",
		"lib.es2021.d.ts",
		"lib.es2021.full.d.ts",
		"lib.es2021.promise.d.ts",
		"lib.es2021.string.d.ts",
		"lib.es2021.weakref.d.ts",
		"lib.esnext.d.ts",
		"lib.esnext.full.d.ts",
		"lib.esnext.intl.d.ts",
		"lib.esnext.promise.d.ts",
		"lib.esnext.string.d.ts",
		"lib.esnext.weakref.d.ts",
	]

	const targetToCut = ts.ScriptTarget[target]
	const matches = files.filter(f => f.startsWith(`lib.${targetToCut.toLowerCase()}`))
	const targetCutIndex = files.indexOf(matches.pop()!)

	const getMax = (array: number[]) => (array && array.length ? array.reduce((max, current) => (current > max ? current : max)) : undefined)

	// Find the index for everything in
	const indexesForCutting = lib.map(lib => {
		const matches = files.filter(f => f.startsWith(`lib.${lib.toLowerCase()}`))
		if (matches.length === 0) {
			return 0
		}

		const cutIndex = files.indexOf(matches.pop()!)
		return cutIndex
	})

	const libCutIndex = getMax(indexesForCutting) || 0

	const finalCutIndex = Math.max(targetCutIndex, libCutIndex)
	return files.slice(0, finalCutIndex + 1)
}

function notImplemented(methodName: string): any {
	throw new Error(`Method '${methodName}' is not implemented.`)
}

function audit<ArgsT extends any[], ReturnT>(name: string, fn: (...args: ArgsT) => ReturnT): (...args: ArgsT) => ReturnT {
	return (...args) => {
		const res = fn(...args)

		const smallres = typeof res === "string" ? `${res.slice(0, 80)}...` : res
		debugLog(`> ${name}`, ...args)
		debugLog(`< ${smallres}`)

		return res
	}
}

/** The default compiler options if TypeScript could ever change the compiler options */
const defaultCompilerOptions = (ts: typeof import("typescript")): CompilerOptions => {
	return {
		...ts.getDefaultCompilerOptions(),
		jsx: ts.JsxEmit.React,
		strict: true,
		esModuleInterop: true,
		module: ts.ModuleKind.ESNext,
		suppressOutputPathCheck: true,
		skipLibCheck: true,
		skipDefaultLibCheck: true,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
	}
}

// "/DOM.d.ts" => "/lib.dom.d.ts"
const libize = (path: string) => path.replace("/", "/lib.").toLowerCase()

/**
 * Creates an in-memory System object which can be used in a TypeScript program, this
 * is what provides read/write aspects of the virtual fs
 */
export function createSystem(files: Map<string, string>): System {
	return {
		args: [],
		createDirectory: () => notImplemented("createDirectory"),
		// TODO: could make a real file tree
		directoryExists: audit("directoryExists", directory => {
			return Array.from(files.keys()).some(path => path.startsWith(directory))
		}),
		exit: () => notImplemented("exit"),
		fileExists: audit("fileExists", fileName => files.has(fileName) || files.has(libize(fileName))),
		getCurrentDirectory: () => "/",
		getDirectories: () => [],
		getExecutingFilePath: () => notImplemented("getExecutingFilePath"),
		readDirectory: audit("readDirectory", directory => (directory === "/" ? Array.from(files.keys()) : [])),
		readFile: audit("readFile", fileName => files.get(fileName) || files.get(libize(fileName))),
		resolvePath: path => path,
		newLine: "\n",
		useCaseSensitiveFileNames: true,
		write: () => notImplemented("write"),
		writeFile: (fileName, contents) => {
			files.set(fileName, contents)
		},
	}
}

/**
 * Creates a file-system backed System object which can be used in a TypeScript program, you provide
 * a set of virtual files which are prioritised over the FS versions, then a path to the root of your
 * project (basically the folder your node_modules lives)
 */
export function createFSBackedSystem(files: Map<string, string>, _projectRoot: string, ts: TS, tsLibDirectory?: string): System {
	const root = `${_projectRoot}`
	const path = requirePath()

	// The default System in TypeScript
	const nodeSys = ts.sys
	const matchFiles: MatchFilesFn = (ts as any).matchFiles

	const getFileSystemEntries = (dir_: string): FileSystemEntries => {
		if (files.has(dir_)) {
			return {
				files: [dir_],
				directories: [],
			}
		}

		const withTrailingSlash = path.normalize(`${dir_}/`)
		const withoutTrailingSlash = withTrailingSlash.slice(0, -1)
		const filenames = Array.from(files.keys())
		const deepWithinDir = filenames.filter(f => f.startsWith(withTrailingSlash)).map(f => path.parse(f))

		const filesInDir = deepWithinDir.filter(f => f.dir === withoutTrailingSlash).map(f => f.base)
		const dirsInDir = Array.from(new Set(deepWithinDir.map(f => path.relative(withoutTrailingSlash, f.dir).split(path.sep)[0]).filter(Boolean)))
		return {
			files: filesInDir.sort(),
			directories: dirsInDir.sort(),
		}
	}

	return {
		// @ts-ignore
		name: "fs-vfs",
		root,
		args: [],
		createDirectory: () => notImplemented("createDirectory"),
		// TODO: could make a real file tree
		directoryExists: audit("directoryExists", directory => {
			return Array.from(files.keys()).some(path => path.startsWith(directory)) || nodeSys.directoryExists(directory)
		}),
		exit: nodeSys.exit,
		fileExists: audit("fileExists", fileName => {
			if (files.has(fileName)) {
				return true
			}
			return nodeSys.fileExists(fileName)
		}),
		getCurrentDirectory: () => root,
		getDirectories: nodeSys.getDirectories,
		getExecutingFilePath: () => notImplemented("getExecutingFilePath"),
		readDirectory: audit("readDirectory", (path, extensions, exclude, include, depth, ...rest) => {
			const fromMemory = matchFiles(path, extensions, exclude, include, true, root, depth, getFileSystemEntries, it => it)
			const fromDisk = nodeSys.readDirectory(path, extensions, exclude, include, depth, ...rest)
			return Array.from(new Set([...fromMemory, ...fromDisk]))
		}),
		readFile: audit("readFile", fileName => {
			if (files.has(fileName)) {
				return files.get(fileName)
			}
			return nodeSys.readFile(fileName)
		}),
		resolvePath: path => {
			if (files.has(path)) {
				return path
			}
			return nodeSys.resolvePath(path)
		},
		newLine: "\n",
		useCaseSensitiveFileNames: true,
		write: () => notImplemented("write"),
		writeFile: (fileName, contents) => {
			files.set(fileName, contents)
		},
	}
}

/**
 * Creates an in-memory CompilerHost -which is essentially an extra wrapper to System
 * which works with TypeScript objects - returns both a compiler host, and a way to add new SourceFile
 * instances to the in-memory file system.
 */
export function createVirtualCompilerHost(sys: System, compilerOptions: CompilerOptions, ts: TS) {
	const sourceFiles = new Map<string, SourceFile>()
	const save = (sourceFile: SourceFile) => {
		sourceFiles.set(sourceFile.fileName, sourceFile)
		return sourceFile
	}

	type Return = {
		compilerHost: CompilerHost
		updateFile: (sourceFile: SourceFile) => boolean
	}

	const isInMemoryFS = sys.getCurrentDirectory() === "/"
	const defaultCompilerHost = ts.createCompilerHost(compilerOptions, false)

	const vHost: Return = {
		compilerHost: {
			...sys,
			getCanonicalFileName: fileName => fileName,
			getDefaultLibFileName: isInMemoryFS ? opts => `/${ts.getDefaultLibFileName(compilerOptions)}` : defaultCompilerHost.getDefaultLibFileName,
			getDefaultLibLocation: isInMemoryFS ? undefined : defaultCompilerHost.getDefaultLibLocation,
			getDirectories: () => [],
			getNewLine: () => sys.newLine,
			getSourceFile: fileName => {
				return sourceFiles.get(fileName) || save(ts.createSourceFile(fileName, sys.readFile(fileName)!, compilerOptions.target || defaultCompilerOptions(ts).target!, false))
			},
			useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames,
		},
		updateFile: sourceFile => {
			const alreadyExists = sourceFiles.has(sourceFile.fileName)
			sys.writeFile(sourceFile.fileName, sourceFile.text)
			sourceFiles.set(sourceFile.fileName, sourceFile)
			return alreadyExists
		},
	}
	return vHost
}

/**
 * Creates an object which can host a language service against the virtual file-system
 */
export function createVirtualLanguageServiceHost(sys: System, rootFiles: string[], compilerOptions: CompilerOptions, ts: TS, customTransformers?: CustomTransformers) {
	const fileNames = [...rootFiles]
	const { compilerHost, updateFile } = createVirtualCompilerHost(sys, compilerOptions, ts)
	const fileVersions = new Map<string, string>()
	let projectVersion = 0
	const languageServiceHost: LanguageServiceHost = {
		...compilerHost,
		getProjectVersion: () => projectVersion.toString(),
		getCompilationSettings: () => compilerOptions,
		getCustomTransformers: () => customTransformers,
		// A couple weeks of 4.8 TypeScript nightlies had a bug where the Program's
		// list of files was just a reference to the array returned by this host method,
		// which means mutations by the host that ought to result in a new Program being
		// created were not detected, since the old list of files and the new list of files
		// were in fact a reference to the same underlying array. That was fixed in
		// https://github.com/microsoft/TypeScript/pull/49813, but since the twoslash runner
		// is used in bisecting for changes, it needs to guard against being busted in that
		// couple-week period, so we defensively make a slice here.
		getScriptFileNames: () => fileNames.slice(),
		getScriptSnapshot: fileName => {
			const contents = sys.readFile(fileName)
			if (contents) {
				return ts.ScriptSnapshot.fromString(contents)
			}
			return
		},
		getScriptVersion: fileName => {
			return fileVersions.get(fileName) || "0"
		},
		writeFile: sys.writeFile,
	}

	type Return = {
		languageServiceHost: LanguageServiceHost
		updateFile: (sourceFile: import("typescript").SourceFile) => void
	}

	const lsHost: Return = {
		languageServiceHost,
		updateFile: sourceFile => {
			projectVersion++
			fileVersions.set(sourceFile.fileName, projectVersion.toString())
			if (!fileNames.includes(sourceFile.fileName)) {
				fileNames.push(sourceFile.fileName)
			}
			updateFile(sourceFile)
		},
	}
	return lsHost
}

const requirePath = () => {
	return require(String.fromCharCode(112, 97, 116, 104)) as typeof import("path")
}

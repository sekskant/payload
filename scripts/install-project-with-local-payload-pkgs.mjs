import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const packageSections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  const [projectDirArg, packedPackagesDirArg] = process.argv.slice(2)

  if (!projectDirArg || !packedPackagesDirArg) {
    throw new Error(
      'Usage: node scripts/install-project-with-local-payload-pkgs.mjs <projectDir> <packedPackagesDir>',
    )
  }

  const projectDir = path.resolve(projectDirArg)
  const packedPackagesDir = path.resolve(packedPackagesDirArg)
  const packageJsonPath = path.join(projectDir, 'package.json')

  const [packageJsonRaw, packedFiles] = await Promise.all([
    fs.readFile(packageJsonPath, 'utf8'),
    fs.readdir(packedPackagesDir, { withFileTypes: true }),
  ])

  const packageJson = JSON.parse(packageJsonRaw)
  const tgzFiles = packedFiles
    .filter((file) => file.isFile() && file.name.endsWith('.tgz'))
    .map((file) => file.name)

  if (tgzFiles.length === 0) {
    throw new Error(`No .tgz files found in ${packedPackagesDir}`)
  }

  const packageVersion = getPayloadVersion(packageJson)
  const packagedPayloadDeps = buildPackagedPayloadDependencyMap({
    packageVersion,
    packedPackagesDir,
    tgzFiles,
  })

  let foundPayloadDep = false

  for (const section of packageSections) {
    const deps = packageJson[section]
    if (!deps || typeof deps !== 'object') {
      continue
    }

    for (const packageName of Object.keys(deps)) {
      if (!isPayloadPackage(packageName)) {
        continue
      }

      const localPackagePath = packagedPayloadDeps.get(packageName)
      if (!localPackagePath) {
        throw new Error(
          `Missing packed package for ${packageName}. Available: ${Array.from(
            packagedPayloadDeps.keys(),
          ).join(', ')}`,
        )
      }

      deps[packageName] = toFileSpecifier(path.relative(projectDir, localPackagePath))
      foundPayloadDep = true
    }
  }

  if (!foundPayloadDep) {
    throw new Error(`No Payload packages found in ${packageJsonPath}`)
  }

  const overrides = { ...(packageJson.pnpm?.overrides ?? {}) }

  for (const [packageName, localPackagePath] of packagedPayloadDeps.entries()) {
    overrides[packageName] = toFileSpecifier(path.relative(projectDir, localPackagePath))
  }

  packageJson.pnpm = { ...(packageJson.pnpm ?? {}), overrides }

  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')

  execFileSync('pnpm', ['install', '--no-frozen-lockfile', '--ignore-workspace'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true,
  })
}

function buildPackagedPayloadDependencyMap({ packageVersion, packedPackagesDir, tgzFiles }) {
  const suffix = `-${packageVersion}.tgz`
  const packagedDeps = new Map()

  for (const tgzFile of tgzFiles) {
    if (!tgzFile.endsWith(suffix)) {
      continue
    }

    const baseName = tgzFile.slice(0, -suffix.length)
    if (baseName === 'create-payload-app' || !isPayloadTarballBaseName(baseName)) {
      continue
    }

    packagedDeps.set(
      tarballBaseNameToPackageName(baseName),
      path.join(packedPackagesDir, tgzFile),
    )
  }

  return packagedDeps
}

function getPayloadVersion(packageJson) {
  for (const section of packageSections) {
    const deps = packageJson[section]
    const payloadVersion = deps?.payload

    if (typeof payloadVersion === 'string' && payloadVersion.length > 0) {
      return payloadVersion
    }
  }

  throw new Error('Unable to determine payload version from project package.json')
}

function isPayloadPackage(packageName) {
  return packageName === 'payload' || packageName.startsWith('@payloadcms/')
}

function isPayloadTarballBaseName(baseName) {
  return baseName === 'payload' || baseName.startsWith('payloadcms-')
}

function tarballBaseNameToPackageName(baseName) {
  if (baseName === 'payload') {
    return baseName
  }

  return `@payloadcms/${baseName.replace(/^payloadcms-/, '')}`
}

function toFileSpecifier(relativePath) {
  return `file:${relativePath.replace(/\\/g, '/')}`
}

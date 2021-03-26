import crypto from 'crypto'
import path from 'path'
import admin from 'firebase-admin'
import semver from 'semver'
import glob from 'glob'
import chalk from 'chalk'
import ms from 'ms'

const App = admin.initializeApp()
const DB = admin.firestore()
const Timestamp = admin.firestore.Timestamp
const MigrationCollection = DB.collection('_migrations')

export type MigrationFN = (db: FirebaseFirestore.Firestore, firestore: typeof admin.firestore) => Promise<void>
export type MigrationFile = {
  version: string
  name: string
  fn: MigrationFN
}

enum MigrationResultStatus {
  Successful = 'successful',
  Failed = 'failed',
}
type MigrationResult = {
  executed: FirebaseFirestore.Timestamp
  version: string
  status: MigrationResultStatus
}

export type Options = {
  directory: string
  delimiter: string
  ignoreRemote: boolean
  single?: string[]
  dryRun: boolean
}

const defaults: Options = {
  directory: './migrations',
  delimiter: '__',
  ignoreRemote: false,
  dryRun: false,
}

const extension = /\..*$/

function sortMigrationFiles(arr: MigrationFile[]): MigrationFile[] {
  return arr.sort((a, b) => (semver.gt(a.version, b.version) ? 1 : -1))
}

async function gather(options: Options): Promise<MigrationFile[]> {
  const files = glob
    .sync(path.join(options.directory, '*.js'))
    .filter((f) => f.includes(options.delimiter))
    .map((f) => path.resolve(f))

  const versions: string[] = []
  const contents = await Promise.all(
    files.map(async (f) => {
      const [rawVersion, name] = path.basename(f).split(options.delimiter)

      const version = semver.coerce(rawVersion)
      if (!version) throw new Error(`Invalid version: "${rawVersion}".`)
      if (versions.includes(version.version))
        throw new Error(`Cannot have multiple files for version: ${version.version}`)
      versions.push(version.version)
      const migration = await import(f)
      if (typeof migration.migration !== 'function') throw new Error(`No migrate function found in: ${f}`)
      return {
        version,
        name: name.replace(extension, ''),
        fn: migration.migration as MigrationFN,
      }
    })
  )

  const asMigrationFile = contents.map(({ version, ...rest }) => ({
    ...rest,
    version: version.version,
  }))
  return sortMigrationFiles(asMigrationFile)
}

function getIdFromMigration(migration: MigrationFile): string {
  return crypto.createHash('sha256').update(migration.version).digest('hex')
}

function printMigration(migration: MigrationFile, msg: string) {
  console.log(chalk.underline(`Migration ${chalk.bold(migration.version)}:`), msg)
}

async function runMigrations(migrations: MigrationFile[], options: Options) {
  for (const migration of migrations) {
    const id = getIdFromMigration(migration)
    const remoteDoc = await MigrationCollection.doc(id).get()
    const remote = remoteDoc.data() as MigrationResult | undefined
    if (!options.ignoreRemote && remote && remote.status === MigrationResultStatus.Successful) {
      printMigration(migration, '🔧 Already run.')
      continue
    }

    if (options.dryRun) {
      printMigration(migration, 'Skip due to dry-run.')
      return
    }

    const start = process.hrtime.bigint()
    let error = false
    try {
      await migration.fn(DB, admin.firestore)
    } catch (e) {
      error = true
      console.error(e)
      break
    } finally {
      const delta = (process.hrtime.bigint() - start) / BigInt(1000000)
      const time = ms(Number(delta))
      const message = error ? chalk.red(`❌ Error while running.`) : chalk.green(`✅ Success`)
      printMigration(migration, `${message}   ${chalk.gray(time)}`)

      const result: MigrationResult = {
        version: migration.version,
        executed: Timestamp.now(),
        status: error ? MigrationResultStatus.Failed : MigrationResultStatus.Successful,
      }
      await remoteDoc.ref.set(result)

      if (error) {
        throw new Error('⚠️ Skipping next migrations')
      }
    }
  }
}

export async function migrate(options?: Partial<Options>) {
  try {
    const merged: Options = Object.assign(defaults, options)
    let migrations = await gather(merged)
    console.log(`Found ${chalk.bold(migrations.length)} migrations.`)
    if (options?.single) {
      const singleVersions = options.single.map((v) => {
        const parsed = semver.coerce(v)
        if (!parsed) throw new Error(`Invalid version specified: "${v}". Could not parse.`)
        return parsed.version
      })
      const filtered = singleVersions.map((v) => {
        const selected = migrations.find((m) => m.version === v)
        if (!selected) throw new Error(`Version "${v}" specified in --only does not exist in as migration.`)
        return selected
      })
      migrations = sortMigrationFiles(filtered)
      console.log(`Only running specified versions: ${singleVersions.join(', ')}`)
    }
    await runMigrations(migrations, merged)
  } catch (e) {
    console.error(chalk.red(e.message))
    process.exit(1)
  }
}

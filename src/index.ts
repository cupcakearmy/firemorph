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
const MigrationCollection = DB.collection('migrations')

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
}

const defaults: Options = {
  directory: './migrations',
  delimiter: '__',
  ignoreRemote: false,
}

const extension = /\..*$/

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

  const sorted = contents.sort((a, b) => (semver.gt(a.version, b.version) ? 1 : -1))
  return sorted.map(({ version, ...rest }) => ({
    ...rest,
    version: version.version,
  }))
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
        console.log('⚠️ Skipping next migrations')
        break
      }
    }
  }
}

export async function migrate(options?: Partial<Options>) {
  const merged: Options = Object.assign(defaults, options)
  const migrations = await gather(merged)
  await runMigrations(migrations, merged)
}

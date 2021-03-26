#!/usr/bin/env node

import { Command } from 'commander'
import spec from '../package.json'
import { migrate } from './'

const program = new Command()
program.version(spec.version).name(spec.name)

program
  .command('migrate')
  .description('run migrations')
  .option('--dry-run', 'run simulation without committing changes')
  .option('-m, --migrations <glob>', 'migration files', './migrations/*.js')
  .option('--only <version...>', 'only run specific migration')
  .option('-f, --force', 'ignore remote state and rerun migrations')
  .action(async (args) => {
    await migrate({ directory: args.migrations, ignoreRemote: args.force, single: args.only, dryRun: args.dryRun })
  })

program.parse(process.argv)

#!/usr/bin/env node

import { Command } from 'commander'
import spec from '../package.json'
import { migrate } from './'

const program = new Command()
program.version(spec.version).name(spec.name)

program
  .command('migrate')
  .description('run migrations')
  // .option('--dry-run', 'run simulation without committing changes')
  .option('-m, --migrations <glob>', 'migration files', './migrations/*.js')
  .option('--force', 'ignore remote state and rerun migrations')
  .action(async (args) => {
    await migrate({ directory: args.migrations, ignoreRemote: args.force })
  })

program.parse(process.argv)

#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { deploy } from "./command/deploy/index.ts"
import { run } from "./command/run/index.ts"

const cli = Command.make("fireclanker").pipe(
  Command.withSubcommands([deploy, run])
)

cli.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)

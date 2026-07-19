#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { hello } from "./commands/hello.ts"

const cli = Command.make("fireclanker").pipe(
  Command.withSubcommands([hello])
)

cli.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)

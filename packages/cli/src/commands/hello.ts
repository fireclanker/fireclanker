import { Console } from "effect"
import { Command } from "effect/unstable/cli"

export const hello = Command.make("hello", {}, () =>
  Console.log("Hello from Fireclanker!")
)

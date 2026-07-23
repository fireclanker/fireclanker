import * as Clank from "alchemy/Util/Clank"
import { Effect, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import {
  AwsRegion,
  ConfigValue,
  DeploymentName,
  writeConfig
} from "../../config.ts"

const valid = <S extends Schema.Top>(schema: S, message: string) => (value: string) =>
  Schema.is(schema)(value) ? undefined : message

export const initialize = (
  text: typeof Clank.text = Clank.text,
  success: typeof Clank.success = Clank.success
) => Effect.gen(function*() {
  const name = yield* text({
    message: "Deployment name",
    placeholder: "fireclanker",
    validate: valid(DeploymentName, "Use 3-255 letters, numbers, dots, hyphens, or underscores")
  })
  const region = yield* text({
    message: "AWS region",
    placeholder: "us-east-1",
    validate: valid(AwsRegion, "Enter a valid AWS region, such as us-east-1")
  })
  const awsProfile = yield* text({
    message: "AWS profile from ~/.aws/config",
    placeholder: "default",
    validate: valid(ConfigValue, "Enter an AWS profile name")
  })
  const configPath = yield* writeConfig({ name, region, awsProfile })
  yield* success(`Wrote Fireclanker configuration to ${configPath}`)
})

export const init = Command.make(
  "init",
  {},
  Effect.fn(function*() {
    yield* initialize()
  })
).pipe(
  Command.withDescription("Configure Fireclanker")
)

import { Schema } from "effect"

export const MAX_PUBLICATION_FILES = 250
export const MAX_PUBLICATION_BYTES = 3 * 1024 * 1024

export const GitObjectId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}$/, {
    message: "Git object IDs must be 40 lowercase hexadecimal characters"
  })
)
export type GitObjectId = typeof GitObjectId.Type

export const PublicationOptionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
)
export type PublicationOptionId = typeof PublicationOptionId.Type

export class CreatePullRequestOption extends Schema.Class<CreatePullRequestOption>(
  "CreatePullRequestOption"
)({
  id: PublicationOptionId,
  kind: Schema.Literal("create-pull-request"),
  baseBranch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  expectedHeadSha: GitObjectId
}) {}

export class UpdatePullRequestOption extends Schema.Class<UpdatePullRequestOption>(
  "UpdatePullRequestOption"
)({
  id: PublicationOptionId,
  kind: Schema.Literal("update-pull-request"),
  pullRequestNumber: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  branch: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  expectedHeadSha: GitObjectId
}) {}

export const PublicationOption = Schema.Union([
  CreatePullRequestOption,
  UpdatePullRequestOption
])
export type PublicationOption = typeof PublicationOption.Type

export class PublicationTargetSelection extends Schema.Class<PublicationTargetSelection>(
  "PublicationTargetSelection"
)({
  optionId: PublicationOptionId,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
}) {}

export class DoNotPublishDecision extends Schema.Class<DoNotPublishDecision>(
  "DoNotPublishDecision"
)({
  kind: Schema.Literal("do-not-publish"),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
}) {}

export class PublishDecision extends Schema.Class<PublishDecision>(
  "PublishDecision"
)({
  kind: Schema.Literal("publish"),
  optionId: PublicationOptionId,
  commitMessage: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  pullRequestTitle: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  ),
  pullRequestBody: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536)))
}) {}

export const PublicationDecision = Schema.Union([
  DoNotPublishDecision,
  PublishDecision
])
export type PublicationDecision = typeof PublicationDecision.Type

export class UpsertFileChange extends Schema.Class<UpsertFileChange>(
  "UpsertFileChange"
)({
  kind: Schema.Literal("upsert"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  mode: Schema.Literals(["100644", "100755", "120000"]),
  contentBase64: Schema.String
}) {}

export class DeleteFileChange extends Schema.Class<DeleteFileChange>(
  "DeleteFileChange"
)({
  kind: Schema.Literal("delete"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
}) {}

export const FileChange = Schema.Union([UpsertFileChange, DeleteFileChange])
export type FileChange = typeof FileChange.Type

export const ChangeSet = Schema.Array(FileChange)
export type ChangeSet = typeof ChangeSet.Type

export class AgentCompletion extends Schema.Class<AgentCompletion>(
  "AgentCompletion"
)({
  response: Schema.String.check(Schema.isMinLength(1)),
  publication: PublicationDecision
}) {}

export class PublicationResult extends Schema.Class<PublicationResult>(
  "PublicationResult"
)({
  commitSha: GitObjectId,
  branch: Schema.String,
  pullRequestNumber: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  url: Schema.String.check(Schema.isMinLength(1))
}) {}

import type { PublicationOption } from "./publication.model.ts"

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const offeredPublicationOptions = (
  prompt: string,
  options: ReadonlyArray<PublicationOption>,
  sourceBranch?: string
): ReadonlyArray<PublicationOption> => options.filter((option) => {
  if (option.kind === "create-pull-request") return true
  if (option.branch === sourceBranch) return true
  if (prompt.includes(option.branch)) return true
  const number = String(option.pullRequestNumber)
  return new RegExp(
    `(?:\\bPR\\s*#${escapeRegExp(number)}\\b|\\bpull request\\s*#${escapeRegExp(number)}\\b|/pull/${escapeRegExp(number)}(?:\\b|/))`,
    "i"
  ).test(prompt)
})

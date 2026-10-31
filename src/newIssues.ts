export type NewIssuesSource = {
  flag: `new-from-patch` | `new-from-rev`
  value: string
}

export class PatchFetchError extends Error {}

const NEW_FROM_FLAGS = [`new-from-patch`, `new-from-rev`, `new-from-merge-base`]

export function newIssuesArgs(source: NewIssuesSource): string[] {
  return [
    `--${source.flag}=${source.value}`,
    // Override config values.
    `--new=false`,
    ...NEW_FROM_FLAGS.filter((flag) => flag !== source.flag).map((flag) => `--${flag}=`),
  ]
}

type NewIssuesDeps = {
  fetchPatch: () => Promise<string>
  fetchBaseRev: () => Promise<string>
  warn: (message: string) => void
}

// Only pull requests can fall back to the base commit: for a push the checkout does not contain the "before" commit.
export async function resolveNewIssuesSource(eventName: string, deps: NewIssuesDeps): Promise<NewIssuesSource | undefined> {
  try {
    const patchPath = await deps.fetchPatch()

    return patchPath ? { flag: `new-from-patch`, value: patchPath } : undefined
  } catch (err) {
    if (!(err instanceof PatchFetchError) || !(eventName === `pull_request` || eventName === `pull_request_target`)) {
      throw err
    }

    deps.warn(`${err.message}: using a git diff against the pull request base commit instead`)

    return { flag: `new-from-rev`, value: await deps.fetchBaseRev() }
  }
}

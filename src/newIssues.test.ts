import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { newIssuesArgs, PatchFetchError, resolveNewIssuesSource } from "./newIssues.ts"

const BASE_SHA = `a`.repeat(40)

function makeDeps(fetchPatch: () => Promise<string>) {
  const calls = { baseRev: 0, warnings: [] as string[] }

  const deps = {
    fetchPatch,
    fetchBaseRev: async () => {
      calls.baseRev++
      return BASE_SHA
    },
    warn: (message: string) => calls.warnings.push(message),
  }

  return { deps, calls }
}

describe(`newIssuesArgs`, () => {
  it(`uses the patch and clears the other new-from flags`, () => {
    assert.deepEqual(newIssuesArgs({ flag: `new-from-patch`, value: `/tmp/pull.patch` }), [
      `--new-from-patch=/tmp/pull.patch`,
      `--new=false`,
      `--new-from-rev=`,
      `--new-from-merge-base=`,
    ])
  })

  it(`uses the rev and clears the other new-from flags`, () => {
    assert.deepEqual(newIssuesArgs({ flag: `new-from-rev`, value: BASE_SHA }), [
      `--new-from-rev=${BASE_SHA}`,
      `--new=false`,
      `--new-from-patch=`,
      `--new-from-merge-base=`,
    ])
  })
})

describe(`resolveNewIssuesSource`, () => {
  it(`uses the patch when it was fetched`, async () => {
    const { deps, calls } = makeDeps(async () => `/tmp/pull.patch`)

    assert.deepEqual(await resolveNewIssuesSource(`pull_request`, deps), { flag: `new-from-patch`, value: `/tmp/pull.patch` })
    assert.equal(calls.baseRev, 0)
  })

  for (const eventName of [`pull_request`, `pull_request_target`]) {
    it(`falls back to the base commit on ${eventName} and keeps the cause in the warning`, async () => {
      const cause = `Sorry, the diff exceeded the maximum number of files (300)`
      const { deps, calls } = makeDeps(async () => {
        throw new PatchFetchError(`failed to fetch pull request patch: ${cause}`)
      })

      assert.deepEqual(await resolveNewIssuesSource(eventName, deps), { flag: `new-from-rev`, value: BASE_SHA })
      assert.equal(calls.warnings.length, 1)
      assert.match(calls.warnings[0], /maximum number of files \(300\)/)
    })
  }

  it(`fails instead of linting everything when the base commit is not available`, async () => {
    const { deps } = makeDeps(async () => {
      throw new PatchFetchError(`failed to fetch pull request patch`)
    })
    deps.fetchBaseRev = async () => {
      throw new Error(`cannot show only new issues`)
    }

    await assert.rejects(resolveNewIssuesSource(`pull_request`, deps), /cannot show only new issues/)
  })

  it(`does not fall back for a push`, async () => {
    const { deps, calls } = makeDeps(async () => {
      throw new PatchFetchError(`failed to fetch push patch`)
    })

    await assert.rejects(resolveNewIssuesSource(`push`, deps), PatchFetchError)
    assert.equal(calls.baseRev, 0)
  })

  it(`does not fall back for errors that are not patch fetch errors`, async () => {
    const { deps, calls } = makeDeps(async () => {
      throw new Error(`no pull request in the event payload`)
    })

    await assert.rejects(resolveNewIssuesSource(`pull_request`, deps), /no pull request/)
    assert.equal(calls.baseRev, 0)
  })

  it(`has no source when there is no patch`, async () => {
    const { deps } = makeDeps(async () => ``)

    assert.equal(await resolveNewIssuesSource(`schedule`, deps), undefined)
  })
})

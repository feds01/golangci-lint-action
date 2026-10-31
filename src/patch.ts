import * as core from "@actions/core"
import * as github from "@actions/github"
import { Context } from "@actions/github/lib/context"
import * as pluginRetry from "@octokit/plugin-retry"
import fs from "fs"
import path from "path"
import { dir } from "tmp"
import { promisify } from "util"

import { fetchBaseRev } from "./baseRev"
import { NewIssuesSource, PatchFetchError, resolveNewIssuesSource } from "./newIssues"
import { alterDiffPatch } from "./utils/diffUtils"

const writeFile = promisify(fs.writeFile)
const createTempDir = promisify(dir)

export function isOnlyNewIssues(): boolean {
  return core.getBooleanInput(`only-new-issues`, { required: true })
}

const PULL_REQUEST_TARGET_FETCH_HINT = ` (with pull_request_target, origin may be the pull request head repository, which can lack the base commit)`

export async function fetchNewIssuesSource(): Promise<NewIssuesSource | undefined> {
  const ctx = github.context

  if (ctx.eventName === `merge_group`) {
    return { flag: `new-from-rev`, value: ctx.payload.merge_group.base_sha }
  }

  return resolveNewIssuesSource(ctx.eventName, {
    fetchPatch,
    fetchBaseRev: () =>
      fetchBaseRev(ctx.payload.pull_request?.base.sha, {
        fetchFailureHint: ctx.eventName === `pull_request_target` ? PULL_REQUEST_TARGET_FETCH_HINT : undefined,
      }),
    warn: core.warning,
  })
}

async function fetchPatch(): Promise<string> {
  const ctx = github.context

  switch (ctx.eventName) {
    case `pull_request`:
    case `pull_request_target`:
      return await fetchPullRequestPatch(ctx)
    case `push`:
      return await fetchPushPatch(ctx)
    default:
      core.info(`Not fetching patch for showing only new issues because it's not a pull request context: event name is ${ctx.eventName}`)
      return ``
  }
}

async function fetchPullRequestPatch(ctx: Context): Promise<string> {
  const pr = ctx.payload.pull_request
  if (!pr) {
    throw new Error(`cannot show only new issues: no pull request in the ${ctx.eventName} event payload`)
  }

  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }), {}, pluginRetry.retry)

  let patchResp
  try {
    patchResp = await octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      [`pull_number`]: pr.number,
      mediaType: {
        format: `diff`,
      },
    })
  } catch (err) {
    console.warn(`failed to fetch pull request patch:`, err)
    throw new PatchFetchError(`failed to fetch pull request patch: ${err.message}`)
  }

  if (patchResp.status !== 200) {
    throw new PatchFetchError(`failed to fetch pull request patch: response status is ${patchResp.status}`)
  }

  try {
    const patchPath = await createTempDir().then((tempDir) => path.join(tempDir, "pull.patch"))
    core.info(`Writing patch to ${patchPath}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writeFile(patchPath, alterDiffPatch(patchResp.data as any))
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    throw new PatchFetchError(`failed to save pull request patch: ${err.message}`)
  }
}

async function fetchPushPatch(ctx: Context): Promise<string> {
  const octokit = github.getOctokit(core.getInput(`github-token`, { required: true }), {}, pluginRetry.retry)

  let patch: string
  try {
    const patchResp = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      basehead: `${ctx.payload.before}...${ctx.payload.after}`,
      mediaType: {
        format: `diff`,
      },
    })

    if (patchResp.status !== 200) {
      core.warning(`failed to fetch push patch: response status is ${patchResp.status}`)
      return `` // don't fail the action, but analyze without patch
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch = patchResp.data as any
  } catch (err) {
    console.warn(`failed to fetch push patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }

  try {
    const patchPath = await createTempDir().then((tempDir) => path.join(tempDir, "push.patch"))
    core.info(`Writing patch to ${patchPath}`)
    await writeFile(patchPath, alterDiffPatch(patch))
    return patchPath
  } catch (err) {
    console.warn(`failed to save pull request patch:`, err)
    return `` // don't fail the action, but analyze without patch
  }
}

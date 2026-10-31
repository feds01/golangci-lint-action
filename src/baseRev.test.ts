import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import { fetchBaseRev } from "./baseRev.ts"

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_AUTHOR_NAME: `test`,
  GIT_AUTHOR_EMAIL: `test@example.com`,
  GIT_COMMITTER_NAME: `test`,
  GIT_COMMITTER_EMAIL: `test@example.com`,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(`git`, args, { cwd, env: GIT_ENV, encoding: `utf8` }).trim()
}

describe(`fetchBaseRev`, () => {
  let tmpDir: string
  let origin: string
  let baseSha: string
  let headSha: string

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `base-rev-`))
    origin = path.join(tmpDir, `origin`)

    fs.mkdirSync(origin)
    git(origin, `init`, `-q`)
    git(origin, `config`, `uploadpack.allowAnySHA1InWant`, `true`)
    git(origin, `commit`, `-q`, `--allow-empty`, `-m`, `base`)
    baseSha = git(origin, `rev-parse`, `HEAD`)
    git(origin, `commit`, `-q`, `--allow-empty`, `-m`, `pull request`)
    headSha = git(origin, `rev-parse`, `HEAD`)
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Same shape as the actions/checkout of a pull request: depth 1, only the checked out commit.
  function checkout(name: string, commit: string, remoteUrl = `file://${origin}`): string {
    const dir = path.join(tmpDir, name)

    fs.mkdirSync(dir)
    git(dir, `init`, `-q`)
    git(dir, `remote`, `add`, `origin`, remoteUrl)
    git(dir, `fetch`, `-q`, `--no-tags`, `--depth=1`, `origin`, commit)
    git(dir, `checkout`, `-q`, `--detach`, commit)

    return dir
  }

  function hasCommit(dir: string, commit: string): boolean {
    try {
      git(dir, `cat-file`, `-e`, `${commit}^{commit}`)
      return true
    } catch {
      return false
    }
  }

  it(`fetches the base commit missing from a shallow checkout`, async () => {
    const dir = checkout(`shallow`, headSha)
    assert.equal(hasCommit(dir, baseSha), false)

    assert.equal(await fetchBaseRev(baseSha, { cwd: dir }), baseSha)
    assert.equal(hasCommit(dir, baseSha), true)
    assert.equal(git(dir, `rev-parse`, `HEAD`), headSha)
  })

  it(`does not fetch when the base commit is already present`, async () => {
    const dir = checkout(`present`, headSha)
    git(dir, `fetch`, `-q`, `--no-tags`, `--depth=2`, `origin`, headSha)
    git(dir, `remote`, `set-url`, `origin`, path.join(tmpDir, `missing`))
    assert.equal(hasCommit(dir, baseSha), true)

    assert.equal(await fetchBaseRev(baseSha, { cwd: dir }), baseSha)
  })

  it(`fails when the base commit cannot be fetched`, async () => {
    const dir = checkout(`unfetchable`, headSha)
    git(dir, `remote`, `set-url`, `origin`, path.join(tmpDir, `missing`))

    await assert.rejects(fetchBaseRev(baseSha, { cwd: dir }), (err: Error) => {
      assert.match(err.message, new RegExp(`failed to fetch the pull request base commit ${baseSha} from origin`))
      assert.doesNotMatch(err.message, /credentials/)
      return true
    })
  })

  it(`does not mistake a sha containing 401 or 403 for an HTTP status`, async () => {
    const dir = checkout(`sha-401`, headSha)
    git(dir, `remote`, `set-url`, `origin`, path.join(tmpDir, `missing`))

    for (const sha of [`401` + `a`.repeat(37), `a`.repeat(37) + `403`]) {
      await assert.rejects(fetchBaseRev(sha, { cwd: dir }), (err: Error) => {
        assert.match(err.message, new RegExp(`failed to fetch the pull request base commit ${sha} from origin:`))
        return true
      })
    }
  })

  it(`hints at missing git credentials when the remote asks for authentication`, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": `Basic realm="test"` }).end()
    })
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve))
    const { port } = server.address() as { port: number }

    const dir = checkout(`auth`, headSha)
    git(dir, `remote`, `set-url`, `origin`, `http://127.0.0.1:${port}/repo.git`)

    const previousPrompt = process.env.GIT_TERMINAL_PROMPT
    process.env.GIT_TERMINAL_PROMPT = `0`

    try {
      await assert.rejects(fetchBaseRev(baseSha, { cwd: dir }), /from origin \(git credentials may be missing/)
    } finally {
      if (previousPrompt === undefined) {
        delete process.env.GIT_TERMINAL_PROMPT
      } else {
        process.env.GIT_TERMINAL_PROMPT = previousPrompt
      }

      server.close()
    }
  })

  it(`adds the hint given for the failed fetch`, async () => {
    const dir = checkout(`hint`, headSha)
    git(dir, `remote`, `set-url`, `origin`, path.join(tmpDir, `missing`))

    await assert.rejects(fetchBaseRev(baseSha, { cwd: dir, fetchFailureHint: ` (custom hint)` }), /from origin \(custom hint\):/)
  })

  it(`fails when the checkout is the base commit, not the pull request`, async () => {
    const dir = checkout(`base-checkout`, baseSha)

    await assert.rejects(fetchBaseRev(baseSha, { cwd: dir }), /the checkout is the pull request base commit .*, not the pull request/)
  })

  it(`fails when the base commit is unknown`, async () => {
    const dir = checkout(`unknown`, headSha)

    await assert.rejects(fetchBaseRev(undefined, { cwd: dir }), /base commit is unknown/)
    await assert.rejects(fetchBaseRev(`--upload-pack=x`, { cwd: dir }), /base commit is unknown/)
  })
})

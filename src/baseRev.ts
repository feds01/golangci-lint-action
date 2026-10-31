import { execFile } from "child_process"
import { promisify } from "util"

const execFileCommand = promisify(execFile)

const CREDENTIALS_ERROR = /authenticat|credentials|username|denied|\b40[13]\b/i

const credentialsHint = ` (git credentials may be missing: see persist-credentials of actions/checkout)`

type BaseRevOptions = {
  cwd?: string
  fetchFailureHint?: string
}

async function git(cwd: string | undefined, ...args: string[]): Promise<string> {
  const { stdout } = await execFileCommand(`git`, args, { cwd })
  return stdout.trim()
}

// Fails instead of returning nothing: linting everything would report issues that are not part of the pull request.
export async function fetchBaseRev(baseSha: string | undefined, options: BaseRevOptions = {}): Promise<string> {
  const { cwd } = options

  if (!baseSha || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
    throw new Error(`cannot show only new issues: the pull request base commit is unknown (${baseSha})`)
  }

  try {
    await git(cwd, `cat-file`, `-e`, `${baseSha}^{commit}`)
  } catch {
    try {
      await git(cwd, `fetch`, `--no-tags`, `--depth=1`, `origin`, baseSha)
    } catch (err) {
      // err.message embeds the git command line, which contains the commit sha: match git's own output only.
      const hint = options.fetchFailureHint ?? (CREDENTIALS_ERROR.test(err.stderr ?? ``) ? credentialsHint : ``)

      throw new Error(
        `cannot show only new issues: failed to fetch the pull request base commit ${baseSha} from origin${hint}: ${err.message}`
      )
    }
  }

  // Diffing the base commit against itself is empty, which would hide every issue.
  if ((await git(cwd, `rev-parse`, `HEAD`)) === baseSha) {
    throw new Error(`cannot show only new issues: the checkout is the pull request base commit ${baseSha}, not the pull request`)
  }

  return baseSha
}

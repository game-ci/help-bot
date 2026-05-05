import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { REPO_ROOT } from '../utils/paths'
import { ensureDir } from '../utils/fs'

export async function commitAndPushContent(
  draftFilePath: string,
  platform: string,
  topic: string,
): Promise<{ committedFile: string; commitSha: string }> {
  // Read draft
  const absoluteDraft = draftFilePath.startsWith('data/')
    ? join(REPO_ROOT, draftFilePath)
    : draftFilePath
  const content = await readFile(absoluteDraft, 'utf-8')

  // Generate filename from topic
  const dateStr = new Date().toISOString().split('T')[0]
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50)
  const filename = `${dateStr}-${slug}.md`
  const relPath = `content/${platform}/${filename}`
  const absPath = join(REPO_ROOT, relPath)

  // Write final file with updated status
  await ensureDir(dirname(absPath))
  const committedAt = new Date().toISOString()
  const finalContent = content
    .replace(/^status:\s*\w+/m, 'status: committed')
    .replace(/^(---\n[\s\S]*?)\n---/, `$1\ncommitted_at: "${committedAt}"\n---`)
  await writeFile(absPath, finalContent, 'utf-8')

  // git add
  const addProc = spawn('git', ['add', relPath], { cwd: REPO_ROOT, stdio: 'inherit' })
  const [addCode] = await once(addProc, 'exit')
  if (addCode !== 0) throw new Error(`git add failed with code ${addCode}`)

  // git commit
  const commitMsg = `content(${platform}): ${topic.substring(0, 60)}`
  const commitProc = spawn('git', ['commit', '-m', commitMsg], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let commitOutput = ''
  commitProc.stdout.on('data', (d: Buffer) => {
    commitOutput += d.toString()
  })
  commitProc.stdin.end()
  const [commitCode] = await once(commitProc, 'exit')
  if (commitCode !== 0) throw new Error(`git commit failed with code ${commitCode}`)

  // Extract commit SHA
  const shaMatch = commitOutput.match(/\[[\w/]+ ([a-f0-9]+)\]/)
  const commitSha = shaMatch?.[1] ?? 'unknown'

  // git pull --rebase then push (handle concurrent pushes)
  const pullProc = spawn('git', ['pull', '--rebase', 'origin', 'main'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  await once(pullProc, 'exit')

  const pushProc = spawn('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
  const [pushCode] = await once(pushProc, 'exit')
  if (pushCode !== 0) throw new Error(`git push failed with code ${pushCode}`)

  return { committedFile: relPath, commitSha }
}

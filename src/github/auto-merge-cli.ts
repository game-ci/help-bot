import { readFileSync } from 'node:fs'
import yargs from 'yargs/yargs'
import { hideBin } from 'yargs/helpers'

/**
 * Auto-merge CLI for help-bot configuration.
 * Processes PRs in help-bot-config repo and handles auto-merging.
 */

const client = new (require('@octokit/rest').GitHub)({
  auth: `Bearer ${process.env.GITHUB_TOKEN}`,
})

yargs(hideBin(process.argv))
  .command(
    'auto-merge <repo>',
    'Auto-merge validated configuration PRs from a config repo',
    (y) =>
      y.option('branch', {
        type: 'string',
        description: 'Branch to merge from (default: main)',
      })
      .option('auto-approve-labels', {
        type: 'array',
        string: true,
        description: 'Labels that auto-approve (e.g. ["config-approved"])',
      }),
    async (args) => {
      const repo = args.repo
      const branch = args['branch'] || 'main'

      if (!repo) {
        throw new Error('Repository is required (owner/repo format, e.g., game-ci/help-bot-config)')
      }

      const [owner, repoName] = repo.split('/')

      console.log(`Processing config PRs in ${owner}/${repoName}:${branch}`)

      // List open PRs for the config repo
      const { data: pullRequests } = await client.pulls.listForRepo({
        owner,
        repo: repoName,
        state: 'open',
        per_page: 100,
      })

      console.log(`Found ${pullRequests.length} open PRs`)

      for (const pr of pullRequests) {
        try {
          // Check if PR contains config changes
          const files = pr.files
          if (!files || files.length === 0) continue

          const configFiles = files.filter((f) => 
            f.filename.toLowerCase().includes('config') &&
            f.status === 'added'
          )

          if (configFiles.length === 0) continue

          console.log(`\nPR #${pr.number}: ${pr.title}`)
          console.log(`  Head branch: ${pr.head.ref}`)
          console.log(`  Labels:`, pr.labels.map((l) => l.name).join(', '))

          // Check for auto-approve labels
          const hasAutoApprove = pr.labels.some((label) => {
            if (!args['auto-approve-labels']) return false
            return args['auto-approve-labels'].some(
              (la: string) => la.toLowerCase() === label.name.toLowerCase()
            )
          })

          if (!hasAutoApprove) {
            console.log('  Status: No auto-approve label')
            continue
          }

          // Fetch config from PR branch to validate
          const { data: content } = await client.repos.getContents({
            owner,
            repo: repoName,
            path: 'config.json',
            ref: pr.head.ref,
          })

          if (!content || !content.type === 'file') {
            console.log('  Status: No config.json found')
            continue
          }

          const decoded = Buffer.from(content.content, 'base64').toString('utf-8')
          try {
            const config = JSON.parse(decoded)

            // Basic validation checks
            const violations: string[] = []

            if (!config.discord?.system_prompt) {
              violations.push('Missing discord.system_prompt')
            }

            if (!config.github?.repos || config.github.repos.length === 0) {
              violations.push('Missing or empty github.repos')
            }

            // Skip sensitive data check in PR review context
            const hasSensitiveData = 
              config.notifications?.discord_dm?.recipients &&
              config.notifications.discord_dm.recipients.length > 0

            if (hasSensitiveData) {
              violations.push('Discord DM recipients in public config')
            }

            if (violations.length === 0) {
              console.log('  Status: VALIDATED ✅')
              
              // Merge the PR
              await client.pulls.merge({
                owner,
                repo: repoName,
                pull_number: pr.number,
                merge_method: 'merge',
              })

              console.log(`  Merged successfully. New URL: ${pr.html_url}`)
            } else {
              console.log('  Status: INVALID ❌')
              console.log(`    Violations:`, violations.join(', '))
              
              // Mark as needs review
              await client.repos.updateFile({
                owner,
                repo: repoName,
                path: `.github/PR-STATUS-${pr.number}.md`,
                message: `PR #${pr.number} needs review - validation failed`,
                content: Buffer.from(`# Needs Review\n\n**Violations:**\n- ${violations.join('\n- ')}\n`).toString('base64'),
                sha: '', // Creates file if doesn't exist
              })
            }

          } catch (parseError) {
            console.log('  Status: INVALID - Not valid JSON')
          }

        } catch (error: unknown) {
          console.error(`Error processing PR #${pr.number}:`, error)
        }
      }

      console.log('\n✅ Auto-merge complete')
    },
  )
  .command(
    'validate <repo>',
    'Validate configuration in a specific branch',
    (y) =>
      y.option('branch', {
        type: 'string',
        description: 'Branch to validate (default: main)',
      }),
    async (args) => {
      const repo = args.repo
      const branch = args['branch'] || 'main'

      if (!repo) {
        throw new Error('Repository is required')
      }

      const [owner, repoName] = repo.split('/')

      console.log(`Validating config.json in ${owner}/${repoName}:${branch}`)

      try {
        const { data: content } = await client.repos.getContents({
          owner,
          repo: repoName,
          path: 'config.json',
          ref: branch,
        })

        if (!content || !content.type === 'file') {
          throw new Error('No config.json found')
        }

        const decoded = Buffer.from(content.content, 'base64').toString('utf-8')
        const config = JSON.parse(decoded)

        // Validate
        const violations: string[] = []

        if (!config.discord?.system_prompt) {
          violations.push('Missing discord.system_prompt')
        }

        if (!config.github?.repos || config.github.repos.length === 0) {
          violations.push('Missing or empty github.repos')
        }

        const hasSensitiveData = 
          config.notifications?.discord_dm?.recipients &&
          config.notifications.discord_dm.recipients.length > 0

        if (hasSensitiveData) {
          violations.push('Discord DM recipients in public config')
        }

        console.log(`\nValidation result:`, violations.length === 0 ? '✅ VALID' : '❌ INVALID')
        
        if (violations.length > 0) {
          console.log('\nViolations:')
          for (const v of violations) {
            console.log(`  - ${v}`)
          }
        }

      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('Error:', msg)
      }
    },
  )
  .demandCommand(1, 'Specify a command')
  .strict()
  .help()
  .parse()

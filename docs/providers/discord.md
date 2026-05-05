# Discord Provider for GameCI Help Bot

The Discord provider enables the help bot to use OpenClaw Discord agents for answering questions, providing an alternative to direct LLM API calls.

## Overview

Instead of calling Claude, LM Studio, or other LLM providers directly, the Discord provider uses OpenClaw's session system to communicate with a Discord-based agent that can:

- Access the help bot's data files
- Answer questions about GameCI
- Provide consistent responses across multiple queries
- Maintain context within a session

## Configuration

Add the Discord provider configuration to your `config.json`:

```json
{
  "llm": {
    "provider": "discord", // Set this to use Discord as the default provider
    "discord": {
      "enabled": true,
      "session_label": "help-bot-assistant",
      "model": "claude-sonnet-4-20250514",
      "timeout_seconds": 300,
      "workspace_path": null // Uses REPO_ROOT by default
    }
  }
}
```

### Configuration Options

- **enabled**: Whether the Discord provider is available
- **session_label**: Label for the OpenClaw session (default: "help-bot-assistant")
- **model**: Model to use for the Discord agent (optional)
- **timeout_seconds**: Maximum time to wait for a response (default: 300)
- **workspace_path**: Custom workspace path for the agent (optional)

## Prerequisites

1. **OpenClaw must be installed** on the same machine as the help bot
2. The OpenClaw gateway must be running (`openclaw gateway start`)
3. A Discord bot must be configured in OpenClaw

## How It Works

1. When a help request comes in, the help bot prepares a prompt with:
   - System instructions (from CLAUDE.md)
   - Any layered system prompts (base + guild + channel)
   - The user's question
   - Context about available data files

2. The Discord provider:
   - Checks if an OpenClaw session with the configured label exists
   - Creates one if needed with appropriate instructions
   - Sends the prompt via `openclaw sessions send`
   - Waits for and returns the response

3. The Discord agent can:
   - Read files from the help-bot/data directory
   - Access GameCI documentation and codebase
   - Provide detailed answers with code examples
   - Maintain conversation context within the session

## Usage

### Enable Discord Provider Globally

Set Discord as the default provider in `config.json`:

```json
{
  "llm": {
    "provider": "discord"
  }
}
```

### Use Discord Provider for Specific Requests

You can override the provider for specific requests programmatically:

```typescript
await runProvider(prompt, {
  provider: 'discord',
  systemPrompt: 'Additional context...',
  modelOverride: 'claude-opus-4-20250514',
})
```

### Session Management

The Discord provider automatically manages the OpenClaw session:

- Creates a session on first use with the label from config
- Reuses the existing session for subsequent requests
- Maintains context across multiple help requests

To manually manage the session:

```bash
# List sessions
openclaw sessions list

# View session details
openclaw sessions list --json | grep help-bot-assistant

# Send a message manually
openclaw sessions send --label help-bot-assistant --message "Test message"

# End the session
openclaw sessions kill --label help-bot-assistant
```

## Advantages

1. **Context Preservation**: The Discord agent maintains context across requests
2. **Tool Access**: Can use OpenClaw tools (Read, Glob, etc.) to explore files
3. **Flexibility**: Easy to switch models or add custom behaviors
4. **Integration**: Works alongside existing Discord bot features

## Limitations

1. **Local Only**: Both help bot and OpenClaw must be on the same machine
2. **Setup Required**: Requires OpenClaw installation and configuration
3. **Performance**: May have higher latency than direct API calls

## Troubleshooting

### Provider Not Available

If you see "Discord provider is not available", check:

1. Is OpenClaw installed? (`openclaw --version`)
2. Is the gateway running? (`openclaw gateway status`)
3. Is the provider enabled in config? (`"enabled": true`)

### Session Creation Fails

1. Check OpenClaw logs: `openclaw gateway logs`
2. Verify Discord bot is configured in OpenClaw
3. Ensure sufficient permissions for session creation

### Timeouts

If responses timeout:

1. Increase `timeout_seconds` in config
2. Check if the Discord agent is responding
3. Verify network connectivity to Discord

## Example Flow

1. User asks in #help channel: "How do I fix IL2CPP build errors?"

2. Help bot receives the message and prepares prompt:

   ```
   System: You are the GameCI help bot...
   Guild: You are helping users in the GameCI Discord server...
   Channel: Focus on troubleshooting Unity build issues...

   Help Bot Request:
   How do I fix IL2CPP build errors?

   Available data files in help-bot/data:
   - reference/repo/* - GameCI repository structure and code
   - issues/* - GitHub issues data
   - discord/* - Discord messages and threads
   ```

3. Discord provider sends to OpenClaw session

4. Discord agent analyzes the question, reads relevant files, and responds

5. Help bot posts the response back to the channel

## Testing the Provider

To test the Discord provider:

```bash
# 1. Start OpenClaw gateway
openclaw gateway start

# 2. Enable Discord provider in config.json
# Set: "provider": "discord" and "discord": { "enabled": true }

# 3. Run a test cycle
node dist/cli.js cycle --dry-run --dispatch-mode triage

# 4. Check the session
openclaw sessions list
```

## Environment Variables

The Discord provider supports these environment variables:

- `OPENCLAW_MODEL_OVERRIDE`: Override the model for all Discord agent requests
- `OPENCLAW_SESSION_LABEL`: Override the session label (default from config)

## Future Enhancements

- Support for remote OpenClaw instances
- Multiple session management for parallel requests
- Custom agent templates for different types of questions
- Integration with voice channels for audio responses
- Session pooling for high-volume scenarios

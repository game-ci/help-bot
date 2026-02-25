FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    python3-pip \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash botuser

# Set up working directory
WORKDIR /app
COPY . /app

# Ensure scripts are executable
RUN chmod +x automation/*.sh

# Create data directories
RUN mkdir -p data/discord/channels \
    data/github/issues \
    data/github/discussions \
    data/docs \
    data/responses/discord \
    data/responses/github \
    data/logs \
    data/vector-store

# Own everything by botuser
RUN chown -R botuser:botuser /app

USER botuser

# Default: run the continuous loop
# Override with: docker run ... bash automation/run-help-cycle.sh (single cycle)
CMD ["bash", "automation/run-continuous.sh"]

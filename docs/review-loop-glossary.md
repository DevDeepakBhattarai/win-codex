# Review loop glossary

- **Binding ticket:** A random, short-lived value delivered privately to the
  visible MCP Apps component without rendering the ticket itself. It correlates one `openai/session` with one
  browser-reported conversation URL.
- **Sync tool:** `sync_current_thread`, the only tool that mounts the component
  and asks the extension to bind the current conversation.
- **URL lookup tool:** `get_current_thread_url`, a UI-free read of an existing
  session-to-URL binding.
- **Implementation thread:** The ChatGPT conversation that changes and verifies
  code, publishes it, and coordinates review responses.
- **Reviewer thread:** The separate ChatGPT conversation that independently
  inspects one pull request and submits formal GitHub reviews.
- **Review loop:** One implementation conversation and one reviewer conversation
  exchanging versioned wakeup prompts until approval or the configured stop.
- **Wakeup prompt:** A versioned user message sent through an explicitly targeted
  browser tab. It includes the pull request, head SHA, both thread URLs, status,
  and iteration.

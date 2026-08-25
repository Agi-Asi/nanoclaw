## Shared rooms (`create_room`, `add_to_room`, `handoff`)

A room is one Slack group conversation shared by the user and N agents, with a canvas tab carrying the room contract (purpose, members). `mcp__nanoclaw__create_room({ name, purpose, agents, include_me? })` opens one; `mcp__nanoclaw__add_to_room({ room, agent })` grows one; `mcp__nanoclaw__handoff({ to, text, room? })` reliably engages exactly the named sibling agent or agents.

### The team pattern — one room, not N

When the user asks for a TEAM (several agents for one project), never let each `create_agent` open its own room — that yields N separate three-way rooms nobody wants:

1. Create each agent with `room: 'none'` (they still get their operator DM).
2. When all are live, call `create_room` ONCE with all their names and a short public `purpose`.

For a SINGLE new agent, plain `create_agent` (default `room: 'own'`) is right — don't follow up with `create_room`.

### How it works

- `agents` takes the same names you use with `send_message` — agents you created or can already message. Unknown names come back as an error note, nothing half-created.
- Room creation and membership changes are fire-and-forget and may require admin approval; the outcome arrives as a system note. Creating a room never chooses responders or wakes everyone automatically.
- In rooms, agents engage when @-mentioned; everything else accumulates as ambient context. Use `handoff` to bring in exactly the agent(s) whose response the user wants: one name for one responder, an explicit list for several. Omit `room` inside the room; after a `create_room` completion note, pass the room destination it provides. Never place raw Slack mention markup in `text`.

### Growing a room

`add_to_room` works, but Slack group conversations never grow in place — the room MOVES to a new conversation (everyone re-wired automatically; the old conversation keeps working). Prefer creating rooms complete: if you know the team needs four agents, create all four first, then one `create_room`.

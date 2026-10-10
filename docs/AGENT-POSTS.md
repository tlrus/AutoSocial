# Create posts with agents

Open **AI Agents & Skills**, enter a topic and an optional brief, choose the format and platform, and enable the roles you want. Each role has one on/off button. **Create post** starts only the enabled roles, in pipeline order.

Generation uses an installed local Ollama model on `127.0.0.1:11434`. No paid API is configured, no model is downloaded automatically, and the author's profile stays on the computer. Start Ollama if the connection indicator says it is unavailable, then use **Refresh models**.

Answers appear below the form as roles finish. Roles that edit the post share an evolving draft; other roles add separate research, planning, or design outputs. The final draft can be edited, copied, saved, or transferred to the calendar. Transferring a draft opens the scheduling form with its text and platform; add media and choose a time there.

The trend role needs supplied source links and excerpts. It does not browse those links or verify current news. The analytics role needs supplied publication metrics. Missing inputs are shown explicitly. Visual roles return plans and prompts, rather than generated image files.

Use **Stop** to cancel the active role and prevent subsequent roles from starting. One run at a time can use the local model. Completed drafts and partial results are saved in `queue/<account>/agent-drafts/`, which is private runtime data. Reloading the page restores the current account's latest run. If the service restarts during generation, retained partial results are marked interrupted and can be reviewed before a new run.

API routes require the dashboard's existing authentication and request-origin checks:

- `GET /api/agents/status`: local models, role catalog, and the account's latest run.
- `POST /api/agents/runs`: validated topic, brief, format, platform, installed model, and role IDs; returns `202` with a run snapshot.
- `GET /api/agents/runs/:id`: account-scoped progress and results.
- `POST /api/agents/runs/:id/cancel`: abort the account's run.
- `PATCH /api/agents/runs/:id`: save edits to `postText` after generation finishes.

The server treats model output as untrusted data, validates its JSON shape, and renders it as text in the dashboard.

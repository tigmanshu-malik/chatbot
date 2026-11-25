# Publish the frontend and backend

Current deployments:

- Frontend: https://lyftr-chat-web-0szr.onrender.com
- Backend: https://lyftr-chat-api-h1xd.onrender.com
- Health: https://lyftr-chat-api-h1xd.onrender.com/health
- Source: https://github.com/tigmanshu-malik/chatbot

The current services were created individually in Render using the Node web-service and static-site forms. Both use the free plan. API keys were imported only into the private backend environment, while the frontend receives only the public `BACKEND_URL`.

For another deployment:

1. Create or sign into GitHub and Render. Create a repository for this project. A private repository is sufficient for Render; make it public only if you choose to satisfy the assignment's public-repository requirement.
2. Upload the source files from this project. Never upload `.env`, `backend/app.db*`, `tmp`, `dist` or `node_modules`. The prepared source ZIP under `output/deploy` excludes credentials and chat history. Extract it before uploading its contents to GitHub.
3. In Render choose **New > Blueprint**, select that repository, and use the root `render.yaml` file. Review the free plan. Enter your real key pool into the prompted `LLM_API_KEYS` secret field.
4. Render creates `lyftr-chat-api` and `lyftr-chat-web`. Wait until both show Live. `BACKEND_URL` is set to the actual backend address shown in Render. For a fresh deployment in another account, deploy the backend first and update this value to its new public URL before building the frontend. Render does not allow chaining references to another referenced environment variable.
5. Copy the public URL displayed for `lyftr-chat-web` as the frontend link. Copy the public URL displayed for `lyftr-chat-api` as the backend link. Append `/health` to check the API.
6. Set the backend's `ALLOWED_ORIGINS` to the actual frontend origin, then redeploy the backend. Confirm browser chat still works.
7. Test conversation memory, replay an identical conversation in a new chat to check caching, and verify the failure simulation hook. With a second distinct real key, run the failure hook with `key_1=429` and expect `key_id: key_2`.

## Free demo versus persistent storage

The root Blueprint uses free hosting. Render Free loses SQLite files when its service restarts, redeploys or spins down; this does not satisfy the assignment's durable-storage requirement. It also spins down after inactivity and can take time to wake up.

For durable SQLite, `deploy/render-persistent.yaml` uses an explicitly paid backend compute plan and a 1 GB persistent disk. Review the current dashboard price and approve payment before selecting this file. No paid resources have been created.

On the paid configuration the database lives at `/var/data/app.db`. Changing from the free configuration starts with a new disk; it does not automatically migrate the free service's history.

## Verify locally before publishing

```powershell
npm test
$env:BACKEND_URL = 'http://localhost:8000'
npm run build:frontend
```

The generated `dist/frontend/index.html` contains only public UI code and the backend origin. The build does not read `.env` or include provider credentials. Local `npm start` still serves the original same-origin UI at port 8000.

## Assignment status

These files publish the current Node.js and plain-JavaScript preview. React, FastAPI/LiteLLM, a second real key, and other unfinished assignment requirements still need to be completed before calling it a fully compliant submission.

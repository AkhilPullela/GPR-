# Game Performance Reporter

The imported project is a browser-only React application using Vite. Keep its existing structure and stack.

## Running

- Use Replit's **Run** action to start the **Start application** workflow.
- The workflow runs `npm run dev`. Vite listens on `0.0.0.0:5000` and accepts Replit's preview host.
- No API keys, database, or external services are needed.
- Use the dashboard's demo action to explore synthetic data, or import a Chrome Performance JSON trace through **Traces**.

## Checks

- `npm test` runs the existing Node test suite.
- `npm run build` builds the static application into `dist/`.
- `npm ci` restores dependencies from `package-lock.json`.

See `README.md` for trace formats, marker contracts, and reporting limitations.

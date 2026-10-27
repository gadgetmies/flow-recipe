# Flow Recipe

A P2P collaborative cooking app with structured recipe modelling and algorithmic scheduling.

Goals: 
* Enable people to cook together without stress and planning
* Create a format for describing cooking and baking recipes in a structured and accurate manner in order to enable 
    programmatic scheduling and adaptation. 

## Demo

Open `/demo` in the client (for example `http://localhost:3000/demo#buns,tiramisu` with `yarn dev`, or add `?mock=1`
to run without a server) to watch simulated participants cook several recipes at once. Pick the recipes and their
serve times, the number of cooks, the inventory (4 or 2 baking sheets), the cleaning policy and a seed, press
**Plan** to see the draft plan (dish lateness, fairness, diagnostics, lanes), then **Play**, **Step** or **Reset** the
simulation: the scheduler runs in the browser, re-plans live as the simulated cooks run early, late or get
interrupted by timers, and the page shows the lanes with the simulated clock, each participant's current task, the
dish status, metrics and the event log. The same seed gives the same run. The CLI alternative is
`yarn workspace @flow-recipe/scheduler demo --recipes buns,tiramisu --participants 3 --seed 7`.

## GitHub Pages and pull request previews

Two workflows build and publish the static client. Pushes to `master` publish the main site; opening, updating or reopening a PR publishes `/previews/pr-<number>/` beneath it. Closing or merging a PR removes its preview. Production updates preserve other previews. The publish run's summary contains the preview URL.

Enable this once under **Settings → Pages → Build and deployment → Source: GitHub Actions**. Both workflows must first be merged into the default branch: the publisher uses `workflow_run` and runs only trusted default-branch code. Afterwards, run **Build Pages site** manually on `master` for the initial deployment, or push a change. The `github-pages` environment must allow deployments from the default branch. The workflows use `GITHUB_TOKEN`; no personal access token is needed. The `gh-pages` branch stores the combined site between deployments; keep Pages configured for **GitHub Actions**, rather than publishing that branch directly.

Fork PRs build with read-only permissions and no deployment credentials. A separate publisher downloads their static artifact and validates its GitHub PR metadata before adding it to Pages. GitHub may require maintainer approval for a first-time contributor's build. Superseded builds and closed PRs are skipped.

Pages cannot run the Node server. By default, these builds use the app's mock/demo mode. To use a deployed backend instead, set the repository variable `REACT_APP_SERVER_URL` to its public HTTPS URL and rebuild; the backend must permit the Pages origin via CORS. Do not put API keys or other secrets in build variables. You can explicitly select demo mode with `?mock=1` or live mode with `?mock=0`.

Repository subpaths and PR asset paths are configured during each build; `/demo/`, `/import/` and `/graph/` have direct entry points. For a custom domain served at its root, set the repository variable `PAGES_BASE_PATH` to `/` (and configure the domain in Pages settings). Previews share the Pages origin and browser storage with production.

## Importing recipes

Open `/import` (or **Import a recipe from a URL** in the host settings) to turn a recipe page or pasted text into a
flow recipe. An LLM drafts the XML following [`RECIPE.spec.md`](RECIPE.spec.md); a deterministic converter then makes
every amount metric and weight-first using the volume→weight table in `packages/scheduler/src/conversions` (eggs and
other countables stay pieces, small spice amounts stay spoons unless you have a precision scale), and a scheduler dry
run checks that the recipe plans with 1 and 3 cooks before it can be saved. Configure the LLM on the server with
`FLOW_LLM_PROVIDER`, `FLOW_LLM_MODEL`, `FLOW_LLM_API_KEY` and `FLOW_LLM_BASE_URL`, or enter your own key on the import
page (kept in your browser). Endpoints are in [`packages/server/API.md`](packages/server/API.md).

With Claude, use the `flow-recipe-import` skill (`.claude/skills/flow-recipe-import`) and the MCP server in
[`packages/mcp`](packages/mcp/README.md) (registered in `.mcp.json`): Claude writes the XML itself and the tools fetch
the source, convert units, check and upload. Without the MCP server, `node packages/importer/bin/check.js recipe.xml
--convert` does the conversion and check.

---

# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)

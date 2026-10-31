#!/usr/bin/env node
// flow-recipe MCP server over stdio. Usage: node packages/mcp/src/index.js
// Env: FLOW_RECIPE_SERVER (default http://localhost:3001), FLOW_UPLOAD_TOKEN, FLOW_RECIPES_DIR.

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createFlowRecipeServer } from './server.js'

export { createFlowRecipeServer, presentCheck } from './server.js'
export { createHttpBackend } from './backend.js'

export async function main() {
  const server = createFlowRecipeServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdout carries the protocol; log to stderr only.
  console.error('flow-recipe MCP server running on stdio')
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch(error => {
    console.error('flow-recipe MCP server failed to start:', error)
    process.exit(1)
  })
}

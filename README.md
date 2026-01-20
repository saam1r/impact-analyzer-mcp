# Impact Analyzer MCP

A lightweight MCP (Model Context Protocol) server that provides git branch impact analysis for AI assistants like Claude in Cursor.

## What is This?

This MCP server exposes **one simple tool**: `analyze_pr`

It returns:
- 📊 Git diff between branches
- 📁 List of changed files with stats
- 📄 Contents of changed files (up to 10)
- 🧪 Test directory structure
- 📝 Commit messages

**That's it.** Your AI assistant (Claude) does all the analysis and generates insights.

## Why Use This?

Instead of building complex dependency graphs and custom analyzers, this MCP:
- Returns raw git data
- Lets Claude's intelligence analyze the impact
- Works with ANY git repository
- ~200 lines of code vs thousands

## Quick Start

### Prerequisites

- Node.js >= 18
- Git repository
- Cursor IDE or any MCP-compatible client

### Installation

#### Option 1: Clone and Build

```bash
# Clone the repo
git clone https://github.com/sprinto/impact-analyzer-mcp.git
cd impact-analyzer-mcp

# Install dependencies
npm install
# or
pnpm install

# Build
npm run build
```

#### Option 2: Use npx (Coming Soon)

```bash
npx impact-analyzer-mcp
```

### Configuration

#### For Cursor IDE

Add to your `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "impact-analyzer": {
      "command": "node",
      "args": ["/absolute/path/to/impact-analyzer-mcp/dist/index.js"]
    }
  }
}
```

**Important:** Replace `/absolute/path/to/impact-analyzer-mcp` with the actual path where you cloned this repo.

Example:
```json
{
  "mcpServers": {
    "impact-analyzer": {
      "command": "node",
      "args": ["/Users/yourname/projects/impact-analyzer-mcp/dist/index.js"]
    }
  }
}
```

#### For Other MCP Clients

The server uses stdio transport and follows the standard MCP protocol. Configure according to your client's documentation.

### Restart Your Client

Completely quit and restart Cursor (or your MCP client) to load the server.

### Verify It's Working

In Cursor chat, ask:
```
What tools do you have?
```

You should see `analyze_pr` listed.

## Usage

### Basic Analysis

```
Analyze branch feature/new-login against main
```

### Custom Analysis Requests

```
Analyze branch feature/payment-integration and give me:
- Feature summary
- Impact by layer (frontend/backend/database)
- Critical test areas
- Confidence score
```

### Compare Different Bases

```
Analyze branch hotfix/bug-123 against production
```

## Example Output

The tool returns structured data like:

```
Branch Analysis: feature/new-feature (base: main)

=== SUMMARY ===
Files Changed: 15
Added: 3 | Modified: 10 | Deleted: 2
Lines: +450 -120

=== CHANGED FILES ===
M    src/server/modules/user/userHandler.js
A    src/server/modules/user/userValidator.js
...

=== COMMIT MESSAGES ===
feat: Add user validation layer
fix: Handle edge case in user creation
...

=== GIT DIFF (first 50KB) ===
diff --git a/src/server/modules/user/userHandler.js ...
...

=== FILE CONTENTS ===
--- src/server/modules/user/userHandler.js ---
export async function createUser(data) {
  ...
}

=== TEST STRUCTURE ===
tests/e2e/specs/ (150 files):
user/userManagement.spec.js
auth/login.spec.js
...
```

Claude then analyzes this raw data and generates insights tailored to your request.

## Architecture

```
┌─────────────────┐
│   Cursor IDE    │
│                 │
│   ┌─────────┐   │
│   │ Claude  │   │ ← Uses your AI plan
│   └────┬────┘   │
└────────┼────────┘
         │ Calls analyze_pr
         ▼
┌─────────────────────────┐
│  MCP Server (this tool) │
│                         │
│  • Run git commands     │
│  • Read file contents   │
│  • Scan directories     │
│  • Return raw data      │
└─────────────────────────┘
         │
         ▼
Claude analyzes and generates:
• Impact assessment
• Test recommendations
• Risk analysis
• Confidence scores
```

## Why No API Key?

**You DON'T need an API key!**

- This MCP server just provides **data** (git diffs, file contents)
- Your AI assistant (Claude in Cursor) uses YOUR existing plan
- The server doesn't call any AI APIs
- It's just a data provider

You only need API keys when the MCP server itself needs to call AI services. This one doesn't.

## Technical Details

### Tool Schema

```typescript
{
  name: 'analyze_pr',
  inputSchema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
        description: 'Branch name to analyze (e.g., "feature/new-feature")'
      },
      base: {
        type: 'string',
        description: 'Base branch to compare against (default: "main")'
      }
    },
    required: ['branch']
  }
}
```

### Limitations

- Diff output limited to first 50KB (to avoid token limits)
- File contents limited to first 10KB per file
- Returns up to 10 changed files
- Test directory listing shows first 20 files per directory

### Transport

This server uses **stdio transport**, which means:
- ✅ No port conflicts
- ✅ Cursor manages the lifecycle
- ✅ No "server already running" issues
- ✅ More secure (no network exposure)

Unlike HTTP-based MCP servers, you don't need to run `npm start` manually - Cursor launches it automatically when needed.

## Development

### Build

```bash
npm run build
```

### Test Locally

```bash
npm run dev
```

This will start the server and you can test it with MCP client tools.

### Project Structure

```
impact-analyzer-mcp/
├── src/
│   └── index.ts          # Main server code
├── dist/                 # Built output (generated)
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

## Troubleshooting

### "Tool not found"

- Check that `~/.cursor/mcp.json` has the correct **absolute path**
- Restart Cursor completely
- Verify the build succeeded: `ls dist/index.js`

### "Cannot find module"

```bash
npm install
npm run build
```

Then restart Cursor.

### "Error analyzing PR"

- Make sure you're in a git repository
- Check that the branch name is correct
- Try: `git fetch` to ensure the branch exists locally

### "Schema is missing a method literal"

This error was fixed in version 1.0.0. Make sure you:
1. Pulled the latest code
2. Ran `npm install && npm run build`
3. Restarted Cursor

## Contributing

Contributions welcome! Please:
1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a PR

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Related

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Anthropic MCP SDK](https://github.com/anthropics/mcp)
- [Cursor IDE](https://cursor.sh/)

## Support

- 🐛 [Report bugs](https://github.com/sprinto/impact-analyzer-mcp/issues)
- 💡 [Request features](https://github.com/sprinto/impact-analyzer-mcp/issues)
- 📖 [Read the docs](https://modelcontextprotocol.io/)

---

**Made with ❤️ by the Sprinto team**

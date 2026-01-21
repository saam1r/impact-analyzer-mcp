# Impact Analyzer MCP

A lightweight MCP (Model Context Protocol) server that provides git branch impact analysis for AI assistants like Claude in Cursor.

## What is This?

This MCP server exposes **three powerful tools** for analyzing branch changes:

### 1. `analyze_pr` - Basic Branch Analysis
Returns:
- 📊 Git diff between branches
- 📁 List of changed files with stats
- 📄 Contents of changed files (up to 10)
- 🧪 Test directory structure
- 📝 Commit messages
- ✅ **Developer Action Items** - Auto-generated checklist for PR descriptions
- 🎯 **Context-aware Testing & Verification Steps**

### 2. `analyze_indirect_dependencies` - Indirect Impact Analysis
Finds files affected indirectly by changes:
- 🔗 Direct dependencies (files that import changed files)
- 🔗 Indirect dependencies (transitive dependencies)
- 📊 Complete impact graph
- 📈 Total affected files count

### 3. `analyze_test_coverage` - Test Coverage Analysis
Analyzes test coverage for changes:
- ✅ Related test files found
- 📊 Coverage percentage
- ⚠️ Files without tests
- 🎯 Test confidence levels (high/medium/low)

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

# Buildgit remote add origin https://github.com/saam1r/impact-analyzer-mcp.git
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
      "args": ["/absolute/path/to/impact-analyzer-mcp/dist/index.js"],
      "env": {
        "DEFAULT_BASE_BRANCH": "${DEFAULT_BASE_BRANCH}",
        "MAX_FILE_SIZE": "${MAX_FILE_SIZE}",
        "MAX_DIFF_SIZE": "${MAX_DIFF_SIZE}",
        "MAX_FILES_TO_READ": "${MAX_FILES_TO_READ}",
        "MAX_COMMITS": "${MAX_COMMITS}",
        "TEST_DIRECTORIES": "${TEST_DIRECTORIES}",
        "MAX_DEPENDENCY_DEPTH": "${MAX_DEPENDENCY_DEPTH}"
      }
    }
  }
}
```

**Important:** 
- Replace `/absolute/path/to/impact-analyzer-mcp` with the actual path where you cloned this repo.
- Environment variables are optional. If not set, defaults will be used.
- You can set these in your shell profile (`~/.zshrc`, `~/.bashrc`) or use direct values.

Example with direct values:
```json
{
  "mcpServers": {
    "impact-analyzer": {
      "command": "node",
      "args": ["/Users/yourname/projects/impact-analyzer-mcp/dist/index.js"],
      "env": {
        "DEFAULT_BASE_BRANCH": "main",
        "MAX_FILE_SIZE": "10000",
        "TEST_DIRECTORIES": "tests/e2e/specs,tests/unit/backend"
      }
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

You should see three tools listed:
- `analyze_pr`
- `analyze_indirect_dependencies`
- `analyze_test_coverage`

## Usage

### Basic Analysis

```
Analyze branch feature/new-login against main
```

### Generate PR Description with Action Items

The `analyze_pr` tool now automatically generates:
1. **PR Description Checklist** - Ready to copy into your PR description
2. **Detailed Action Items** - Categorized by priority and area

**Example prompt:**
```
Analyze branch feature/access-dropdown and give me:
1. A comprehensive impact analysis
2. Developer action items for the PR description
3. Testing recommendations
```

**What you get:**
- ✅ Auto-generated checklist formatted for GitHub/GitLab PR descriptions
- 🎯 Context-aware action items based on file types changed:
  - UI/UX verification steps for frontend changes
  - Backend/API testing for service changes
  - Database migration checks for schema changes
  - Security review for auth/permission changes
- 📊 Priority levels (High/Medium/Low) to focus your effort
- 📝 Sign-off template for final verification

**The checklist adapts to your changes:**
- Changed UI components? → Get browser testing, accessibility, and responsive design checks
- Modified APIs? → Get endpoint testing, error handling, and authorization checks
- Updated database? → Get migration testing and data integrity checks
- Large refactor? → Get performance and security review items

### Indirect Dependency Analysis

```
Analyze indirect dependencies for branch feature/new-login
```

This finds all files that import or depend on the changed files, including transitive dependencies.

### Test Coverage Analysis

```
Analyze test coverage for branch feature/new-login
```

This finds related test files, calculates coverage percentage, and identifies files without tests.

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

### Combined Analysis

```
1. Analyze branch feature/new-auth
2. Analyze indirect dependencies for branch feature/new-auth
3. Analyze test coverage for branch feature/new-auth
```

This gives you a complete picture of the change impact.

## Example Output

### `analyze_pr` Output

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

=== DEVELOPER ACTION ITEMS ===

PR DESCRIPTION CHECKLIST (Copy this to your PR):

## Developer Checklist

**Before requesting review:**
[ ] Added/updated tests for changed functionality
[ ] All existing tests pass locally
[ ] Removed debug code and console logs
[ ] Code follows project conventions
[ ] No sensitive data in code
[ ] Updated relevant documentation
[ ] Rebased with latest base branch
[ ] CI/CD pipeline passing
[ ] All review comments addressed

**Testing Completed:**
- [ ] Manual testing completed
- [ ] Edge cases tested
- [ ] Error scenarios tested
- [ ] Tested with different user roles/permissions

**Code Quality:**
- [ ] No linter errors or warnings
- [ ] Code is self-documenting or well-commented
- [ ] Follows DRY (Don't Repeat Yourself) principle

**Sign-off:**
- [ ] I have tested these changes thoroughly
- [ ] I have reviewed my own code
- [ ] I am confident this is ready for production

---
**Additional Context:**
<!-- Add any additional notes, screenshots, or context for reviewers -->

DETAILED ACTION ITEMS BY CATEGORY:

TESTING & QUALITY ASSURANCE [Priority: HIGH]
  1. Add tests for 2 file(s) without test coverage
  2. Run all related tests locally and verify they pass
  3. Check for any flaky tests and fix them

UI/UX VERIFICATION [Priority: HIGH]
  1. Test UI changes across different browsers (Chrome, Firefox, Safari)
  2. Verify responsive design on mobile, tablet, and desktop viewports
  3. Check for visual regressions - compare screenshots before/after
  4. Verify accessibility (keyboard navigation, screen reader compatibility)
  5. Test with different user roles and permissions
  6. Check loading states and error handling in the UI

CODE REVIEW PREPARATION [Priority: MEDIUM]
  1. Remove any console.logs, debugger statements, or commented code
  2. Ensure code follows project coding standards and conventions
  3. Add inline comments for complex logic
  4. Update relevant documentation (README, API docs, etc.)
  5. Check for any hardcoded values that should be environment variables
  6. Verify no sensitive data (API keys, passwords) is committed

INTEGRATION TESTING [Priority: MEDIUM]
  1. Test the complete user flow end-to-end
  2. Verify integration with dependent services/systems
  3. Test with realistic data volumes
  4. Check for race conditions or timing issues
  5. Verify error messages are user-friendly

PRE-MERGE CHECKLIST [Priority: HIGH]
  1. Rebase/merge latest changes from base branch
  2. Resolve any merge conflicts
  3. Verify CI/CD pipeline passes
  4. Get required approvals from code reviewers
  5. Address all review comments
  6. Squash commits if needed (follow team conventions)

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

### `analyze_indirect_dependencies` Output

```
Indirect Dependency Analysis: feature/new-feature (base: main)

=== SUMMARY ===
Directly Changed Files: 5
Directly Affected Files: 12
Indirectly Affected Files: 8
Total Affected Files: 25

=== DIRECT DEPENDENCIES ===
src/server/modules/user/userHandler.js:
  → src/server/routes/userRoutes.js
  → src/server/middleware/auth.js

=== INDIRECT DEPENDENCIES ===
src/server/routes/userRoutes.js:
  → src/server/app.js
  → src/server/config/routes.js

=== ALL AFFECTED FILES ===
src/server/modules/user/userHandler.js
src/server/routes/userRoutes.js
...
```

### `analyze_test_coverage` Output

```
Test Coverage Analysis: feature/new-feature (base: main)

=== SUMMARY ===
Files Changed: 5
Tests Found: 3
Coverage: 60%
Files Without Tests: 2

=== RELATED TESTS ===
tests/unit/user/userHandler.test.js (high confidence)
  Related to: src/server/modules/user/userHandler.js

tests/e2e/user/userManagement.spec.js (medium confidence)
  Related to: src/server/modules/user/userHandler.js, src/server/routes/userRoutes.js

=== MISSING TESTS ===
Files changed but no related tests found:
  - src/server/modules/user/userValidator.js
  - src/server/utils/validation.js
```

Claude then analyzes this raw data and generates insights tailored to your request.

## Key Features

### 🎯 Smart Developer Action Items

The tool automatically generates context-aware action items based on what you changed:

| Change Type | Auto-Generated Items |
|-------------|---------------------|
| **UI Components** | Browser testing, responsive design, accessibility checks, visual regression testing |
| **Backend/APIs** | Endpoint testing, error handling, authorization checks, logging verification |
| **Database** | Migration testing (up/down), data integrity, indexing, rollback scenarios |
| **Configuration** | Env var documentation, dependency security, version conflicts |
| **Large Changes** | Performance profiling, security review, memory leak checks |

### ✅ Ready-to-Use PR Checklist

Copy the generated checklist directly into your PR description:

```markdown
## Developer Checklist

**Before requesting review:**
- [ ] Added/updated tests for changed functionality
- [ ] All existing tests pass locally
- [ ] Tested UI changes in multiple browsers
- [ ] Code follows project conventions
...
```

### 📊 Priority-Based Organization

Action items are organized by priority:
- 🔴 **High Priority**: Critical items that must be done (testing, security, pre-merge)
- 🟡 **Medium Priority**: Important but not blocking (docs, performance, integration)
- 🟢 **Low Priority**: Nice-to-have improvements (documentation, refactoring)

### 🔄 Complete Developer Workflow

1. **Develop** → Make your changes
2. **Analyze** → Run `analyze_pr` to get your checklist
3. **Verify** → Follow the action items step by step
4. **Document** → Copy checklist to PR description
5. **Sign-off** → Mark items complete, add final verification
6. **Review** → Reviewers see what you tested
7. **Merge** → Ship with confidence

## Architecture

```
┌─────────────────┐
│   Cursor IDE    │
│                 │
│   ┌─────────┐   │
│   │ Claude  │   │ ← Uses your AI plan
│   └────┬────┘   │
└────────┼────────┘
         │ Calls analyze_pr / analyze_indirect_dependencies / analyze_test_coverage
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

## Environment Variables

You can configure the MCP server using environment variables. Set them in your `mcp.json` or shell profile:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_BASE_BRANCH` | `main` | Default base branch for comparisons |
| `MAX_FILE_SIZE` | `10000` | Maximum bytes to read per file |
| `MAX_DIFF_SIZE` | `50000` | Maximum bytes of diff to return |
| `MAX_FILES_TO_READ` | `10` | Maximum number of files to read contents |
| `MAX_COMMITS` | `10` | Maximum number of commits to include |
| `TEST_DIRECTORIES` | `tests/e2e/specs,...` | Comma-separated list of test directories |
| `MAX_DEPENDENCY_DEPTH` | `2` | Maximum depth for indirect dependency analysis |

Example in `mcp.json`:
```json
{
  "mcpServers": {
    "impact-analyzer": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "DEFAULT_BASE_BRANCH": "main",
        "MAX_FILE_SIZE": "15000",
        "TEST_DIRECTORIES": "tests/e2e,tests/unit,tests/integration"
      }
    }
  }
}
```

## Technical Details

### Tool Schemas

#### `analyze_pr`
```typescript
{
  name: 'analyze_pr',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name to analyze' },
      base: { type: 'string', description: 'Base branch (default: main)' }
    },
    required: ['branch']
  }
}
```

#### `analyze_indirect_dependencies`
```typescript
{
  name: 'analyze_indirect_dependencies',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name to analyze' },
      base: { type: 'string', description: 'Base branch (default: main)' }
    },
    required: ['branch']
  }
}
```

#### `analyze_test_coverage`
```typescript
{
  name: 'analyze_test_coverage',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name to analyze' },
      base: { type: 'string', description: 'Base branch (default: main)' }
    },
    required: ['branch']
  }
}
```

### Limitations

- Diff output limited to first 50KB (configurable via `MAX_DIFF_SIZE`)
- File contents limited to first 10KB per file (configurable via `MAX_FILE_SIZE`)
- Returns up to 10 changed files (configurable via `MAX_FILES_TO_READ`)
- Test directory listing shows first 20 files per directory
- Dependency analysis supports up to 2 levels deep (configurable via `MAX_DEPENDENCY_DEPTH`)

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

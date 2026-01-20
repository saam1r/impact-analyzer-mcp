# Testing Guide

This guide helps you test the Impact Analyzer MCP server with your team.

## Prerequisites

- Git repository with at least one branch
- Node.js >= 18
- Cursor IDE (or another MCP-compatible client)

## Setup for Testers

### Step 1: Clone the Repository

```bash
git clone https://github.com/sprinto/impact-analyzer-mcp.git
cd impact-analyzer-mcp
```

### Step 2: Install and Build

```bash
# Using npm
npm install
npm run build

# Or using pnpm
pnpm install
pnpm build
```

Verify the build succeeded:
```bash
ls -la dist/index.js
```

You should see the `dist/index.js` file.

### Step 3: Get Absolute Path

Get the full path to your installation:

```bash
pwd
```

Example output: `/Users/yourname/projects/impact-analyzer-mcp`

You'll need this full path + `/dist/index.js` for the next step.

### Step 4: Configure Cursor

Create or edit `~/.cursor/mcp.json`:

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

**Replace** `/Users/yourname/projects/impact-analyzer-mcp` with YOUR actual path from step 3.

### Step 5: Restart Cursor

**Important:** Completely quit Cursor (Cmd+Q on Mac, Alt+F4 on Windows) and restart it.

Don't just close the window - fully quit the application.

## Verification Tests

### Test 1: Check Tool Registration

Open Cursor and start a new chat. Ask:

```
What tools do you have access to?
```

**Expected:** You should see `analyze_pr` listed among the tools.

If not, check:
- The path in `~/.cursor/mcp.json` is correct
- You ran `npm run build`
- You completely restarted Cursor

### Test 2: Basic Branch Analysis

In your git repository, ask:

```
Analyze branch main against main
```

**Expected:** Should return a response showing 0 changes (since comparing a branch to itself).

### Test 3: Real Branch Comparison

If you have a feature branch (e.g., `feature/new-login`), ask:

```
Analyze branch feature/new-login against main
```

**Expected:** Should return:
- Summary of changed files
- Git diff
- File contents
- Test directory structure

### Test 4: Custom Analysis

Try a more complex request:

```
Analyze branch feature/new-login and tell me:
1. What's the main feature being added?
2. Which parts of the codebase are affected?
3. What tests should I run?
4. What's the risk level of this change?
```

**Expected:** Claude should analyze the git data and provide thoughtful answers to each question.

## Common Test Scenarios

### Scenario 1: New Feature Branch

```
Analyze branch feature/user-authentication and give me:
- Feature summary
- Files changed by category (frontend/backend/tests)
- Critical areas to test
- Confidence score (1-10)
```

### Scenario 2: Bug Fix Branch

```
Analyze branch fix/login-timeout and tell me:
- What bug is being fixed?
- What files were modified?
- Are there any tests covering this?
- What are potential side effects?
```

### Scenario 3: Refactoring Branch

```
Analyze branch refactor/database-layer and assess:
- Scope of refactoring
- Risk level
- Test coverage
- Recommended review approach
```

### Scenario 4: Different Base Branch

```
Analyze branch hotfix/security-patch against production
```

This compares against a different base branch (useful for hotfixes).

## Testing Checklist

Use this checklist when testing with your team:

- [ ] Clone repository successfully
- [ ] Build completes without errors
- [ ] `dist/index.js` file exists
- [ ] `mcp.json` configured with correct absolute path
- [ ] Cursor fully restarted
- [ ] `analyze_pr` tool appears in tool list
- [ ] Self-comparison works (branch vs itself = 0 changes)
- [ ] Real branch comparison returns data
- [ ] Custom analysis requests work
- [ ] Multiple sequential analyses work
- [ ] Different base branches work

## Troubleshooting for Testers

### Issue: "Tool not found"

**Solution:**
1. Check `~/.cursor/mcp.json` path is absolute and correct
2. Run: `ls /your/path/impact-analyzer-mcp/dist/index.js` to verify file exists
3. Completely quit and restart Cursor (not just close window)

### Issue: "Cannot find module"

**Solution:**
```bash
cd impact-analyzer-mcp
npm install
npm run build
```

Then restart Cursor.

### Issue: "Error analyzing PR"

**Solutions:**
- Make sure you're asking from within a git repository
- Check branch name is correct: `git branch -a | grep branch-name`
- Fetch branches: `git fetch --all`
- Try with a branch you know exists: `git branch` to list local branches

### Issue: "No response from tool"

**Solutions:**
- Check Cursor's developer console: `Help → Toggle Developer Tools`
- Look for MCP-related errors in console
- Verify Node.js version: `node --version` (should be >= 18)

### Issue: Build Errors

**Solution:**
```bash
# Clean and rebuild
rm -rf node_modules dist
npm install
npm run build
```

## Advanced Testing

### Test with Different Repositories

The MCP server works with ANY git repository. Test it with:

1. **Small repos** (few files changed) - test basic functionality
2. **Large repos** (many files changed) - test performance
3. **Monorepos** - test with complex structures
4. **Different languages** - JavaScript, Python, Go, etc.

### Test Edge Cases

```bash
# Non-existent branch
"Analyze branch does-not-exist against main"
# Should return an error

# Very old branch
"Analyze branch created-2-years-ago against main"
# Should handle large diffs

# Branch with no commits
"Analyze branch-with-no-changes against main"
# Should show 0 changes
```

### Performance Testing

For large branches:
```
Analyze branch massive-refactor against main
```

Note: The tool limits:
- Diff to 50KB
- File contents to 10KB per file
- Returns max 10 files

These limits prevent token overflow in Claude.

## Feedback Collection

When testing with your team, collect feedback on:

1. **Setup Experience**
   - Was installation clear?
   - Did configuration work first try?
   - Any confusing steps?

2. **Usage Experience**
   - Are analysis results helpful?
   - Response time acceptable?
   - What analysis types are most useful?

3. **Reliability**
   - Any crashes or errors?
   - Consistent behavior?
   - Edge cases that fail?

4. **Feature Requests**
   - What's missing?
   - What could be better?
   - Integration with other tools?

## Sharing with Your Team

### Quick Start for Team Members

Share this with your team:

```markdown
## Quick Setup (5 minutes)

1. Clone: `git clone https://github.com/sprinto/impact-analyzer-mcp.git`
2. Build: `cd impact-analyzer-mcp && npm install && npm run build`
3. Get path: `pwd` (copy this)
4. Configure: Edit `~/.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "impact-analyzer": {
         "command": "node",
         "args": ["/YOUR/PATH/HERE/impact-analyzer-mcp/dist/index.js"]
       }
     }
   }
   ```
5. Restart Cursor completely
6. Test: Ask "What tools do you have?" in Cursor chat

## Try It

In your git repo: "Analyze branch YOUR-BRANCH against main"
```

## Reporting Issues

If you find bugs or have suggestions:

1. Check existing issues: https://github.com/sprinto/impact-analyzer-mcp/issues
2. Create new issue with:
   - Description of problem
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, Node version, Cursor version)
   - Error messages or logs

## Success Metrics

Your testing is successful when:

- ✅ All team members can install and configure
- ✅ Tool appears consistently in Cursor
- ✅ Branch analyses return useful data
- ✅ Claude generates insightful analysis
- ✅ Performance is acceptable
- ✅ No crashes or major bugs
- ✅ Team finds it valuable

## Next Steps After Testing

1. Gather feedback
2. Report issues/suggestions
3. Share successful use cases
4. Document team-specific workflows
5. Contribute improvements back to repo

Happy testing! 🚀

# Publishing to GitHub

This guide walks you through publishing the Impact Analyzer MCP to GitHub.

## Option 1: Create New Repository on GitHub (Recommended)

### Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Repository name: `impact-analyzer-mcp`
3. Description: `MCP server for analyzing git branch impact - returns git diffs and test structure for AI-powered analysis`
4. Visibility: 
   - **Public** (if you want anyone to use it)
   - **Private** (if only for your team)
5. **Do NOT initialize** with README, .gitignore, or license (we already have these)
6. Click "Create repository"

### Step 2: Push Your Local Repository

GitHub will show you commands. Use these:

```bash
cd ~/impact-analyzer-mcp-standalone

# Add remote (replace YOUR-USERNAME with your GitHub username)
git remote add origin https://github.com/YOUR-USERNAME/impact-analyzer-mcp.git

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: Impact Analyzer MCP v1.0.0"

# Push to GitHub
git push -u origin main
```

If you're using SSH (recommended):
```bash
git remote add origin git@github.com:YOUR-USERNAME/impact-analyzer-mcp.git
git push -u origin main
```

### Step 3: Verify

Visit `https://github.com/YOUR-USERNAME/impact-analyzer-mcp` and verify:
- All files are there
- README.md displays properly
- LICENSE is visible

## Option 2: Push to Sprinto Organization

If you want this under the Sprinto organization:

### Step 1: Create Repo in Organization

1. Go to https://github.com/organizations/sprinto/repositories/new
2. Repository name: `impact-analyzer-mcp`
3. Description: `MCP server for analyzing git branch impact`
4. Visibility: Choose based on your needs
5. Do NOT initialize
6. Click "Create repository"

### Step 2: Push

```bash
cd ~/impact-analyzer-mcp-standalone

git remote add origin git@github.com:sprinto/impact-analyzer-mcp.git
git add .
git commit -m "Initial commit: Impact Analyzer MCP v1.0.0"
git push -u origin main
```

## After Publishing

### Update Package.json URLs

Once published, update your local `package.json` with the correct GitHub URL:

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR-USERNAME/impact-analyzer-mcp.git"
  },
  "bugs": {
    "url": "https://github.com/YOUR-USERNAME/impact-analyzer-mcp/issues"
  },
  "homepage": "https://github.com/YOUR-USERNAME/impact-analyzer-mcp#readme"
}
```

Then:
```bash
git add package.json
git commit -m "Update repository URLs"
git push
```

### Create Release (Optional)

Tag your first release:

```bash
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0
```

Then on GitHub:
1. Go to your repo → Releases
2. Click "Draft a new release"
3. Choose tag: v1.0.0
4. Title: `v1.0.0 - Initial Release`
5. Description:
   ```markdown
   Initial release of Impact Analyzer MCP
   
   Features:
   - Git branch comparison
   - Changed files analysis
   - Test directory scanning
   - Commit message extraction
   
   Usage: See README.md for setup instructions
   ```
6. Click "Publish release"

### Add Topics (GitHub Tags)

On your GitHub repo page:
1. Click the ⚙️ icon next to "About"
2. Add topics:
   - `mcp`
   - `model-context-protocol`
   - `cursor`
   - `claude`
   - `git`
   - `code-analysis`
   - `impact-analysis`
3. Save

## Sharing with Your Team

### For Public Repos

Share this URL with your team:
```
https://github.com/YOUR-USERNAME/impact-analyzer-mcp
```

They can clone and use:
```bash
git clone https://github.com/YOUR-USERNAME/impact-analyzer-mcp.git
cd impact-analyzer-mcp
npm install
npm run build
```

### For Private Repos

Team members need:
1. Access to the repository (add them as collaborators)
2. GitHub authentication set up (SSH key or token)

Then same clone process.

### Quick Clone Command

Put this in your team docs:
```bash
# Clone and setup
git clone https://github.com/YOUR-USERNAME/impact-analyzer-mcp.git
cd impact-analyzer-mcp
npm install && npm run build

# Get path for Cursor config
pwd

# Add this path + /dist/index.js to ~/.cursor/mcp.json
```

## CI/CD Setup (Optional)

### GitHub Actions for Automated Builds

Create `.github/workflows/build.yml`:

```yaml
name: Build and Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [18, 20, 22]
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          
      - name: Install dependencies
        run: npm install
        
      - name: Build
        run: npm run build
        
      - name: Check build output
        run: ls -la dist/
```

Commit and push:
```bash
mkdir -p .github/workflows
# Create the file above
git add .github/workflows/build.yml
git commit -m "Add CI workflow"
git push
```

## Publishing to npm (Optional)

If you want people to install via `npm install -g impact-analyzer-mcp`:

### Step 1: Prepare

Make sure you're logged into npm:
```bash
npm login
```

### Step 2: Publish

```bash
npm publish
```

For scoped package (recommended):
```bash
# Update package.json name to "@yourorg/impact-analyzer-mcp"
npm publish --access public
```

### Step 3: Update README

Add installation instructions:
```markdown
## Installation

### Via npm (recommended)
\`\`\`bash
npm install -g impact-analyzer-mcp
\`\`\`

Then configure in ~/.cursor/mcp.json:
\`\`\`json
{
  "mcpServers": {
    "impact-analyzer": {
      "command": "impact-analyzer-mcp"
    }
  }
}
\`\`\`
```

## Maintenance

### Updating the Repo

When you make changes:

```bash
# Make your changes
git add .
git commit -m "Description of changes"
git push

# Tag new version
git tag -a v1.1.0 -m "Version 1.1.0"
git push origin v1.1.0

# Update npm (if published)
npm version patch  # or minor, or major
npm publish
```

### Versioning

Follow semantic versioning:
- `v1.0.0` → `v1.0.1` - Bug fixes (patch)
- `v1.0.0` → `v1.1.0` - New features (minor)
- `v1.0.0` → `v2.0.0` - Breaking changes (major)

## Repository Checklist

Before announcing to your team, verify:

- [ ] All files committed and pushed
- [ ] README.md displays correctly on GitHub
- [ ] LICENSE file present
- [ ] .gitignore working (no node_modules, dist in repo)
- [ ] Installation instructions clear
- [ ] Repository URL updated in package.json
- [ ] Topics/tags added on GitHub
- [ ] (Optional) Release created
- [ ] (Optional) CI workflow working

## Support and Issues

Remind your team:

**To report issues:**
- Go to: https://github.com/YOUR-USERNAME/impact-analyzer-mcp/issues
- Click "New Issue"
- Provide details

**To contribute:**
1. Fork the repository
2. Create a branch: `git checkout -b feature/your-feature`
3. Make changes
4. Push and create Pull Request

## Next Steps

After publishing:

1. **Test from fresh install** - Clone in a different directory and verify setup works
2. **Share with 1-2 team members** - Get early feedback
3. **Document learnings** - Update README/TESTING.md based on feedback
4. **Expand to team** - Share widely once validated
5. **Iterate** - Make improvements based on usage

## Quick Reference

```bash
# Create GitHub repo → Get URL

cd ~/impact-analyzer-mcp-standalone
git remote add origin git@github.com:YOUR-USERNAME/impact-analyzer-mcp.git
git add .
git commit -m "Initial commit: Impact Analyzer MCP v1.0.0"
git push -u origin main

# Tag release
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0

# Share with team
echo "https://github.com/YOUR-USERNAME/impact-analyzer-mcp"
```

Done! 🎉

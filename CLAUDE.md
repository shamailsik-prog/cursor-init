@AGENTS.md

## Superpowers (default) + gstack (on request)

**Default for all AI-assisted work in this repo:** use Superpowers first. Do not require gstack to start work. Do not stop, block, or refuse skills because gstack is missing.

**gstack:** optional. Install and use gstack only when the user (or an explicit task) asks for gstack / its skills (`/qa`, `/ship`, `/review`, `/investigate`, `/browse`, etc.). If asked and gstack is missing, install with:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team
```

Then restart the AI tool and continue. Cursor cloud/IDE agents never need gstack for ordinary repo work.

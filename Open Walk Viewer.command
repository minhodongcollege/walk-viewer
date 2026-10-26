#!/bin/zsh
# Double-click to start the Walk Viewer: it opens http://localhost:5240/ in your browser.
# Keep this window open while you use it; close it to stop. If it's already running, this just opens the page.
cd "${0:A:h}"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
exec node serve.mjs "$@"

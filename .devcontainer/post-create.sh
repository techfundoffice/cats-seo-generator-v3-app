#!/usr/bin/env bash
set -e

echo "=== SEO Generator V3 - Codespace Setup ==="

# Install Node dependencies
echo "Installing npm dependencies..."
npm install

# Install Python dependency for youtube search helper
echo "Installing Python dependencies..."
pip install youtube_search

# Install Doppler CLI (optional — skip if already present)
if ! command -v doppler &>/dev/null; then
  echo "Installing Doppler CLI..."
  curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
    "https://cli.doppler.com/install.sh" | sh 2>/dev/null || \
    echo "Doppler CLI install failed — you can still use .env for secrets"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  Option A (Doppler):"
echo "    doppler login"
echo "    doppler setup"
echo "    npm run dev:doppler"
echo ""
echo "  Option B (.env file):"
echo "    cp .env.example .env"
echo "    # Fill in your API keys"
echo "    npm run dev"
echo ""
echo "The app starts:"
echo "  - Express API  → http://localhost:3000"
echo "  - Vue UI       → http://localhost:5173"

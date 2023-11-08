#!/bin/bash
# File: src/server/start-client.sh

# Get the absolute path to the directory containing this script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Navigate to the project root directory (assuming this script is in src/server)
PROJECT_DIR="$(dirname "$(dirname "$DIR")")"

OS=$(uname)

if [[ "$OS" == "Darwin" ]]; then  # macOS
    osascript -e 'tell application "Terminal"' \
          -e 'activate' \
          -e 'do script "cd '"$PROJECT_DIR"' && node dist/src/server/SocketServerClient.js"' \
          -e 'set number of rows of front window to 80' \
          -e 'set number of columns of front window to 160' \
          -e 'end tell'

elif [[ "$OS" == "Linux" ]]; then  # Linux
    gnome-terminal -- bash -c "cd $PROJECT_DIR && node dist/src/server/SocketServerClient.js; exec bash"
elif [[ "$OS" == "MINGW64_NT-10.0" || "$OS" == "MSYS_NT-10.0" ]]; then  # Windows
    start cmd.exe /K "cd /D $PROJECT_DIR && node dist/src/server/SocketServerClient.js"
else
    echo "Unsupported OS: $OS"
fi

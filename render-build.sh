#!/usr/bin/env bash

npm install

python -m pip install yt-dlp

which python || true
which pip || true
which yt-dlp || true

find / -name yt-dlp 2>/dev/null | head -20

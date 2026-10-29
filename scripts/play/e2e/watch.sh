#!/bin/bash
# wait for a newer site build (index.html mtime), then run a round: watch.sh <lastCommit> <firstSeed>
H=$HOME/.cache/nomads-scratch/e2e3; cd $H; export PATH="$HOME/.bun/bin:$PATH"
last=$1; seed=$2
site0=$(stat -f %m ~/.cache/nomads-play/play/index.html)
for i in $(seq 1 2000); do
  git -C ~/Developer/nomads fetch -q origin 2>/dev/null
  cur=$(git -C ~/Developer/nomads log -1 --format=%h origin/main)
  site=$(stat -f %m ~/.cache/nomads-play/play/index.html)
  if [ "$site" != "$site0" ]; then break; fi
  sleep 60
done
if [ "$site" = "$site0" ]; then echo "no new site build"; exit 0; fi
echo "new commit $cur site $site"; sleep 90
./round.sh $seed:1280x800 $((seed+1)):1920x1080 $((seed+2)):800x1000 $((seed+3)):1280x800
echo "round done at $cur"

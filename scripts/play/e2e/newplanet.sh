#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"; export SITE=http://127.0.0.1:8500; cd $HOME/.cache/nomads-scratch/e2e
Q="hour=13&warm=0" lockf /tmp/nomads-gpu.lock bun look.ts np1 \
 "46.43,45.76,-2;1;3;5" "-10.26,-102.88,-2;1;3;5" "-7.40,-101.05,-1;2;4" "-62.12,-89.88,-2;1;3" "-10.48,90.29,-1;1;3" "-4.67,93.27,-1;1;3;5" "17.35,45,-2;1;3;5" "-36.04,-103.82,-2;1;3;5" "-17.14,49.33,-2;1;3" "34.59,16.37,-2;0;2;3" "-20.56,69.90,-2;1;3" "55.13,31.15,-2;1;3" "53.84,27.26,-2;1;3" "45.4,39.2,-1;1;3" "12.13,90.05,-1;2;4" "7.7,84.6,-1;2;4" 2>&1 | tail -1
echo stills done > logs/np-stills.done
./round.sh 300:1280x800 301:1920x1080 302:800x1000 303:1280x800
ONLY=EQ,PE,CO,CS ZS=-2,1.5,3 lockf /tmp/nomads-gpu.lock bun dragedge2.ts dragedge-np.json 2>&1 | cut -c1-200 > logs/dragedge-np.log
lockf /tmp/nomads-gpu.lock bun burstx2.ts 2>&1 | cut -c1-200 > logs/burst-np.log
lockf /tmp/nomads-gpu.lock bun arrsettle2.ts 2>&1 | cut -c1-300 > logs/arr-np.log
echo all done > logs/np.done

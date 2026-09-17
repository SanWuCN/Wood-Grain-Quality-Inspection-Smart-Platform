#!/bin/bash
# 在小车上执行：拉取 RAO 分支（RViz 常开 + 巡航稳定性修复）、重启控制台、验证画面。
# 用法（在你的 Mac 上）：ssh wheeltec@192.168.31.221 'bash -s' < deploy-rviz-autostart.sh
set -uo pipefail
cd /home/wheeltec/mumai-console || { echo "找不到 /home/wheeltec/mumai-console"; exit 1; }

echo "== 1/4 拉取修复 =="
git fetch origin RAO || { echo "fetch 失败：小车连不上 GitHub 的话，改用 scp 直接拷这三个文件"; exit 1; }
# 只对这次改动的三个文件丢弃本地改动：远端这版就是我们要的，
# 免得车上手工改过的同名文件让合并失败（其余本地改动一律不动）。
git checkout origin/RAO -- backend/media.py backend/app.py backend/config.example.json
if ! git merge --ff-only origin/RAO; then
  # 车上自己提交过东西（--ff-only 回合不了）。旧提交仍留在 reflog 里可找回。
  echo "  ff-only 合不了，改为对齐到 origin/RAO（本地旧提交留在 reflog）"
  git reset --hard origin/RAO
fi
git log --oneline -1

echo "== 2/4 配置自检 =="
python3 -c "import json;c=json.load(open('backend/config.example.json'));print('rviz_auto_start =',c.get('rviz_auto_start'))"
grep -n "rviz_auto_start" backend/app.py

echo "== 3/4 重启控制台 =="
sudo systemctl restart mumai-console
sleep 6
systemctl is-active mumai-console

echo "== 4/4 等 RViz 起来后验证 =="
for i in $(seq 1 20); do
  if curl -s -m 3 http://127.0.0.1:8765/api/state | grep -q '"rviz_active": true'; then
    echo "rviz_active: true（第 ${i} 次探测）"; break
  fi
  sleep 3
done
python3 - <<'PY'
import json,urllib.request
s=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/state',timeout=5))
print('rviz_active =',s.get('rviz_active'),' rviz_state =',s.get('streams',{}).get('rviz_state'),' camera =',s.get('camera',{}).get('state'))
PY
echo "-- 两路 MJPEG 各取 3 秒看有没有出帧 --"
for ch in rviz camera; do
  n=$(curl -s -m 3 -o /dev/null -w '%{size_download}' "http://127.0.0.1:8765/api/streams/$ch.mjpeg")
  echo "$ch: 3 秒收到 $n 字节"
done

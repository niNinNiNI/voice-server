#!/usr/bin/env bash
# ============================================================
# ESP32 火山引擎桥接服务器 - 状态检测脚本
# 用法: bash scripts/status.sh [host:port]
# 默认: localhost:3000
# ============================================================

set -euo pipefail

HOST="${1:-localhost:3000}"
BASE_URL="http://${HOST}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass()  { echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
info()  { echo -e "  ${CYAN}ℹ${NC} $1"; }

# ============================================================
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   ESP32 Volcengine Bridge Server Status  ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo -e "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "  目标: ${BASE_URL}"
echo ""

# ============================================================
# 本机 IP 地址
# ============================================================
echo -e "${BOLD}[网络信息]${NC} 本机 IP 地址"
echo "  ─────────────────────────────────────────"

has_wifi=false
has_eth=false

while IFS= read -r line; do
    ip=$(echo "$line" | awk '{print $2}' | cut -d/ -f1)
    iface=$(echo "$line" | awk '{print $NF}')
    if [[ "$iface" == "lo" ]]; then
        continue
    fi
    if [[ "$iface" == "docker"* ]] || [[ "$iface" == "br-"* ]] || [[ "$iface" == "veth"* ]]; then
        continue
    fi

    state=$(cat "/sys/class/net/$iface/operstate" 2>/dev/null || echo "unknown")

    if [[ "$iface" == *"wl"* ]] || [[ "$iface" == *"wlan"* ]]; then
        has_wifi=true
        icon="📡"
        label="Wi-Fi"
    else
        has_eth=true
        icon="🌐"
        label="有线"
    fi

    if [[ "$state" == "up" ]]; then
        echo -e "  ${icon} ${label} (${iface}): ${GREEN}${ip}${NC}  [${GREEN}已连接${NC}]"
    else
        echo -e "  ${icon} ${label} (${iface}): ${ip}  [${RED}未连接${NC}]"
    fi
done < <(ip -4 addr show 2>/dev/null | grep -E "inet " || true)

# 检查 hostname 方式获取的 IP
hostname_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
if [[ -n "$hostname_ip" ]] && ! ip -4 addr show | grep -qF "$hostname_ip"; then
    :
fi

if ! $has_wifi && ! $has_eth; then
    warn "未检测到活跃的网络接口"
fi

echo ""
echo -e "  ${BOLD}ESP32 连接地址:${NC} ws://<上述IP>:${HOST#*:}"
echo ""

# ============================================================
# 服务器连通性
# ============================================================
echo -e "${BOLD}[服务器状态]${NC} 健康检查 GET /health"
echo "  ─────────────────────────────────────────"

RESPONSE=$(curl -s --connect-timeout 5 "$BASE_URL/health" 2>/dev/null || echo "")

if [[ -z "$RESPONSE" ]]; then
    fail "服务器不可达 — 请先启动服务器: ${BOLD}npm start${NC}"
    echo ""
    exit 1
fi

# 解析 JSON
parse_json() {
    echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || echo "N/A"
}

STATUS=$(parse_json "status")
ESP32=$(parse_json "esp32Connected")
ASR=$(parse_json "asrConnected")
ASR_REC=$(parse_json "asrRecording")
TTS=$(parse_json "ttsConnected")
TTS_SYNTH=$(parse_json "ttsSynthesizing")

# 状态
if [[ "$STATUS" == "ok" ]]; then
    pass "服务状态: ${GREEN}${STATUS}${NC}"
else
    fail "服务状态: ${RED}${STATUS}${NC}"
fi

# ESP32
if [[ "$ESP32" == "True" ]]; then
    pass "ESP32 连接: ${GREEN}已连接${NC}"
else
    info "ESP32 连接: ${YELLOW}未连接${NC}"
fi

# ASR
if [[ "$ASR" == "True" ]]; then
    pass "ASR 云服务: ${GREEN}已连接${NC}"
else
    fail "ASR 云服务: ${RED}未连接${NC}"
fi

if [[ "$ASR_REC" == "True" ]]; then
    info "ASR 录音中: ${CYAN}是${NC}"
else
    info "ASR 录音中: 否"
fi

# TTS
if [[ "$TTS" == "True" ]]; then
    pass "TTS 云服务: ${GREEN}已连接${NC}"
else
    fail "TTS 云服务: ${RED}未连接${NC}"
fi

if [[ "$TTS_SYNTH" == "True" ]]; then
    info "TTS 合成中: ${CYAN}是${NC}"
else
    info "TTS 合成中: 否"
fi

echo ""
echo -e "  ${CYAN}完整响应:${NC} $(echo "$RESPONSE" | python3 -m json.tool 2>/dev/null | tr '\n' ' ' || echo "$RESPONSE")"
echo ""

# ============================================================
# WebSocket 连通性测试
# ============================================================
echo -e "${BOLD}[WebSocket 测试]${NC} ws://${HOST}"
echo "  ─────────────────────────────────────────"

WS_RESULT=$(python3 -c "
import asyncio, json, sys
try:
    import websockets
except ImportError:
    print('SKIP:websockets_not_installed')
    sys.exit(0)

async def test():
    try:
        async with websockets.connect('ws://${HOST}') as ws:
            # 接收初始连接消息
            init_resp = await asyncio.wait_for(ws.recv(), timeout=3)
            init_data = json.loads(init_resp)
            if init_data.get('type') != 'status':
                return 'FAIL: unexpected init message'

            # 发送 ping
            await ws.send(json.dumps({'type': 'ping'}))
            resp = await asyncio.wait_for(ws.recv(), timeout=3)
            data = json.loads(resp)
            if data.get('type') != 'pong':
                return 'FAIL: expected pong'

            print('PASS|' + init_data.get('message', ''))
    except asyncio.TimeoutError:
        return 'FAIL: timeout'
    except Exception as e:
        return f'FAIL: {e}'

result = asyncio.run(test())
print(result)
" 2>/dev/null)

case "$WS_RESULT" in
    PASS*)
        msg="${WS_RESULT#PASS|}"
        pass "WebSocket ping/pong 正常 — ${msg}"
        ;;
    SKIP*)
        warn "WebSocket 测试跳过 (需安装: pip install websockets)"
        ;;
    FAIL*)
        reason="${WS_RESULT#FAIL: }"
        fail "WebSocket 测试失败 — ${reason}"
        ;;
    *)
        warn "WebSocket 测试无法执行"
        ;;
esac

echo ""

# ============================================================
# 汇总
# ============================================================
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"

ALL_GOOD=true

if [[ "$STATUS" != "ok" ]]; then ALL_GOOD=false; fi
if [[ "$ASR" != "True" ]]; then ALL_GOOD=false; fi
if [[ "$TTS" != "True" ]]; then ALL_GOOD=false; fi

if $ALL_GOOD; then
    echo -e "${BOLD}║${NC}  ${GREEN}✓ 服务器运行正常${NC}"
    if [[ "$ESP32" == "True" ]]; then
        echo -e "${BOLD}║${NC}  ${GREEN}✓ ESP32 已连接${NC}"
    else
        echo -e "${BOLD}║${NC}  ${YELLOW}  等待 ESP32 连接...${NC}"
    fi
else
    if [[ "$STATUS" != "ok" ]]; then
        echo -e "${BOLD}║${NC}  ${RED}✗ 服务器状态异常${NC}"
    fi
    if [[ "$ASR" != "True" ]]; then
        echo -e "${BOLD}║${NC}  ${RED}✗ ASR 云服务未连接 — 检查凭证和网络${NC}"
    fi
    if [[ "$TTS" != "True" ]]; then
        echo -e "${BOLD}║${NC}  ${RED}✗ TTS 云服务未连接 — 检查凭证和网络${NC}"
    fi
fi

echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

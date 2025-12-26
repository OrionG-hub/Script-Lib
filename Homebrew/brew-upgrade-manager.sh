#!/usr/bin/env bash
# Homebrew 智能升级脚本（增强版）

# ================== 脚本环境设置 ==================

# set -e：当命令返回非零退出状态（表示失败）时，脚本会立即退出。
# 这有助于防止错误蔓延，确保脚本的稳定性。
set -e
# set -o pipefail：在管道命令（例如 command1 | command2）中，
# 如果管道中的任何一个命令失败，整个管道的退出状态码将是失败命令的退出状态码。
# 这确保了管道中的中间错误也能被捕获并导致脚本退出。
set -o pipefail

# --- 颜色定义 (自动检测终端是否支持) ---
# [ -t 1 ] 检查标准输出（文件描述符 1）是否连接到终端。
# 如果是终端时，启用颜色
if [ -t 1 ]; then
    GREEN='\033[1;32m' # 定义绿色（加粗）ANSI 转义码
    YELLOW='\033[1;33m' # 定义黄色（加粗）ANSI 转义码
    BLUE='\033[1;34m' # 定义蓝色（加粗）ANSI 转义码
    NC='\033[0m' # 定义无颜色（重置）ANSI 转义码
else
    # 否则，定义为空，禁用颜色
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

# --- 终端宽度和打印函数 (简化) ---
# 默认回退宽度
DEFAULT_FALLBACK_WIDTH="130"
TERMINAL_WIDTH_OVERRIDE=""
WIDTH_SOURCE=""

# 解析命令行参数 (仅支持 --width)
while [[ $# -gt 0 ]]; do
    case "$1" in
        --width)
            if [[ -n "$2" && "$2" =~ ^[0-9]+$ ]]; then
                TERMINAL_WIDTH_OVERRIDE="$2"
                shift 2
            else
                echo -e "${YELLOW}Error: '--width' parameter requires a valid numeric value.${NC}"
                exit 1
            fi
            ;;
        --width=*)
            TERMINAL_WIDTH_OVERRIDE="${1#*=}"
            if ! [[ "$TERMINAL_WIDTH_OVERRIDE" =~ ^[0-9]+$ ]]; then
                echo -e "${YELLOW}Error: '--width' parameter requires a valid numeric value.${NC}"
                exit 1
            fi
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# 确定最终的 TERMINAL_WIDTH
if [[ -n "$TERMINAL_WIDTH_OVERRIDE" ]]; then
    TERMINAL_WIDTH="$TERMINAL_WIDTH_OVERRIDE"
    WIDTH_SOURCE="via command-line argument"
elif [[ -n "$HB_TERMINAL_WIDTH" && "$HB_TERMINAL_WIDTH" =~ ^[0-9]+$ ]]; then
    TERMINAL_WIDTH="$HB_TERMINAL_WIDTH"
    WIDTH_SOURCE="via environment variable HB_TERMINAL_WIDTH"
elif command -v stty &>/dev/null && stty size &>/dev/null; then
    TERMINAL_WIDTH=$(stty size 2>/dev/null | awk '{print $2}')
    if [[ -n "$TERMINAL_WIDTH" && "$TERMINAL_WIDTH" -gt 0 ]]; then
        WIDTH_SOURCE="via stty size"
    else
        TERMINAL_WIDTH=$(tput cols 2>/dev/null || echo "$DEFAULT_FALLBACK_WIDTH")
        if (( TERMINAL_WIDTH == DEFAULT_FALLBACK_WIDTH )); then
            WIDTH_SOURCE="via tput cols (fallback to default 130)"
        else
            WIDTH_SOURCE="via tput cols"
        fi
    fi
else
    TERMINAL_WIDTH=$(tput cols 2>/dev/null || echo "$DEFAULT_FALLBACK_WIDTH")
    if (( TERMINAL_WIDTH == DEFAULT_FALLBACK_WIDTH )); then
        WIDTH_SOURCE="via tput cols (fallback to default 130)"
    else
        WIDTH_SOURCE="via tput cols"
    fi
fi

# separator 函数：打印一个与终端宽度等长的分隔线，并在末尾添加一个新行。
separator() { printf '=%.0s' $(seq 1 "$TERMINAL_WIDTH"); printf "\n"; }
# print_header 函数：使用蓝色打印步骤标题，并添加换行。
print_header() { echo -e "${BLUE}$1${NC}"; }


# --- 临时文件与清理 ---
# mktemp 命令：创建唯一的临时文件。这些文件用于存储 Homebrew 命令的输出日志。
TMP_UPGRADE_LOG=$(mktemp) # 存储升级过程原生输出的临时日志文件
TMP_RUN_SCRIPT=$(mktemp) # 存储动态生成的用于 script 命令执行的临时脚本文件
chmod +x "$TMP_RUN_SCRIPT" # 赋予临时脚本执行权限

# cleanup 函数：删除所有创建的临时文件。
cleanup() { rm -f "$TMP_UPGRADE_LOG" "$TMP_RUN_SCRIPT"; }
# trap cleanup EXIT：设置一个陷阱，确保在脚本退出（无论是正常退出还是因错误退出）时，
# 都会调用 cleanup 函数来删除临时文件。这保证了临时文件不会残留在系统中。
trap cleanup EXIT

# ================== 流程开始 ==================
separator # 打印分隔线

print_header "Step 1: Updating Homebrew repositories (brew update -v)"
brew update -v
separator
printf "\n"

separator
print_header "Step 2: Performing health check (brew doctor)"
if ! brew doctor; then
    echo -e "${YELLOW}Warning: 'brew doctor' detected issues. Manual review and resolution are recommended.${NC}"
else
    echo "Homebrew environment is in good health."
fi
separator
printf "\n"

separator
print_header "Step 3: Executing comprehensive upgrades (brew upgrade -g)"
# 确保在执行 script 命令之前，所有父 shell 的颜色都被重置
echo -e "${NC}"

# 将命令写入临时脚本文件
echo '#!/bin/bash' > "$TMP_RUN_SCRIPT"
echo "set -e" >> "$TMP_RUN_SCRIPT" # 确保内部脚本也因错误而退出
echo "export HOMEBREW_COLOR=1" >> "$TMP_RUN_SCRIPT" # 强制内部脚本启用颜色

# --- 单一的 brew upgrade 命令，用于同时处理 Formulae 和 Casks ---
# 直接运行不带包名参数的 'brew upgrade' 命令，让 Homebrew 自身全面检测并处理所有过时包。
# 不再进行任何过滤，输出 Homebrew 的全部原生信息。
echo "brew upgrade -g" >> "$TMP_RUN_SCRIPT"

# 确保 brew 结束后终端颜色恢复
echo "echo -e \"${NC}\"" >> "$TMP_RUN_SCRIPT"
# 使用 script 命令直接执行临时脚本，确保原生输出
script -q "$TMP_UPGRADE_LOG" "$TMP_RUN_SCRIPT"

# --- 检查升级日志文件大小，如果为零则打印提示信息 ---
# 检查 `$TMP_UPGRADE_LOG` 文件大小， `-s` 选项检查文件是否非空。
if [ ! -s "$TMP_UPGRADE_LOG" ]; then
    echo -e "${GREEN}No updates needed. All Homebrew packages are up-to-date.${NC}"
else
    # 如果文件不为空，表示有升级发生，这里我们不需要做额外处理，因为 `script` 命令已经将内容输出到终端了。
    :
fi
separator
printf "\n"

separator
print_header "Step 4: Cleaning up old files and caches (brew cleanup --prune=all)"
brew cleanup --prune=all
separator
printf "\n"

# 打印最终完成信息，使用绿色高亮显示。
echo -e "${GREEN}All operations completed!${NC}"
printf "\n"